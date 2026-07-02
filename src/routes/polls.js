import { Router } from 'express';
import multer from 'multer';
import { query, tx } from '../db.js';
import { requireAuth, hashPassword } from '../auth.js';
import { computeResults } from '../results.js';

const router = Router();

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024, files: 30 }, // 3 Mo/image
  fileFilter: (req, file, cb) => cb(null, ALLOWED_MIME.has(file.mimetype)),
});
// Exécute multer et capture proprement les erreurs (taille, etc.)
function uploadOptions(req, res, next) {
  upload.any()(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'Image trop volumineuse (3 Mo maximum).'
        : 'Échec du téléversement des images.';
      return res.status(400).render('poll_new', { error: msg });
    }
    next();
  });
}

// Tableau de bord : liste des votes de l'utilisateur
router.get('/dashboard', requireAuth, async (req, res) => {
  const { rows: polls } = await query(
    `SELECT p.id, p.title, p.status, p.is_private, p.close_at, p.created_at,
            (SELECT COUNT(*) FROM ballots b WHERE b.poll_id = p.id)::int AS ballots
       FROM polls p
      WHERE p.owner_id = $1
      ORDER BY p.created_at DESC`,
    [req.user.id]
  );
  res.render('dashboard', { polls, baseUrl: process.env.BASE_URL || '' });
});

// Formulaire de création
router.get('/polls/new', requireAuth, (req, res) => {
  res.render('poll_new', { error: null });
});

// Création d'un vote (multipart : champs indexés option_label_<i>, option_desc_<i>, fichier option_image_<i>)
router.post('/polls', requireAuth, uploadOptions, async (req, res) => {
  const title = String(req.body.title || '').trim();
  const description = String(req.body.description || '').trim();
  const isPrivate = req.body.is_private === 'on';
  const password = String(req.body.password || '');
  const closeAtRaw = String(req.body.close_at || '').trim();

  // Fichiers image par index
  const fileByIdx = {};
  for (const f of req.files || []) {
    const m = f.fieldname.match(/^option_image_(\d+)$/);
    if (m) fileByIdx[Number(m[1])] = f;
  }
  // Indices présents (via labels ou images)
  const indices = new Set();
  for (const k of Object.keys(req.body)) {
    const m = k.match(/^option_label_(\d+)$/);
    if (m) indices.add(Number(m[1]));
  }
  Object.keys(fileByIdx).forEach((i) => indices.add(Number(i)));

  const options = [...indices]
    .sort((a, b) => a - b)
    .map((i) => ({
      label: String(req.body[`option_label_${i}`] || '').trim(),
      description: String(req.body[`option_desc_${i}`] || '').trim(),
      file: fileByIdx[i] || null,
    }))
    .filter((o) => o.label.length > 0 || o.file); // au moins image OU intitulé

  if (!title) return res.status(400).render('poll_new', { error: 'Titre requis.' });
  if (options.length < 2) {
    return res.status(400).render('poll_new', { error: 'Au moins 2 options (image ou intitulé) sont requises.' });
  }
  if (isPrivate && password.length < 4) {
    return res.status(400).render('poll_new', { error: 'Mot de passe d’au moins 4 caractères pour un vote privé.' });
  }

  const closeAt = closeAtRaw ? new Date(closeAtRaw) : null;
  const passwordHash = isPrivate ? await hashPassword(password) : null;

  const pollId = await tx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO polls (owner_id, title, description, is_private, password_hash, close_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.user.id, title, description, isPrivate, passwordHash, closeAt]
    );
    const id = rows[0].id;
    for (let i = 0; i < options.length; i++) {
      const o = options[i];
      await client.query(
        `INSERT INTO options (poll_id, label, description, image_data, image_mime, position)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, o.label, o.description, o.file ? o.file.buffer : null, o.file ? o.file.mimetype : null, i]
      );
    }
    return id;
  });

  res.redirect(`/polls/${pollId}/manage`);
});

// Sert l'image d'une option (stockée en base). Publique : l'id est un UUID non devinable.
router.get('/options/:id/image', async (req, res) => {
  const { rows } = await query('SELECT image_data, image_mime FROM options WHERE id = $1', [req.params.id]);
  if (!rows[0] || !rows[0].image_data) return res.status(404).end();
  res.set('Content-Type', rows[0].image_mime || 'application/octet-stream');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(rows[0].image_data);
});

// Page de gestion (propriétaire uniquement)
router.get('/polls/:id/manage', requireAuth, async (req, res) => {
  const { rows } = await query('SELECT * FROM polls WHERE id = $1', [req.params.id]);
  const poll = rows[0];
  if (!poll) return res.status(404).render('error', { message: 'Vote introuvable.' });
  if (poll.owner_id !== req.user.id) return res.status(403).render('error', { message: 'Accès refusé.' });

  const { rows: options } = await query(
    'SELECT * FROM options WHERE poll_id = $1 ORDER BY position', [poll.id]
  );
  const { options: results, ballotCount } = await computeResults(poll.id);
  const { rows: voterStats } = await query(
    `SELECT COUNT(*)::int AS invited,
            COUNT(voted_at)::int AS voted
       FROM poll_voters WHERE poll_id = $1`, [poll.id]
  );

  res.render('poll_manage', {
    poll, options, results, ballotCount,
    voterStats: voterStats[0],
    baseUrl: process.env.BASE_URL || '',
  });
});

// Clôturer / rouvrir un vote
router.post('/polls/:id/status', requireAuth, async (req, res) => {
  const status = req.body.status === 'closed' ? 'closed' : 'open';
  const { rowCount } = await query(
    'UPDATE polls SET status = $1 WHERE id = $2 AND owner_id = $3',
    [status, req.params.id, req.user.id]
  );
  if (!rowCount) return res.status(403).render('error', { message: 'Accès refusé.' });
  res.redirect(`/polls/${req.params.id}/manage`);
});

// Suppression d'un vote
router.post('/polls/:id/delete', requireAuth, async (req, res) => {
  await query('DELETE FROM polls WHERE id = $1 AND owner_id = $2', [req.params.id, req.user.id]);
  res.redirect('/dashboard');
});

export default router;
