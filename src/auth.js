import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret';
const EMAIL_HASH_SECRET = process.env.EMAIL_HASH_SECRET || 'dev-insecure-email-secret';
const COOKIE_NAME = 'vv_session';

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

export function signSession(user) {
  return jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
}

export function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

// Middleware : attache req.user si un cookie de session valide est présent.
export function loadUser(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.user = { id: payload.uid, email: payload.email };
    } catch {
      /* cookie invalide/expiré : ignoré */
    }
  }
  res.locals.user = req.user || null;
  next();
}

// Middleware : exige un utilisateur connecté.
export function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  next();
}

// Normalise puis hash l'email (HMAC) — unicité sans stockage en clair.
export function hashEmail(email) {
  const normalized = String(email).trim().toLowerCase();
  return crypto.createHmac('sha256', EMAIL_HASH_SECRET).update(normalized).digest('hex');
}
