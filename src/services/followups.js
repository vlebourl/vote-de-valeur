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
export async function missingOptions(pollId, ratedIds, client = { query }) {
  if (!ratedIds) return [];
  const { rows } = await client.query(
    `SELECT id, label, description, position, (image_data IS NOT NULL) AS has_image
       FROM options WHERE poll_id = $1 AND NOT (id = ANY($2::uuid[])) ORDER BY position`,
    [pollId, ratedIds]
  );
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

// Votants abonnés à prévenir : ceux qui ont des choix non notés dont ils n'ont
// pas encore été avertis.
async function pending(poll) {
  const { rows: options } = await query('SELECT id, label FROM options WHERE poll_id = $1 ORDER BY position', [poll.id]);
  const { rows } = await query(
    `SELECT vn.voter_id, vn.email_enc, vn.notified_option_ids, pv.rated_option_ids
       FROM voter_notifications vn JOIN poll_voters pv ON pv.id = vn.voter_id
      WHERE vn.poll_id = $1 AND pv.voted_at IS NOT NULL AND pv.rated_option_ids IS NOT NULL`,
    [poll.id]
  );
  return rows.map((r) => {
    const rated = new Set(r.rated_option_ids);
    const notified = new Set(r.notified_option_ids);
    const missing = options.filter((o) => !rated.has(o.id));
    return { ...r, missing, fresh: missing.filter((o) => !notified.has(o.id)) };
  }).filter((r) => r.fresh.length > 0);
}

export async function pendingCount(poll) {
  return (await pending(poll)).length;
}

export async function subscriberCount(poll) {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM voter_notifications WHERE poll_id = $1', [poll.id]);
  return rows[0].n;
}

// Prévient les abonnés concernés : nouveau lien personnel (il remplace le
// précédent, y compris le lien des résultats) et liste des nouveaux choix.
// Le remplacement du lien n'est validé que si l'email part.
// Renvoie des nombres seulement : { eligible, sent, failed }.
export async function notifySubscribers(poll, { max = Infinity } = {}) {
  if (isClosed(poll)) return { eligible: 0, sent: 0, failed: 0, closed: true };
  const list = await pending(poll);
  let sent = 0;
  let failed = 0;
  for (const r of list.slice(0, max)) {
    const email = openEmail(r.email_enc);
    if (!email) { failed += 1; continue; }
    const token = newToken();
    try {
      await tx(async (client) => {
        await client.query('UPDATE poll_voters SET token_hash = $1 WHERE id = $2', [hashToken(token), r.voter_id]);
        await client.query(
          `UPDATE voter_notifications
              SET notified_option_ids = ARRAY(SELECT DISTINCT unnest(notified_option_ids || $1::uuid[]))
            WHERE voter_id = $2`,
          [r.fresh.map((o) => o.id), r.voter_id]
        );
        await sendNewOptionsNotice({
          to: email, pollTitle: poll.title, labels: r.missing.map((o) => o.label || '(image)'),
          url: ballotUrl(poll.id, token),
        });
      });
      sent += 1;
    } catch (err) {
      console.error('Avis de nouveau choix non envoyé :', err.code || err.name, err.responseCode || '');
      failed += 1;
    }
  }
  return { eligible: list.length, sent, failed };
}

// Effacement des adresses des scrutins clos (statut ou date de clôture passée).
export async function purgeClosedSubscriptions() {
  const { rowCount } = await query(
    `DELETE FROM voter_notifications vn USING polls p
      WHERE p.id = vn.poll_id AND (p.status = 'closed' OR (p.close_at IS NOT NULL AND p.close_at <= now()))`
  );
  return rowCount;
}
