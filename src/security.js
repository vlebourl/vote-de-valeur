// Protections HTTP transverses : en-têtes, contrôle d'origine, limitation de
// débit, validation des paramètres et des redirections.
import { rateLimit } from 'express-rate-limit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

// Paramètre de route qui doit être un UUID : sinon 404, sans interroger la base.
export function requireUuidParam(req, res, next, value) {
  if (isUuid(value)) return next();
  if (req.originalUrl.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  return res.status(404).render('error', { message: 'Page introuvable.' });
}

// Redirection après connexion : uniquement un chemin local ("/…"), jamais
// "//hote" ni "/\hote", que les navigateurs interprètent comme une autre origine.
export function safeNext(next, fallback = '/dashboard') {
  if (typeof next !== 'string' || !next.startsWith('/')) return fallback;
  if (next.startsWith('//') || next.startsWith('/\\')) return fallback;
  return next;
}

export function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // Les liens de vote contiennent un jeton personnel : ne jamais l'envoyer à
    // un autre site par l'en-tête Referer.
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  next();
}

// Protection CSRF légère : toute requête d'écriture envoyée par un navigateur
// depuis une autre origine est refusée. Complète le cookie SameSite=Lax.
export function sameOriginWrites({ baseUrl } = {}) {
  let baseHost = null;
  try { baseHost = baseUrl ? new URL(baseUrl).host : null; } catch { /* BASE_URL invalide : ignorée */ }
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const origin = req.get('origin');
    if (!origin) return next(); // client hors navigateur, ou navigateur ancien
    let host = null;
    try { host = new URL(origin).host; } catch { /* "null" ou valeur invalide */ }
    if (host && (host === req.get('host') || host === baseHost)) return next();
    return res.status(403).render('error', { message: 'Requête refusée : origine différente.' });
  };
}

// Limiteurs de débit par adresse IP, créés pour chaque instance de l'application.
export function createLimiters() {
  const make = (windowMinutes, limit) => rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => res.status(429).render('error', {
      message: 'Trop de tentatives. Réessayez dans quelques minutes.',
    }),
  });
  return {
    auth: make(15, 20),        // connexion, inscription
    magicLink: make(60, 10),   // envoi d'emails
    pollPassword: make(15, 20),// mot de passe des scrutins privés
    nameVote: make(15, 30),    // mode « nom »
  };
}
