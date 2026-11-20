// Pages HTML de l'organisateur. La logique métier est dans services/polls.js,
// partagée avec l'API.
import { Router } from 'express';
import multer from 'multer';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import { requireUuidParam } from '../security.js';
import { parseCloseAt } from '../dates.js';
import { ServiceError } from '../services/errors.js';
import * as polls from '../services/polls.js';
import { pendingCount, subscriberCount, notifySubscribers } from '../services/followups.js';

const router = Router();
router.param('id', requireUuidParam);
router.param('optId', requireUuidParam);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: polls.IMAGE_MAX_BYTES, files: polls.LIMITS.options },
  fileFilter: (req, file, cb) => cb(null, polls.IMAGE_MIME.has(file.mimetype)),
});
const uploadError = (err) => (err.code === 'LIMIT_FILE_SIZE'
  ? 'Image trop volumineuse (3 Mo maximum).'
  : 'Échec du téléversement des images.');

// Exécute multer et capture proprement les erreurs (taille, etc.)
function uploadOptions(req, res, next) {
  upload.any()(req, res, (err) => {
    if (err) return res.status(400).render('poll_new', { error: uploadError(err) });
    next();
  });
}

// Upload d'une seule image (ajout d'option depuis la page de gestion).
function uploadSingle(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (err) return res.redirect(manageUrl(req.params.id, { err: uploadError(err) }));
    next();
  });
}

// Champ de formulaire → entier (le service valide les bornes) ; vide = défaut.
function parseMinBallots(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return undefined;
  return /^\d+$/.test(text) ? Number(text) : NaN;
}

function manageUrl(id, { ok, err } = {}) {
  const qs = ok ? `?ok=${encodeURIComponent(ok)}` : err ? `?err=${encodeURIComponent(err)}` : '';
  return `/polls/${id}/manage${qs}`;
}

// Charge le scrutin de l'utilisateur ; sinon page d'erreur.
async function ownedPoll(req, res) {
  try {
    return await polls.getOwnedPoll(req.user.id, req.params.id);
  } catch (err) {
    if (!(err instanceof ServiceError)) throw err;
    res.status(err.status).render('error', { message: err.message });
    return null;
  }
}

// Exécute une modification depuis la page de gestion : message de succès, ou
// message d'erreur métier, dans la page de gestion.
async function manageAction(req, res, action, okMessage) {
  const poll = await ownedPoll(req, res);
  if (!poll) return;
  try {
    const message = await action(poll);
    res.redirect(manageUrl(poll.id, { ok: message || okMessage }));
  } catch (err) {
    if (!(err instanceof ServiceError)) throw err;
    if (err.status === 404) return res.status(404).render('error', { message: err.message });
    res.redirect(manageUrl(poll.id, { err: err.message }));
  }
}

router.get('/dashboard', requireAuth, async (req, res) => {
  res.render('dashboard', { polls: await polls.listPolls(req.user.id), baseUrl: config.baseUrl });
});

router.get('/polls/new', requireAuth, (req, res) => {
  res.render('poll_new', { error: null });
});

// Création d'un vote (multipart : champs indexés option_label_<i>, option_desc_<i>, fichier option_image_<i>)
router.post('/polls', requireAuth, uploadOptions, async (req, res) => {
  const fileByIdx = {};
  for (const f of req.files || []) {
    const m = f.fieldname.match(/^option_image_(\d+)$/);
    if (m) fileByIdx[Number(m[1])] = f;
  }
  const indices = new Set(Object.keys(fileByIdx).map(Number));
  for (const k of Object.keys(req.body)) {
    const m = k.match(/^option_label_(\d+)$/);
    if (m) indices.add(Number(m[1]));
  }
  const options = [...indices].sort((a, b) => a - b).map((i) => ({
    label: req.body[`option_label_${i}`],
    description: req.body[`option_desc_${i}`],
    image: fileByIdx[i] || null,
  }));

  const closeAt = parseCloseAt(req.body, config.timeZone);
  try {
    if (closeAt === undefined) throw new ServiceError('validation_error', 'Date de clôture invalide.');
    const id = await polls.createPoll(req.user.id, {
      title: req.body.title,
      description: req.body.description,
      isPrivate: req.body.is_private === 'on',
      password: req.body.password,
      isNominative: req.body.is_nominative === 'on',
      authMode: req.body.auth_mode,
      minBallots: parseMinBallots(req.body.min_ballots_for_results),
      closeAt,
      options,
    });
    res.redirect(`/polls/${id}/manage`);
  } catch (err) {
    if (!(err instanceof ServiceError)) throw err;
    res.status(err.status).render('poll_new', { error: err.message });
  }
});

// Sert l'image d'une option (stockée en base). Publique : l'id est un UUID non devinable.
router.get('/options/:id/image', async (req, res) => {
  const { rows } = await query('SELECT image_data, image_mime FROM options WHERE id = $1', [req.params.id]);
  if (!rows[0] || !rows[0].image_data) return res.status(404).end();
  res.set('Content-Type', rows[0].image_mime || 'application/octet-stream');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(rows[0].image_data);
});

router.get('/polls/:id/manage', requireAuth, async (req, res) => {
  const poll = await ownedPoll(req, res);
  if (!poll) return;
  const [options, { options: results, ballotCount, visible, threshold }, stats] = await Promise.all([
    polls.listOptions(poll.id), polls.visibleResults(poll, 'owner'), polls.voterStats(poll.id),
  ]);
  const participants = poll.is_nominative ? await polls.listParticipants(poll) : null;
  const followups = { subscribers: await subscriberCount(poll), pending: await pendingCount(poll) };
  res.render('poll_manage', {
    poll, options, results, ballotCount, participants, resultsVisible: visible, threshold, followups,
    voterStats: { invited: stats.requested, voted: stats.voted },
    baseUrl: config.baseUrl,
    notice: req.query.ok || null,
    error: req.query.err || null,
  });
});

// Résultats JSON pour le rafraîchissement en direct de la page de gestion
router.get('/polls/:id/results.json', requireAuth, async (req, res) => {
  const poll = await ownedPoll(req, res);
  if (!poll) return;
  const { options, ballotCount, visible, threshold } = await polls.visibleResults(poll, 'owner');
  res.json({ options, ballotCount, hidden: !visible, threshold });
});

router.post('/polls/:id/nominative', requireAuth, (req, res) => manageAction(req, res, async (poll) => {
  const on = req.body.nominative === 'on';
  await polls.updatePoll(poll, { isNominative: on });
  return on
    ? 'Scrutin passé en nominatif. Les votes déposés à partir de maintenant sont identifiables ; ceux déjà déposés restent anonymes.'
    : 'Scrutin repassé en vote secret. Les identités et votes individuels ne sont plus affichés.';
}));

router.post('/polls/:id/edit', requireAuth, (req, res) => manageAction(req, res, (poll) => polls.updatePoll(poll, {
  title: req.body.title ?? '', description: req.body.description ?? '',
  minBallots: req.body.min_ballots_for_results === undefined ? undefined : parseMinBallots(req.body.min_ballots_for_results),
}).then(() => null), 'Titre et description mis à jour.'));

router.post('/polls/:id/options', requireAuth, uploadSingle, (req, res) => manageAction(req, res, (poll) => polls.addOption(poll, {
  label: req.body.label, description: req.body.description, image: req.file || null,
}).then(() => null), 'Option ajoutée.'));

router.post('/polls/:id/options/:optId/edit', requireAuth, (req, res) => manageAction(req, res, (poll) => polls.editOption(poll, req.params.optId, {
  label: req.body.label ?? '', description: req.body.description ?? '',
}).then(() => null), 'Option modifiée.'));

router.post('/polls/:id/options/:optId/delete', requireAuth, (req, res) => manageAction(
  req, res, (poll) => polls.deleteOption(poll, req.params.optId).then(() => null), 'Option supprimée.'
));

// Prévenir les votants qui l'ont demandé que de nouveaux choix sont à noter.
// L'organisateur ne voit que des nombres, jamais les adresses.
router.post('/polls/:id/notify', requireAuth, (req, res) => manageAction(req, res, async (poll) => {
  const r = await notifySubscribers(poll, { max: 500 });
  if (r.closed) return 'Le vote est clôturé : aucun avis envoyé.';
  if (!r.eligible) return 'Aucun votant à prévenir : personne n\'a de nouveau choix à noter.';
  return `Avis envoyé à ${r.sent} votant${r.sent > 1 ? 's' : ''}` + (r.failed ? ` (${r.failed} échec${r.failed > 1 ? 's' : ''}).` : '.');
}));

router.post('/polls/:id/status', requireAuth, async (req, res) => {
  const poll = await ownedPoll(req, res);
  if (!poll) return;
  await polls.updatePoll(poll, { status: req.body.status === 'closed' ? 'closed' : 'open' });
  res.redirect(manageUrl(poll.id));
});

router.post('/polls/:id/delete', requireAuth, async (req, res) => {
  const poll = await ownedPoll(req, res);
  if (!poll) return;
  await polls.deletePoll(poll);
  res.redirect('/dashboard');
});

export default router;
