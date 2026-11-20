// Choix ajoutés après un vote : avis aux votants qui l'ont demandé, et
// complément de bulletin pour noter ces nouveaux choix.
//
// Confidentialité : l'adresse d'un votant qui demande à être prévenu est gardée
// chiffrée par une clé du serveur, dans une table rattachée à son inscription et
// jamais à son bulletin ; elle est effacée à la clôture du scrutin. L'organisateur
// ne voit jamais ces adresses, seulement des nombres.
import crypto from 'node:crypto';
import { query, tx } from '../db.js';
import { config } from '../config.js';
import { newToken, hashToken } from '../tokens.js';
import { sendNewOptionsNotice } from '../mailer.js';
import { ballotUrl } from './voters.js';
import { isClosed } from './polls.js';

const KEY = Buffer.from(crypto.hkdfSync('sha256', config.emailHashSecret, 'vote-de-valeur', 'notify-email-v1', 32));

export function sealEmail(email) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([cipher.update(email, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function openEmail(sealed) {
  try {
    const raw = Buffer.from(sealed, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// Options du scrutin que ce votant n'a pas encore notées (dans l'ordre du scrutin).
// voter : { rated_option_ids, rated_before_v12 }. Un votant d'avant la version
// 1.2 ne peut noter que les options créées depuis (created_at renseigné) : on
// ignore lesquelles il avait notées, toutes celles d'origine restent donc closes.
const MISSING_SQL = `SELECT id, label, description, position, (image_data IS NOT NULL) AS has_image
   FROM options
  WHERE poll_id = $1
    AND NOT (id = ANY(COALESCE($2::uuid[], '{}')))
    AND (NOT $3::boolean OR created_at IS NOT NULL)
  ORDER BY position`;

export async function missingOptions(pollId, voter, client = { query }) {
  if (!voter.rated_option_ids && !voter.rated_before_v12) return []; // n'a pas voté
  const { rows } = await client.query(MISSING_SQL, [pollId, voter.rated_option_ids ?? null, Boolean(voter.rated_before_v12)]);
  return rows;
}

// Adresse d'un votant abonné aux avis, ou null.
export async function subscribedEmail(voterId) {
  const { rows } = await query('SELECT email_enc FROM voter_notifications WHERE voter_id = $1', [voterId]);
  return rows[0] ? openEmail(rows[0].email_enc) : null;
}

// Abonnement d'un votant (dans la transaction de son vote).
export async function subscribe(client, poll, voterId, email) {
  await client.query(
    `INSERT INTO voter_notifications (voter_id, poll_id, email_enc, created_at)
     VALUES ($1, $2, $3, CASE WHEN $4 THEN now() END)
     ON CONFLICT (voter_id) DO UPDATE SET email_enc = EXCLUDED.email_enc`,
    [voterId, poll.id, sealEmail(email), poll.is_nominative]
  );
}

// Votants abonnés à prévenir : ceux qui ont au moins un choix non noté dont ils
// n'ont pas encore été avertis (une seule requête).
const PENDING_SQL = `SELECT vn.voter_id
   FROM voter_notifications vn JOIN poll_voters pv ON pv.id = vn.voter_id
  WHERE vn.poll_id = $1 AND pv.voted_at IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM options o
       WHERE o.poll_id = vn.poll_id
         AND NOT (o.id = ANY(COALESCE(pv.rated_option_ids, '{}')))
         AND (NOT pv.rated_before_v12 OR o.created_at IS NOT NULL)
         AND NOT (o.id = ANY(vn.notified_option_ids)))
  ORDER BY vn.voter_id`;

async function pending(poll) {
  return (await query(PENDING_SQL, [poll.id])).rows.map((r) => r.voter_id);
}

export async function pendingCount(poll) {
  return (await pending(poll)).length;
}

export async function subscriberCount(poll) {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM voter_notifications WHERE poll_id = $1', [poll.id]);
  return rows[0].n;
}

// Prévient les abonnés concernés : un lien personnel supplémentaire (l'ancien
// reste valable) et la liste des nouveaux choix.
// Pour chaque votant, tout est revérifié sous verrou (scrutin ouvert à cet
// instant, choix encore à noter et pas déjà signalés) ; le quota n'est réservé
// qu'ensuite, pour un envoi réel. Le remplacement du lien n'est validé que si
// l'email part. take(n) réserve n emails (false : quota atteint).
// Renvoie des nombres seulement : { eligible, sent, failed, remaining, quotaReached }.
export async function notifySubscribers(poll, { take = () => true } = {}) {
  const candidates = await pending(poll);
  let sent = 0;
  let failed = 0;
  let quotaReached = false;
  for (const voterId of candidates) {
    const token = newToken();
    let done;
    try {
      done = await tx(async (client) => {
        const { rows: p } = await client.query('SELECT status, close_at, title FROM polls WHERE id = $1 FOR SHARE', [poll.id]);
        if (!p[0] || isClosed(p[0])) return 'closed';
        const { rows: v } = await client.query(
          `SELECT pv.rated_option_ids, pv.rated_before_v12, vn.email_enc, vn.notified_option_ids
             FROM poll_voters pv JOIN voter_notifications vn ON vn.voter_id = pv.id
            WHERE pv.id = $1 FOR UPDATE OF pv, vn`,
          [voterId]
        );
        if (isClosed(p[0])) return 'closed'; // échéance passée pendant l'attente du verrou
        if (!v[0]) return 'skip';
        const missing = await missingOptions(poll.id, v[0], client);
        const notified = new Set(v[0].notified_option_ids);
        const fresh = missing.filter((o) => !notified.has(o.id));
        if (!fresh.length) return 'skip';
        const email = openEmail(v[0].email_enc);
        if (!email) throw new Error('adresse illisible');
        if (!take(1)) return 'quota';
        // Lien supplémentaire : l'ancien lien du votant reste valable.
        await client.query('INSERT INTO voter_extra_tokens (token_hash, voter_id) VALUES ($1, $2)', [hashToken(token), voterId]);
        await client.query(
          `UPDATE voter_notifications
              SET notified_option_ids = ARRAY(SELECT DISTINCT unnest(notified_option_ids || $1::uuid[]))
            WHERE voter_id = $2`,
          [fresh.map((o) => o.id), voterId]
        );
        await sendNewOptionsNotice({
          to: email, pollTitle: p[0].title, labels: missing.map((o) => o.label || '(image)'),
          url: ballotUrl(poll.id, token),
        });
        return 'sent';
      });
    } catch (err) {
      console.error('Avis de nouveau choix non envoyé :', err.code || err.name, err.responseCode || '');
      failed += 1;
      continue;
    }
    if (done === 'sent') sent += 1;
    if (done === 'quota') quotaReached = true;
    if (done === 'closed' || done === 'quota') break;
  }
  return { eligible: candidates.length, sent, failed, remaining: await pendingCount(poll), quotaReached };
}

// Effacement des adresses des scrutins clos (statut ou date de clôture passée).
export async function purgeClosedSubscriptions() {
  const { rowCount } = await query(
    `DELETE FROM voter_notifications vn USING polls p
      WHERE p.id = vn.poll_id AND (p.status = 'closed' OR (p.close_at IS NOT NULL AND p.close_at <= now()))`
  );
  return rowCount;
}
