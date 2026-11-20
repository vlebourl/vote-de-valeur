import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { query, tx } from '../db.js';
import { config } from '../config.js';
import { hashEmail, verifyPassword } from '../auth.js';
import { newToken, hashToken, openWithToken } from '../tokens.js';
import { requireUuidParam } from '../security.js';
import { sendVoteConfirmation } from '../mailer.js';
import { isClosed, visibleResults } from '../services/polls.js';
import { sendVoterLink, normalizeEmail, resultsUrl } from '../services/voters.js';
import { missingOptions, subscribe, subscribedEmail } from '../services/followups.js';

const router = Router();
router.param('id', requireUuidParam);


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

  const email = normalizeEmail(req.body.email);
  if (!email) {
    return res.status(400).render('vote_email', { poll, closed: false, sent: false, error: 'Email invalide.' });
  }
  try {
    await sendVoterLink(poll, email, req.body.name);
  } catch (err) {
    console.error('Envoi du lien de vote échoué :', err.code || err.name, err.responseCode || '');
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
    // Déjà voté : nouveau lien seulement s'il reste des choix ajoutés depuis à noter.
    const nameHash = hashEmail(name.toLowerCase());
    const { rows: prior } = await query(
      'SELECT id, rated_option_ids FROM poll_voters WHERE poll_id = $1 AND email_hash = $2', [poll.id, nameHash]
    );
    if (prior[0] && (await missingOptions(poll.id, prior[0].rated_option_ids)).length) {
      await query('UPDATE poll_voters SET token_hash = $1 WHERE id = $2', [hashToken(token), prior[0].id]);
      return res.redirect(`/vote/${poll.id}/ballot/${token}`);
    }
    return res.status(409).render('vote_email', {
      poll, closed: false, sent: false, error: `Le nom « ${name} » a déjà voté pour ce scrutin.`,
    });
  }
  return res.redirect(`/vote/${poll.id}/ballot/${token}`);
});

// --- Bulletin via lien magique ---
// Après le vote, le même lien propose de noter les choix ajoutés depuis (bulletin
// complémentaire) ; sinon il mène aux résultats.
router.get('/vote/:id/ballot/:token', async (req, res) => {
  const poll = await getPoll(req.params.id);
  if (!poll) return res.status(404).render('error', { message: 'Vote introuvable.' });

  const voter = await getVoterByToken(poll.id, req.params.token);
  if (!voter) return res.status(404).render('error', { message: 'Lien de vote invalide ou remplacé par un lien plus récent.' });

  if (voter.voted_at) {
    const missing = isClosed(poll) ? [] : await missingOptions(poll.id, voter.rated_option_ids);
    if (!missing.length) return res.redirect(`/vote/${poll.id}/results/${req.params.token}`);
    return res.render('ballot', {
      poll, options: missing, token: req.params.token, supplement: true, canNotify: canNotify(poll, voter),
    });
  }

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
  res.render('ballot', { poll, options, token: req.params.token, supplement: false, canNotify: canNotify(poll, voter) });
});

// Peut-on proposer « Prévenez-moi si un choix est ajouté » ? Il faut une adresse
// (mode email) : en clair en nominatif, sinon lisible avec le jeton du lien.
function canNotify(poll, voter) {
  return poll.auth_mode === 'email' && Boolean(voter.email || voter.email_sealed);
}

// --- Soumission du bulletin (ou du complément pour les nouveaux choix) ---
router.post('/vote/:id/ballot/:token', async (req, res) => {
  const poll = await getPoll(req.params.id);
  if (!poll) return res.status(404).render('error', { message: 'Vote introuvable.' });
  if (isClosed(poll)) return res.render('vote_closed', { poll, voted: false });

  const token = req.params.token;
  const voter = await getVoterByToken(poll.id, token);
  if (!voter) return res.status(404).render('error', { message: 'Lien de vote invalide.' });

  // Adresse du votant, si elle est disponible maintenant (confirmation, abonnement) :
  // en clair (nominatif), lisible avec ce lien (avant le vote), ou celle de son
  // abonnement aux avis (complément après le vote).
  const recipient = voter.email || openWithToken(token, voter.email_sealed) || await subscribedEmail(voter.id);
  const wantsNotice = req.body.notify === 'on' && poll.auth_mode === 'email';

  const { rows: options } = await query('SELECT id, label FROM options WHERE poll_id = $1 ORDER BY position', [poll.id]);
  const scoreOf = (opt) => {
    const raw = req.body[`score_${opt.id}`];
    if (raw === undefined) return undefined; // option absente du formulaire : non notée
    const score = parseInt(raw, 10);
    return Number.isInteger(score) && score >= -2 && score <= 2 ? score : 0;
  };

  const myScores = [];
  const outcome = await tx(async (client) => {
    // Le mode (secret ou nominatif) doit être celui que le votant a vu sur son
    // bulletin. Verrou partagé : une bascule de mode attend la fin de ce vote.
    const { rows: current } = await client.query('SELECT is_nominative FROM polls WHERE id = $1 FOR SHARE', [poll.id]);
    poll.is_nominative = current[0].is_nominative;
    if (req.body.mode !== (poll.is_nominative ? 'nominative' : 'secret')) return 'mode_changed';

    // Verrou sur le votant : deux soumissions simultanées ne créent qu'un bulletin.
    const { rows: locked } = await client.query(
      'SELECT voted_at, rated_option_ids FROM poll_voters WHERE id = $1 FOR UPDATE', [voter.id]
    );
    if (!locked[0]) return 'already_voted';
    const supplement = Boolean(locked[0].voted_at);
    const rated = new Set(locked[0].rated_option_ids || []);
    // Premier vote : toutes les options présentées. Complément : seulement celles
    // pas encore notées (le vote reste définitif pour les autres).
    const targets = options.filter((o) => scoreOf(o) !== undefined && !(supplement && rated.has(o.id)));
    if (supplement && (!locked[0].rated_option_ids || targets.length === 0)) return 'already_voted';

    // Scrutin secret : bulletin sans lien vers le votant ni horodatage, et date
    // de vote arrondie au jour, pour qu'on ne puisse pas les rapprocher.
    const b = await client.query(
      `INSERT INTO ballots (poll_id, voter_id, created_at, is_supplement)
       VALUES ($1, $2, CASE WHEN $3 THEN now() END, $4) RETURNING id`,
      [poll.id, poll.is_nominative ? voter.id : null, poll.is_nominative, supplement]
    );
    for (const opt of targets) {
      const score = scoreOf(opt);
      myScores.push({ label: opt.label, score });
      await client.query(
        'INSERT INTO ballot_scores (ballot_id, option_id, score) VALUES ($1,$2,$3)',
        [b.rows[0].id, opt.id, score]
      );
    }
    const ratedIds = [...rated, ...targets.map((o) => o.id)];
    if (supplement) {
      await client.query('UPDATE poll_voters SET rated_option_ids = $2 WHERE id = $1', [voter.id, ratedIds]);
    } else {
      await client.query(
        `UPDATE poll_voters
            SET voted_at = CASE WHEN $2 THEN now() ELSE date_trunc('day', now(), 'UTC') END,
                email_sealed = NULL, rated_option_ids = $3
          WHERE id = $1`,
        [voter.id, poll.is_nominative, ratedIds]
      );
    }
    if (wantsNotice && recipient) await subscribe(client, poll, voter.id, recipient);
    return supplement ? 'supplemented' : 'recorded';
  });
  if (outcome === 'mode_changed') {
    const ballotOptions = voter.voted_at
      ? await missingOptions(poll.id, voter.rated_option_ids)
      : (await query(
        `SELECT id, label, description, position, (image_data IS NOT NULL) AS has_image
           FROM options WHERE poll_id = $1 ORDER BY position`, [poll.id])).rows;
    return res.status(409).render('ballot', {
      poll, options: ballotOptions, token, modeChanged: true, supplement: Boolean(voter.voted_at), canNotify: canNotify(poll, voter),
    });
  }
  if (outcome === 'already_voted') return res.redirect(`/vote/${poll.id}/results/${token}`);

  // Confirmation par email (best-effort : ne bloque jamais le vote) : ses notes
  // seulement, jamais les résultats.
  if (recipient) {
    try {
      await sendVoteConfirmation({
        to: recipient,
        pollTitle: poll.title,
        myScores,
        permalink: resultsUrl(poll.id, token),
        supplement: outcome === 'supplemented',
      });
    } catch (err) {
      console.error('Confirmation de vote non envoyée :', err.code || err.name, err.responseCode || '');
    }
  }

  res.redirect(`/vote/${poll.id}/results/${token}?v=${outcome === 'supplemented' ? 2 : 1}`);
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

  const { options, ballotCount, visible, threshold } = await visibleResults(poll, 'voter');
  const newOptions = isClosed(poll) ? [] : await missingOptions(poll.id, voter.rated_option_ids);
  res.render('results', {
    poll, options, ballotCount, visible, threshold, token: req.params.token, closed: isClosed(poll),
    newOptions,
    justVoted: req.query.v === '1',
    justSupplemented: req.query.v === '2',
    permalink: resultsUrl(poll.id, req.params.token),
  });
});

// --- Résultats JSON pour la mise à jour en temps réel (réservé au votant) ---
router.get('/api/polls/:id/results', async (req, res) => {
  const voter = await getVoterByToken(req.params.id, String(req.query.token || ''));
  if (!voter || !voter.voted_at) return res.status(403).json({ error: 'forbidden' });
  const poll = await getPoll(req.params.id);
  const { options, ballotCount, visible, threshold } = await visibleResults(poll, 'voter');
  res.json({ options, ballotCount, hidden: !visible, threshold });
});

export default router;
