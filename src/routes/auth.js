import { Router } from 'express';
import { query } from '../db.js';
import {
  hashPassword, verifyPassword, signSession,
  setSessionCookie, clearSessionCookie,
} from '../auth.js';
import { safeNext } from '../security.js';

const router = Router();

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('register', { error: null, email: '' });
});

router.post('/register', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || password.length < 8 || password.length > 200) {
    return res.status(400).render('register', {
      error: 'Email valide requis et mot de passe de 8 à 200 caractères.', email,
    });
  }
  try {
    const hash = await hashPassword(password);
    const { rows } = await query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, hash]
    );
    const token = signSession(rows[0]);
    setSessionCookie(res, token);
    res.redirect('/dashboard');
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).render('register', { error: 'Cet email est déjà utilisé.', email });
    }
    console.error(err);
    res.status(500).render('register', { error: 'Erreur serveur.', email });
  }
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('login', { error: null, email: '', next: safeNext(req.query.next, '') });
});

router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const next = safeNext(req.body.next);
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return res.status(401).render('login', { error: 'Identifiants invalides.', email, next });
  }
  const token = signSession(user);
  setSessionCookie(res, token);
  res.redirect(next);
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.redirect('/');
});

export default router;
