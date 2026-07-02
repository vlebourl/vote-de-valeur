import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import { query, tx } from '../db.js';
import { hashEmail, verifyPassword } from '../auth.js';
import { sendMagicLink, sendVoteConfirmation } from '../mailer.js';
import { computeResults } from '../results.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret';
const BASE_URL = () => (process.env.BASE_URL || '').replace(/\/$/, '');

async function getPoll(id) {
  const { rows } = await query('SELECT * FROM polls WHERE id = $1', [id]);
  return rows[0] || null;
}

// Un vote est-il effectivement clos ? (statut ou date de clôture dépassée)
function isClosed(poll) {
  if (poll.status === 'closed') return true;
  if (poll.close_at && new Date(poll.close_at) <= new Date()) return true;
  return false;
}

// Cookie prouvant l'accès à un vote privé
function accessCookieName(id) { return `vv_access_${id.slice(0, 8)}`; }
function grantAccess(res, poll) {
  const token = jwt.sign({ poll: poll.id, a: 1 }, JWT_SECRET, { expiresIn: '2h' });
  res.cookie(accessCookieName(poll.id), token, { httpOnly: true, sameSite: 'lax', maxAge: 2 * 3600 * 1000 });
}
function hasAccess(req, poll) {
  if (!poll.is_private) return true;
  const raw = req.cookies?.[accessCookieName(poll.id)];
  if (!raw) return false;
  try { return jwt.verify(raw, JWT_SECRET).poll === poll.id; } catch { return false; }
}

// --- Page d'entrée d'un vote (par UUID) ---
router.get('/vote/:id', async (req, res) => {
  const poll = await getPoll(req.params.id);
  if (!poll) return res.status(404).render('error', { message: 'Vote introuvable.' });

  if (poll.is_private && !hasAccess(req, poll)) {
    return res.render('vote_password', { poll, error: null });
  }
  res.render('vote_email', { poll, closed: isClosed(poll), sent: req.query.sent === '1' });
});

// --- Déverrouillage d'un vote privé ---
router.post('/vote/:id/access', async (req, res) => {
  const poll = await getPoll(req.params.id);
  if (!poll) return res.status(404).render('error', { message: 'Vote introuvable.' });
  const ok = await verifyPassword(String(req.body.password || ''), poll.password_hash);
  if (!ok) return res.status(401).render('vote_password', { poll, error: 'Mot de passe incorrect.' });
  grantAccess(res, poll);
  res.redirect(`/vote/${poll.id}`);
});

// --- Demande du lien de vote par email ---
router.post('/vote/:id/request', async (req, res) => {
  const poll = await getPoll(req.params.id);
  if (!poll) return res.status(404).render('error', { message: 'Vote introuvable.' });
  if (poll.is_private && !hasAccess(req, poll)) return res.redirect(`/vote/${poll.id}`);
  if (isClosed(poll)) return res.render('vote_email', { poll, closed: true, sent: false });

  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).render('vote_email', { poll, closed: false, sent: false, error: 'Email invalide.' });
  }
  const emailHash = hashEmail(email);
  const name = String(req.body.name || '').trim().slice(0, 120);

  // Récupère ou crée le votant, en réutilisant son jeton s'il existe déjà.
  // En scrutin nominatif, on conserve l'email et le nom en clair (vote non secret) ;
  // sinon on ne stocke que le hachage (secret du bulletin préservé).
  let token;
  const existing = await query(
    'SELECT magic_token FROM poll_voters WHERE poll_id = $1 AND email_hash = $2',
    [poll.id, emailHash]
  );
  // On conserve l'email en clair pour pouvoir envoyer la confirmation de vote.
  // Il n'est jamais relié au bulletin (le vote reste secret sauf scrutin nominatif).
  if (existing.rows[0]) {
    token = existing.rows[0].magic_token;
    await query(
      'UPDATE poll_voters SET email = $1, display_name = $2 WHERE poll_id = $3 AND email_hash = $4',
      [email, poll.is_nominative ? (name || null) : null, poll.id, emailHash]
    );
  } else {
    token = nanoid(32);
    await query(
      'INSERT INTO poll_voters (poll_id, email_hash, magic_token, email, display_name) VALUES ($1,$2,$3,$4,$5)',
      [poll.id, emailHash, token, email, poll.is_nominative ? (name || null) : null]
    );
  }

  const url = `${BASE_URL()}/vote/${poll.id}/ballot/${token}`;
  try {
    await sendMagicLink({ to: email, pollTitle: poll.title, url });
  } catch (err) {
    console.error('Envoi email échoué :', err);
    return res.status(500).render('vote_email', {
      poll, closed: false, sent: false,
      error: "L'envoi de l'email a échoué. Réessayez plus tard.",
    });
  }
  // Réponse identique quel que soit le cas (ne révèle pas si l'email a déjà voté).
  res.redirect(`/vote/${poll.id}?sent=1`);
});

// --- Bulletin via lien magique ---
router.get('/vote/:id/ballot/:token', async (req, res) => {
  const poll = await getPoll(req.params.id);
  if (!poll) return res.status(404).render('error', { message: 'Vote introuvable.' });

  const { rows } = await query(
    'SELECT * FROM poll_voters WHERE poll_id = $1 AND magic_token = $2',
    [poll.id, req.params.token]
  );
  const voter = rows[0];
  if (!voter) return res.status(404).render('error', { message: 'Lien de vote invalide ou expiré.' });

  if (!voter.verified_at) {
    await query('UPDATE poll_voters SET verified_at = now() WHERE id = $1', [voter.id]);
  }

  // Déjà voté → on montre les résultats (vote définitif).
  if (voter.voted_at) return res.redirect(`/vote/${poll.id}/results/${req.params.token}`);

  if (isClosed(poll)) {
    return res.render('vote_closed', { poll, voted: false });
  }

  const { rows: options } = await query(
    `SELECT id, label, description, position, (image_data IS NOT NULL) AS has_image
       FROM options WHERE poll_id = $1 ORDER BY position`, [poll.id]
  );
  res.render('ballot', { poll, options, token: req.params.token });
});

// --- Soumission du bulletin ---
router.post('/vote/:id/ballot/:token', async (req, res) => {
  const poll = await getPoll(req.params.id);
  if (!poll) return res.status(404).render('error', { message: 'Vote introuvable.' });
  if (isClosed(poll)) return res.render('vote_closed', { poll, voted: false });

  const { rows } = await query(
    'SELECT * FROM poll_voters WHERE poll_id = $1 AND magic_token = $2',
    [poll.id, req.params.token]
  );
  const voter = rows[0];
  if (!voter) return res.status(404).render('error', { message: 'Lien de vote invalide.' });
  if (voter.voted_at) return res.redirect(`/vote/${poll.id}/results/${req.params.token}`);

  const { rows: options } = await query('SELECT id, label FROM options WHERE poll_id = $1 ORDER BY position', [poll.id]);

  const myScores = [];
  await tx(async (client) => {
    const b = await client.query(
      'INSERT INTO ballots (poll_id, voter_id) VALUES ($1,$2) RETURNING id',
      [poll.id, poll.is_nominative ? voter.id : null]
    );
    const ballotId = b.rows[0].id;
    for (const opt of options) {
      let score = parseInt(req.body[`score_${opt.id}`], 10);
      if (!Number.isInteger(score) || score < -2 || score > 2) score = 0; // abstention = 0
      myScores.push({ label: opt.label, score });
      await client.query(
        'INSERT INTO ballot_scores (ballot_id, option_id, score) VALUES ($1,$2,$3)',
        [ballotId, opt.id, score]
      );
    }
    await client.query('UPDATE poll_voters SET voted_at = now() WHERE id = $1', [voter.id]);
  });

  // Confirmation par email (best-effort : ne bloque jamais le vote).
  if (voter.email) {
    try {
      const { options: results } = await computeResults(poll.id);
      await sendVoteConfirmation({
        to: voter.email,
        pollTitle: poll.title,
        myScores,
        results: results.map((o) => ({ label: o.label, total: o.total, rank: o.rank })),
        permalink: `${BASE_URL()}/vote/${poll.id}/results/${req.params.token}`,
      });
    } catch (err) {
      console.error('Confirmation de vote non envoyée :', err);
    }
  }

  res.redirect(`/vote/${poll.id}/results/${req.params.token}?v=1`);
});

// --- Résultats sans jeton : réservés aux votants → on renvoie à la page du vote ---
router.get('/vote/:id/results', (req, res) => {
  res.redirect(`/vote/${req.params.id}`);
});

// --- Résultats via lien magique (après avoir voté) ---
// C'est le PERMALIEN personnel du votant : il reste valable et affiche les
// résultats en temps réel à chaque visite.
router.get('/vote/:id/results/:token', async (req, res) => {
  const poll = await getPoll(req.params.id);
  if (!poll) return res.status(404).render('error', { message: 'Vote introuvable.' });

  const { rows } = await query(
    'SELECT voted_at FROM poll_voters WHERE poll_id = $1 AND magic_token = $2',
    [poll.id, req.params.token]
  );
  if (!rows[0]) return res.status(404).render('error', { message: 'Lien invalide.' });
  if (!rows[0].voted_at) {
    // N'a pas encore voté : on l'envoie au bulletin.
    return res.redirect(`/vote/${poll.id}/ballot/${req.params.token}`);
  }

  const { options, ballotCount } = await computeResults(poll.id);
  res.render('results', {
    poll, options, ballotCount, token: req.params.token, closed: isClosed(poll),
    justVoted: req.query.v === '1',
    permalink: `${BASE_URL()}/vote/${poll.id}/results/${req.params.token}`,
  });
});

// --- Résultats JSON pour la mise à jour en temps réel (réservé au votant) ---
router.get('/api/polls/:id/results', async (req, res) => {
  const token = String(req.query.token || '');
  const { rows } = await query(
    'SELECT voted_at FROM poll_voters WHERE poll_id = $1 AND magic_token = $2',
    [req.params.id, token]
  );
  if (!rows[0] || !rows[0].voted_at) return res.status(403).json({ error: 'forbidden' });
  const { options, ballotCount } = await computeResults(req.params.id);
  res.json({ options, ballotCount });
});

export default router;
