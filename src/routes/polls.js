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

// Upload d'une seule image (ajout d'option depuis la page de gestion).
// En cas d'erreur, on revient à la page de gestion avec un message.
function uploadSingle(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'Image trop volumineuse (3 Mo maximum).'
        : 'Échec du téléversement de l’image.';
      return res.redirect(`/polls/${req.params.id}/manage?err=${encodeURIComponent(msg)}`);
    }
    next();
  });
}

// Charge un vote et vérifie que l'utilisateur en est le propriétaire.
// Renvoie le vote, ou null après avoir répondu par une erreur.
async function loadOwnedPoll(req, res) {
  const { rows } = await query('SELECT id, owner_id FROM polls WHERE id = $1', [req.params.id]);
  const poll = rows[0];
  if (!poll) { res.status(404).render('error', { message: 'Vote introuvable.' }); return null; }
  if (poll.owner_id !== req.user.id) { res.status(403).render('error', { message: 'Accès refusé.' }); return null; }
  return poll;
}

// Tableau de bord : liste des votes de l'utilisateur
router.get('/dashboard', requireAuth, async (req, res) => {
  const { rows: polls } = await query(
    `SELECT p.id, p.title, p.status, p.is_private, p.is_nominative, p.close_at, p.created_at,
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
  const isNominative = req.body.is_nominative === 'on';
  const authMode = req.body.auth_mode === 'name' ? 'name' : 'email';
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
      `INSERT INTO polls (owner_id, title, description, is_private, password_hash, close_at, is_nominative, auth_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [req.user.id, title, description, isPrivate, passwordHash, closeAt, isNominative, authMode]
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

  // On évite de charger les blobs image ici (juste un indicateur de présence).
  const { rows: options } = await query(
    `SELECT id, label, description, position, (image_data IS NOT NULL) AS has_image
       FROM options WHERE poll_id = $1 ORDER BY position`, [poll.id]
  );
  const { options: results, ballotCount } = await computeResults(poll.id);
  const { rows: voterStats } = await query(
    `SELECT COUNT(*)::int AS invited,
            COUNT(voted_at)::int AS voted
       FROM poll_voters WHERE poll_id = $1`, [poll.id]
  );

  // Détail nominatif des participants (uniquement pour un scrutin nominatif) :
  // identité en clair + notes de leur bulletin lié. Les votants enregistrés avant
  // le passage en nominatif restent anonymes (email/nom nuls, bulletin non lié).
  let participants = null;
  if (poll.is_nominative) {
    const { rows: voters } = await query(
      `SELECT pv.email, pv.display_name, pv.voted_at, b.id AS ballot_id
         FROM poll_voters pv
         LEFT JOIN ballots b ON b.voter_id = pv.id
        WHERE pv.poll_id = $1
        ORDER BY (pv.voted_at IS NULL), pv.display_name NULLS LAST, pv.email NULLS LAST, pv.created_at`,
      [poll.id]
    );
    const ballotIds = voters.filter((v) => v.ballot_id).map((v) => v.ballot_id);
    const scoresByBallot = {};
    if (ballotIds.length) {
      const { rows: sc } = await query(
        'SELECT ballot_id, option_id, score FROM ballot_scores WHERE ballot_id = ANY($1)',
        [ballotIds]
      );
      for (const r of sc) (scoresByBallot[r.ballot_id] ||= {})[r.option_id] = r.score;
    }
    participants = voters.map((v) => ({
      email: v.email,
      name: v.display_name,
      voted: !!v.voted_at,
      anonymous: !!v.voted_at && !v.ballot_id, // a voté avant le passage en nominatif
      scores: v.ballot_id ? (scoresByBallot[v.ballot_id] || {}) : null,
    }));
  }

  res.render('poll_manage', {
    poll, options, results, ballotCount, participants,
    voterStats: voterStats[0],
    baseUrl: process.env.BASE_URL || '',
    notice: req.query.ok || null,
    error: req.query.err || null,
  });
});

// Résultats JSON pour le rafraîchissement en direct de la page de gestion (propriétaire)
router.get('/polls/:id/results.json', requireAuth, async (req, res) => {
  const poll = await loadOwnedPoll(req, res);
  if (!poll) return;
  const { options, ballotCount } = await computeResults(poll.id);
  res.json({ options, ballotCount });
});

// Basculer le scrutin en nominatif / secret
router.post('/polls/:id/nominative', requireAuth, async (req, res) => {
  const poll = await loadOwnedPoll(req, res);
  if (!poll) return;
  const on = req.body.nominative === 'on';
  await query('UPDATE polls SET is_nominative = $1 WHERE id = $2', [on, poll.id]);
  const msg = on
    ? 'Scrutin passé en nominatif. Les votes déposés à partir de maintenant sont identifiables ; ceux déjà déposés restent anonymes.'
    : 'Scrutin repassé en vote secret. Les identités et votes individuels ne sont plus affichés.';
  res.redirect(`/polls/${poll.id}/manage?ok=${encodeURIComponent(msg)}`);
});

// Édition du titre et de la description (à tout moment)
router.post('/polls/:id/edit', requireAuth, async (req, res) => {
  const poll = await loadOwnedPoll(req, res);
  if (!poll) return;
  const title = String(req.body.title || '').trim();
  const description = String(req.body.description || '').trim();
  if (!title) {
    return res.redirect(`/polls/${poll.id}/manage?err=${encodeURIComponent('Le titre ne peut pas être vide.')}`);
  }
  await query('UPDATE polls SET title = $1, description = $2 WHERE id = $3', [title, description, poll.id]);
  res.redirect(`/polls/${poll.id}/manage?ok=${encodeURIComponent('Titre et description mis à jour.')}`);
});

// Ajout d'une option (intitulé et/ou image)
router.post('/polls/:id/options', requireAuth, uploadSingle, async (req, res) => {
  const poll = await loadOwnedPoll(req, res);
  if (!poll) return;
  const label = String(req.body.label || '').trim();
  const description = String(req.body.description || '').trim();
  const file = req.file || null;
  if (!label && !file) {
    return res.redirect(`/polls/${poll.id}/manage?err=${encodeURIComponent('Une option doit avoir au moins un intitulé ou une image.')}`);
  }
  const { rows: pos } = await query(
    'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM options WHERE poll_id = $1', [poll.id]
  );
  await query(
    `INSERT INTO options (poll_id, label, description, image_data, image_mime, position)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [poll.id, label, description, file ? file.buffer : null, file ? file.mimetype : null, pos[0].next]
  );
  res.redirect(`/polls/${poll.id}/manage?ok=${encodeURIComponent('Option ajoutée.')}`);
});

// Modification du texte d'une option existante (intitulé + description)
router.post('/polls/:id/options/:optId/edit', requireAuth, async (req, res) => {
  const poll = await loadOwnedPoll(req, res);
  if (!poll) return;
  const label = String(req.body.label || '').trim();
  const description = String(req.body.description || '').trim();
  const { rows } = await query(
    'SELECT (image_data IS NOT NULL) AS has_image FROM options WHERE id = $1 AND poll_id = $2',
    [req.params.optId, poll.id]
  );
  if (!rows[0]) return res.status(404).render('error', { message: 'Option introuvable.' });
  if (!label && !rows[0].has_image) {
    return res.redirect(`/polls/${poll.id}/manage?err=${encodeURIComponent('Une option sans image doit conserver un intitulé.')}`);
  }
  await query(
    'UPDATE options SET label = $1, description = $2 WHERE id = $3 AND poll_id = $4',
    [label, description, req.params.optId, poll.id]
  );
  res.redirect(`/polls/${poll.id}/manage?ok=${encodeURIComponent('Option modifiée.')}`);
});

// Suppression d'une option (un vote doit conserver au moins 2 options)
router.post('/polls/:id/options/:optId/delete', requireAuth, async (req, res) => {
  const poll = await loadOwnedPoll(req, res);
  if (!poll) return;
  const { rows: cnt } = await query('SELECT COUNT(*)::int AS n FROM options WHERE poll_id = $1', [poll.id]);
  if (cnt[0].n <= 2) {
    return res.redirect(`/polls/${poll.id}/manage?err=${encodeURIComponent('Un vote doit conserver au moins 2 options.')}`);
  }
  await query('DELETE FROM options WHERE id = $1 AND poll_id = $2', [req.params.optId, poll.id]);
  res.redirect(`/polls/${poll.id}/manage?ok=${encodeURIComponent('Option supprimée.')}`);
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
