import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { query, tx } from '../db.js';
import { config } from '../config.js';
import { hashEmail, verifyPassword } from '../auth.js';
import { newToken, hashToken, sealWithToken, openWithToken } from '../tokens.js';
import { requireUuidParam } from '../security.js';
import { sendMagicLink, sendVoteConfirmation } from '../mailer.js';
import { computeResults } from '../results.js';

const router = Router();
router.param('id', requireUuidParam);

const ballotUrl = (pollId, token) => `${config.baseUrl}/vote/${pollId}/ballot/${token}`;
const resultsUrl = (pollId, token) => `${config.baseUrl}/vote/${pollId}/results/${token}`;

async function getPoll(id) {
  const { rows } = await query('SELECT * FROM polls WHERE id = $1', [id]);
  return rows[0] || null;
}

// Votant correspondant au jeton d'un lien (la base ne connaît que son empreinte).
async function getVoterByToken(pollId, token) {
  const { rows } = await query(
    'SELECT * FROM poll_voters WHERE poll_id = $1 AND token_hash = $2',
    [pollId, hashToken(token)]
  );
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
  const token = jwt.sign({ poll: poll.id, a: 1 }, config.jwtSecret, { expiresIn: '2h' });
  res.cookie(accessCookieName(poll.id), token, {
    httpOnly: true, sameSite: 'lax', secure: config.isProduction, maxAge: 2 * 3600 * 1000,
  });
}
function hasAccess(req, poll) {
  if (!poll.is_private) return true;
  const raw = req.cookies?.[accessCookieName(poll.id)];
  if (!raw) return false;
  try { return jwt.verify(raw, config.jwtSecret).poll === poll.id; } catch { return false; }
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
// Chaque demande crée un nouveau jeton, qui remplace le précédent : la base
// n'en garde que l'empreinte et ne peut donc pas renvoyer l'ancien.
router.post('/vote/:id/request', async (req, res) => {
  const poll = await getPoll(req.params.id);
  if (!poll) return res.status(404).render('error', { message: 'Vote introuvable.' });
  if (poll.auth_mode === 'name') return res.redirect(`/vote/${poll.id}`);
  if (poll.is_private && !hasAccess(req, poll)) return res.redirect(`/vote/${poll.id}`);
  if (isClosed(poll)) return res.render('vote_email', { poll, closed: true, sent: false });

  const email = String(req.body.email || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).render('vote_email', { poll, closed: false, sent: false, error: 'Email invalide.' });
  }
  const name = String(req.body.name || '').trim().slice(0, 120);
  const token = newToken();

  // Scrutin nominatif : email et nom en clair (vote assumé non secret).
  // Scrutin secret : l'email n'est stocké que chiffré avec le jeton du votant,
  // le temps d'envoyer la confirmation de vote, puis effacé.
  const clearEmail = poll.is_nominative ? email : null;
  const displayName = poll.is_nominative ? (name || null) : null;
  const sealedEmail = poll.is_nominative ? null : sealWithToken(token, email);

  await query(
    `INSERT INTO poll_voters (poll_id, email_hash, token_hash, email, email_sealed, display_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (poll_id, email_hash) DO UPDATE SET
       token_hash   = EXCLUDED.token_hash,
       email        = CASE WHEN poll_voters.voted_at IS NULL THEN EXCLUDED.email ELSE poll_voters.email END,
       email_sealed = CASE WHEN poll_voters.voted_at IS NULL THEN EXCLUDED.email_sealed END,
       display_name = CASE WHEN poll_voters.voted_at IS NULL THEN EXCLUDED.display_name ELSE poll_voters.display_name END`,
    [poll.id, hashEmail(email), hashToken(token), clearEmail, sealedEmail, displayName]
  );

  try {
    await sendMagicLink({ to: email, pollTitle: poll.title, url: ballotUrl(poll.id, token) });
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

// --- Mode « nom » (léger, sans email) : on saisit son nom et on vote directement ---
// Unicité par nom (normalisé) : un nom = un vote par scrutin.
router.post('/vote/:id/name', async (req, res) => {
  const poll = await getPoll(req.params.id);
  if (!poll) return res.status(404).render('error', { message: 'Vote introuvable.' });
  if (poll.auth_mode !== 'name') return res.redirect(`/vote/${poll.id}`);
  if (poll.is_private && !hasAccess(req, poll)) return res.redirect(`/vote/${poll.id}`);
  if (isClosed(poll)) return res.render('vote_email', { poll, closed: true, sent: false });

  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (name.length < 2) {
    return res.status(400).render('vote_email', { poll, closed: false, sent: false, error: 'Entrez votre nom (2 caractères minimum).' });
  }
  const token = newToken();
  // Le nom n'est gardé en clair qu'en scrutin nominatif ; sinon seul son HMAC
  // sert à empêcher un second vote sous le même nom.
  const { rows } = await query(
    `INSERT INTO poll_voters (poll_id, email_hash, token_hash, display_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (poll_id, email_hash) DO UPDATE SET
       token_hash = EXCLUDED.token_hash, display_name = EXCLUDED.display_name
     WHERE poll_voters.voted_at IS NULL
     RETURNING id`,
    [poll.id, hashEmail(name.toLowerCase()), hashToken(token), poll.is_nominative ? name : null]
  );
  if (!rows[0]) {
    return res.status(409).render('vote_email', {
      poll, closed: false, sent: false, error: `Le nom « ${name} » a déjà voté pour ce scrutin.`,
    });
  }
  return res.redirect(`/vote/${poll.id}/ballot/${token}`);
});

// --- Bulletin via lien magique ---
router.get('/vote/:id/ballot/:token', async (req, res) => {
  const poll = await getPoll(req.params.id);
  if (!poll) return res.status(404).render('error', { message: 'Vote introuvable.' });

  const voter = await getVoterByToken(poll.id, req.params.token);
  if (!voter) return res.status(404).render('error', { message: 'Lien de vote invalide ou remplacé par un lien plus récent.' });

  // Déjà voté → on montre les résultats (vote définitif).
  if (voter.voted_at) return res.redirect(`/vote/${poll.id}/results/${req.params.token}`);

  if (!voter.verified_at) {
    // Date seule en scrutin secret : un horodatage précis aiderait à relier
    // le votant à son bulletin.
    await query(
      `UPDATE poll_voters SET verified_at = CASE WHEN $2 THEN now() ELSE date_trunc('day', now(), 'UTC') END
        WHERE id = $1`,
      [voter.id, poll.is_nominative]
    );
  }

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

  const token = req.params.token;
  const voter = await getVoterByToken(poll.id, token);
  if (!voter) return res.status(404).render('error', { message: 'Lien de vote invalide.' });
  if (voter.voted_at) return res.redirect(`/vote/${poll.id}/results/${token}`);

  const { rows: options } = await query('SELECT id, label FROM options WHERE poll_id = $1 ORDER BY position', [poll.id]);

  const myScores = [];
  const recorded = await tx(async (client) => {
    // Verrou sur le votant : deux soumissions simultanées ne créent qu'un bulletin.
    const { rows: locked } = await client.query(
      'SELECT voted_at FROM poll_voters WHERE id = $1 FOR UPDATE', [voter.id]
    );
    if (!locked[0] || locked[0].voted_at) return false;

    // Scrutin secret : bulletin sans lien vers le votant ni horodatage, et date
    // de vote arrondie au jour, pour qu'on ne puisse pas les rapprocher.
    const b = await client.query(
      `INSERT INTO ballots (poll_id, voter_id, created_at)
       VALUES ($1, $2, CASE WHEN $3 THEN now() END) RETURNING id`,
      [poll.id, poll.is_nominative ? voter.id : null, poll.is_nominative]
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
    await client.query(
      `UPDATE poll_voters
          SET voted_at = CASE WHEN $2 THEN now() ELSE date_trunc('day', now(), 'UTC') END,
              email_sealed = NULL
        WHERE id = $1`,
      [voter.id, poll.is_nominative]
    );
    return true;
  });
  if (!recorded) return res.redirect(`/vote/${poll.id}/results/${token}`);

  // Confirmation par email (best-effort : ne bloque jamais le vote). En scrutin
  // secret, l'adresse n'est lisible qu'avec le jeton présenté maintenant.
  const recipient = voter.email || openWithToken(token, voter.email_sealed);
  if (recipient) {
    try {
      const { options: results } = await computeResults(poll.id);
      await sendVoteConfirmation({
        to: recipient,
        pollTitle: poll.title,
        myScores,
        results: results.map((o) => ({ label: o.label, total: o.total, rank: o.rank })),
        permalink: resultsUrl(poll.id, token),
      });
    } catch (err) {
      console.error('Confirmation de vote non envoyée :', err);
    }
  }

  res.redirect(`/vote/${poll.id}/results/${token}?v=1`);
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

  const voter = await getVoterByToken(poll.id, req.params.token);
  if (!voter) return res.status(404).render('error', { message: 'Lien invalide.' });
  if (!voter.voted_at) {
    // N'a pas encore voté : on l'envoie au bulletin.
    return res.redirect(`/vote/${poll.id}/ballot/${req.params.token}`);
  }

  const { options, ballotCount } = await computeResults(poll.id);
  res.render('results', {
    poll, options, ballotCount, token: req.params.token, closed: isClosed(poll),
    justVoted: req.query.v === '1',
    permalink: resultsUrl(poll.id, req.params.token),
  });
});

// --- Résultats JSON pour la mise à jour en temps réel (réservé au votant) ---
router.get('/api/polls/:id/results', async (req, res) => {
  const voter = await getVoterByToken(req.params.id, String(req.query.token || ''));
  if (!voter || !voter.voted_at) return res.status(403).json({ error: 'forbidden' });
  const { options, ballotCount } = await computeResults(req.params.id);
  res.json({ options, ballotCount });
});

export default router;
