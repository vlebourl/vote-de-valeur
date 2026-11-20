// API REST des organisateurs (/api/v1) : créer et gérer ses scrutins, lire les
// résultats, inviter des votants. Authentification par jeton (en-tête
// « Authorization: Bearer vdv_… »), jamais par le cookie de session : l'API
// n'est donc pas exposée au CSRF.
//
// Le vote lui-même n'est pas exposé : un votant vote toujours par son lien
// personnel, ce qui préserve « un email = un vote » et le secret du bulletin.
import express, { Router } from 'express';
import multer from 'multer';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { config } from '../config.js';
import { isUuid } from '../security.js';
import { ServiceError, invalid, conflict } from '../services/errors.js';
import * as polls from '../services/polls.js';
import { authenticateApiToken } from '../services/apiTokens.js';
import { sendVoterLink, normalizeEmail, canonicalEmail } from '../services/voters.js';
import { createQuota } from '../services/quota.js';
import { openapi } from '../api/openapi.js';

export const MAX_INVITATIONS_PER_REQUEST = 100;
// Emails d'invitation par heure : par organisateur (tous jetons confondus) et
// pour l'ensemble du service.
export const INVITATIONS_PER_HOUR = { user: 500, service: Number(process.env.API_INVITATIONS_PER_HOUR) || 2000 };

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}

// ---------- Sérialisation ----------

const iso = (d) => (d ? new Date(d).toISOString() : null);

function pollJson(p, extra = {}) {
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    status: p.status,
    is_closed: polls.isClosed(p),
    is_private: p.is_private,
    is_nominative: p.is_nominative,
    auth_mode: p.auth_mode,
    close_at: iso(p.close_at),
    created_at: iso(p.created_at),
    vote_url: `${config.baseUrl}/vote/${p.id}`,
    manage_url: `${config.baseUrl}/polls/${p.id}/manage`,
    ...(p.ballots !== undefined ? { ballot_count: p.ballots } : {}),
    ...extra,
  };
}

function optionJson(o) {
  return {
    id: o.id,
    label: o.label,
    description: o.description,
    position: o.position,
    has_image: o.has_image,
    image_url: o.has_image ? `${config.baseUrl}/options/${o.id}/image` : null,
  };
}

// ---------- Validation des corps JSON ----------

function body(req, allowed) {
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw invalid('Corps JSON attendu (objet).');
  const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new ApiError(400, 'validation_error', `Champ(s) inconnu(s) : ${unknown.join(', ')}.`);
  return b;
}

function optString(b, key, { required = false } = {}) {
  const v = b[key];
  if (v === undefined) {
    if (required) throw invalid(`« ${key} » est obligatoire.`);
    return undefined;
  }
  if (typeof v !== 'string') throw invalid(`« ${key} » doit être une chaîne.`);
  return v;
}

function optBoolean(b, key) {
  const v = b[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw invalid(`« ${key} » doit être un booléen.`);
  return v;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

// Date et heure réelles (refuse le 30 février ou 25 h, que Date « corrigerait »).
function isCalendarDate(v) {
  const [, y, mo, d, h, mi, sec = '0'] = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(v);
  const day = new Date(Date.UTC(+y, +mo - 1, +d));
  return day.getUTCMonth() === +mo - 1 && day.getUTCDate() === +d && +h < 24 && +mi < 60 && +sec < 60;
}

// close_at : date ISO 8601 avec fuseau (« 2026-12-15T18:00:00+01:00 »), ou null.
function optDate(b, key) {
  const v = b[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  const d = typeof v === 'string' && ISO_DATE.test(v) && isCalendarDate(v) ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) {
    throw invalid(`« ${key} » doit être une date ISO 8601 avec fuseau (ex. 2026-12-15T18:00:00+01:00), ou null.`);
  }
  return d;
}

function optionInputs(list) {
  if (!Array.isArray(list)) throw invalid('« options » doit être une liste.');
  return list.map((o, i) => {
    if (typeof o === 'string') return { label: o };
    if (!o || typeof o !== 'object') throw invalid(`Option ${i + 1} : chaîne ou objet { label, description } attendu.`);
    const extra = Object.keys(o).filter((k) => k !== 'label' && k !== 'description');
    if (extra.length) throw invalid(`Option ${i + 1} : champ(s) inconnu(s) : ${extra.join(', ')}.`);
    if (o.label !== undefined && typeof o.label !== 'string') throw invalid(`Option ${i + 1} : « label » doit être une chaîne.`);
    if (o.description !== undefined && typeof o.description !== 'string') throw invalid(`Option ${i + 1} : « description » doit être une chaîne.`);
    return { label: o.label, description: o.description };
  });
}

// ---------- Routeur ----------

export function createApiRouter({ rateLimits = true } = {}) {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: polls.IMAGE_MAX_BYTES, files: 1, fields: 10 },
  });

  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/openapi.json', (req, res) => res.json(openapi(config.baseUrl)));

  // Limite générale par adresse IP, avant l'authentification (essais de jetons).
  if (rateLimits) {
    router.use(rateLimit({
      windowMs: 15 * 60 * 1000, limit: 1000, standardHeaders: 'draft-8', legacyHeaders: false,
      handler: (req, res) => sendError(res, new ApiError(429, 'rate_limited', 'Trop de requêtes. Réessayez plus tard.')),
    }));
  }

  // Authentification par jeton.
  router.use(async (req, res, next) => {
    const header = req.get('authorization') || '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const auth = match ? await authenticateApiToken(match[1]) : null;
    if (!auth) {
      res.set('WWW-Authenticate', 'Bearer realm="vote-de-valeur"');
      return next(new ApiError(401, 'unauthorized', 'Jeton d’API absent, invalide ou révoqué.'));
    }
    req.api = auth;
    next();
  });

  // Portée : un jeton « read » ne peut que lire (GET, HEAD).
  router.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.api.scope !== 'write') {
      return next(new ApiError(403, 'insufficient_scope', 'Ce jeton est en lecture seule.'));
    }
    next();
  });

  const perToken = (windowMinutes, limit, message) => rateLimit({
    windowMs: windowMinutes * 60 * 1000, limit, standardHeaders: 'draft-8', legacyHeaders: false,
    keyGenerator: (req) => req.api?.tokenId || ipKeyGenerator(req.ip),
    handler: (req, res) => sendError(res, new ApiError(429, 'rate_limited', message)),
  });
  if (rateLimits) router.use(perToken(15, 600, 'Trop de requêtes pour ce jeton. Réessayez plus tard.'));
  const userQuota = createQuota({ limit: INVITATIONS_PER_HOUR.user, windowMs: 3600_000 });
  const serviceQuota = createQuota({ limit: INVITATIONS_PER_HOUR.service, windowMs: 3600_000 });

  // Corps acceptés : JSON, et multipart pour l'image d'une option.
  router.use((req, res, next) => {
    if (req.method === 'PUT') {
      if (/^\/polls\/[^/]+\/options\/[^/]+\/image$/.test(req.path) && req.is('multipart/form-data')) return next();
      return next(new ApiError(415, 'unsupported_media_type', 'Content-Type attendu : multipart/form-data (champ image).'));
    }
    if (req.method !== 'POST' && req.method !== 'PATCH') return next();
    if (req.is('application/json')) return next();
    if (req.method === 'POST' && /^\/polls\/[^/]+\/options$/.test(req.path) && req.is('multipart/form-data')) return next();
    next(new ApiError(415, 'unsupported_media_type', 'Content-Type attendu : application/json (multipart/form-data pour une image d’option).'));
  });
  router.use(express.json({ limit: '100kb' }));

  // Identifiants : UUID, sinon 404 sans interroger la base.
  for (const param of ['pollId', 'optionId']) {
    router.param(param, (req, res, next, value) => (isUuid(value)
      ? next()
      : next(new ApiError(404, 'not_found', 'Ressource introuvable.'))));
  }

  // Scrutin de l'organisateur ; celui d'un autre est traité comme inexistant.
  async function owned(req) {
    try {
      return await polls.getOwnedPoll(req.api.user.id, req.params.pollId);
    } catch (err) {
      if (err instanceof ServiceError && err.status === 403) throw new ApiError(404, 'not_found', 'Vote introuvable.');
      throw err;
    }
  }

  router.get('/me', (req, res) => {
    res.json({ user: req.api.user, token: { scope: req.api.scope } });
  });

  router.get('/polls', async (req, res) => {
    const list = await polls.listPolls(req.api.user.id);
    res.json({ polls: list.map((p) => pollJson(p)) });
  });

  router.post('/polls', async (req, res) => {
    const b = body(req, ['title', 'description', 'options', 'auth_mode', 'is_private', 'password', 'is_nominative', 'close_at']);
    const authMode = optString(b, 'auth_mode');
    if (authMode !== undefined && authMode !== 'email' && authMode !== 'name') {
      throw invalid('« auth_mode » : "email" ou "name".');
    }
    const id = await polls.createPoll(req.api.user.id, {
      title: optString(b, 'title', { required: true }),
      description: optString(b, 'description'),
      options: optionInputs(b.options ?? []),
      authMode: authMode || 'email',
      isPrivate: optBoolean(b, 'is_private'),
      password: optString(b, 'password'),
      isNominative: optBoolean(b, 'is_nominative'),
      closeAt: optDate(b, 'close_at') ?? null,
    });
    const poll = await polls.getOwnedPoll(req.api.user.id, id);
    res.status(201).location(`${config.baseUrl}/api/v1/polls/${id}`)
      .json(pollJson(poll, { options: (await polls.listOptions(id)).map(optionJson) }));
  });

  router.get('/polls/:pollId', async (req, res) => {
    const poll = await owned(req);
    const [options, stats] = await Promise.all([polls.listOptions(poll.id), polls.voterStats(poll.id)]);
    res.json(pollJson(poll, { options: options.map(optionJson), participation: stats }));
  });

  router.patch('/polls/:pollId', async (req, res) => {
    const poll = await owned(req);
    const b = body(req, ['title', 'description', 'close_at', 'status', 'is_nominative']);
    const status = optString(b, 'status');
    if (status !== undefined && status !== 'open' && status !== 'closed') throw invalid('« status » : "open" ou "closed".');
    const updated = await polls.updatePoll(poll, {
      title: optString(b, 'title'),
      description: optString(b, 'description'),
      closeAt: optDate(b, 'close_at'),
      status,
      isNominative: optBoolean(b, 'is_nominative'),
    });
    res.json(pollJson(updated, { options: (await polls.listOptions(poll.id)).map(optionJson) }));
  });

  router.delete('/polls/:pollId', async (req, res) => {
    await polls.deletePoll(await owned(req));
    res.status(204).end();
  });

  // Ajout d'une option : JSON { label, description }, ou multipart
  // (champs label, description et fichier image).
  router.post('/polls/:pollId/options', (req, res, next) => {
    if (!req.is('multipart/form-data')) return next();
    upload.single('image')(req, res, (err) => {
      if (!err) return next();
      next(err.code === 'LIMIT_FILE_SIZE'
        ? new ApiError(413, 'payload_too_large', 'Image trop volumineuse (3 Mo maximum).')
        : new ApiError(400, 'validation_error', 'Multipart attendu : champs label, description et fichier image.'));
    });
  }, async (req, res) => {
    const poll = await owned(req);
    const b = body(req, ['label', 'description']);
    if (req.file && !polls.IMAGE_MIME.has(req.file.mimetype)) {
      throw invalid('Image : formats PNG, JPEG, WebP ou GIF uniquement.');
    }
    const option = await polls.addOption(poll, {
      label: optString(b, 'label'), description: optString(b, 'description'), image: req.file || null,
    });
    res.status(201).json(optionJson(option));
  });

  router.patch('/polls/:pollId/options/:optionId', async (req, res) => {
    const poll = await owned(req);
    const b = body(req, ['label', 'description']);
    const option = await polls.editOption(poll, req.params.optionId, {
      label: optString(b, 'label'), description: optString(b, 'description'),
    });
    res.json(optionJson(option));
  });

  // Image d'une option existante (multipart, champ « image ») : ajout ou remplacement.
  router.put('/polls/:pollId/options/:optionId/image', (req, res, next) => {
    upload.single('image')(req, res, (err) => {
      if (!err) return next();
      next(err.code === 'LIMIT_FILE_SIZE'
        ? new ApiError(413, 'payload_too_large', 'Image trop volumineuse (3 Mo maximum).')
        : new ApiError(400, 'validation_error', 'Multipart attendu : fichier image.'));
    });
  }, async (req, res) => {
    const poll = await owned(req);
    const option = await polls.setOptionImage(poll, req.params.optionId, req.file || null);
    res.json(optionJson(option));
  });

  router.delete('/polls/:pollId/options/:optionId', async (req, res) => {
    await polls.deleteOption(await owned(req), req.params.optionId);
    res.status(204).end();
  });

  router.get('/polls/:pollId/results', async (req, res) => {
    const poll = await owned(req);
    const [{ options, ballotCount }, stats] = await Promise.all([polls.computeResults(poll.id), polls.voterStats(poll.id)]);
    res.json({
      poll_id: poll.id,
      is_closed: polls.isClosed(poll),
      ballot_count: ballotCount,
      participation: stats,
      options: options.map((o) => ({
        id: o.id, label: o.label, description: o.description,
        total: o.total, rank: o.rank, ballots: o.votes_count, has_image: o.has_image,
      })),
    });
  });

  router.get('/polls/:pollId/participants', async (req, res) => {
    const poll = await owned(req);
    res.json({ participants: await polls.listParticipants(poll) });
  });

  // Envoie à chaque adresse son lien de vote personnel (scrutin « email »).
  router.post('/polls/:pollId/invitations', async (req, res) => {
    const poll = await owned(req);
    const b = body(req, ['recipients']);
    if (poll.auth_mode !== 'email') throw conflict('Invitations possibles seulement pour un scrutin par email.');
    if (polls.isClosed(poll)) throw conflict('Le vote est clôturé.');
    const list = b.recipients;
    if (!Array.isArray(list) || list.length === 0) throw invalid('« recipients » : liste non vide attendue.');
    if (list.length > MAX_INVITATIONS_PER_REQUEST) {
      throw invalid(`${MAX_INVITATIONS_PER_REQUEST} destinataires au maximum par requête.`);
    }

    const valid = [];
    const rejected = [];
    const seen = new Set();
    for (const entry of list) {
      const raw = typeof entry === 'string' ? entry : entry?.email;
      const name = typeof entry === 'object' && entry && typeof entry.name === 'string' ? entry.name : '';
      const email = normalizeEmail(raw);
      if (!email) { rejected.push({ email: typeof raw === 'string' ? raw : null, reason: 'invalid_email' }); continue; }
      const canonical = canonicalEmail(email);
      if (seen.has(canonical)) { rejected.push({ email, reason: 'duplicate' }); continue; }
      seen.add(canonical);
      valid.push({ email, name });
    }

    // Quotas d'emails (tous jetons confondus), réservés avant tout envoi.
    if (rateLimits && valid.length) {
      if (!userQuota.take(req.api.user.id, valid.length)) {
        throw new ApiError(429, 'rate_limited', `Quota d’invitations atteint : ${INVITATIONS_PER_HOUR.user} emails par heure et par organisateur.`);
      }
      if (!serviceQuota.take('service', valid.length)) {
        throw new ApiError(429, 'rate_limited', 'Quota global d’invitations atteint. Réessayez plus tard.');
      }
    }

    // Une personne qui a déjà voté n'est pas relancée : son permalien de
    // résultats reste valable.
    const sent = [];
    for (const { email, name } of valid) {
      try {
        const outcome = await sendVoterLink(poll, email, name, { keepVoted: true });
        if (outcome === 'sent') sent.push(email);
        else rejected.push({ email, reason: 'already_voted' });
      } catch (err) {
        console.error('Invitation non envoyée :', err.code || err.name, err.responseCode || '');
        rejected.push({ email, reason: 'send_failed' });
      }
    }
    res.status(sent.length ? 200 : 422).json({ sent, rejected });
  });

  router.use((req, res, next) => next(new ApiError(404, 'route_not_found', 'Route inconnue. Voir /api/v1/openapi.json.')));

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => sendError(res, err));

  return router;
}

function sendError(res, err) {
  let e = err;
  if (err instanceof ServiceError) {
    e = new ApiError(err.status, err.code, err.message);
  } else if (err?.type === 'entity.parse.failed') {
    e = new ApiError(400, 'invalid_json', 'Corps JSON invalide.');
  } else if (err?.type === 'entity.too.large') {
    e = new ApiError(413, 'payload_too_large', 'Corps de requête trop volumineux.');
  } else if (!(err instanceof ApiError)) {
    console.error(err);
    e = new ApiError(500, 'internal_error', 'Erreur serveur.');
  }
  if (res.headersSent) return;
  res.status(e.status).json({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } });
}
