// Inscription des votants par email et envoi de leur lien personnel.
// Utilisé par la page de vote (demande du votant) et par l'API (invitations).
import { query } from '../db.js';
import { config } from '../config.js';
import { hashEmail } from '../auth.js';
import { newToken, hashToken, sealWithToken } from '../tokens.js';
import { sendMagicLink } from '../mailer.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function normalizeEmail(raw) {
  const email = String(raw ?? '').trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

export const ballotUrl = (pollId, token) => `${config.baseUrl}/vote/${pollId}/ballot/${token}`;
export const resultsUrl = (pollId, token) => `${config.baseUrl}/vote/${pollId}/results/${token}`;

// Inscrit (ou réinscrit) un votant et lui envoie un nouveau lien, qui remplace
// le précédent : la base n'en garde que l'empreinte et ne peut pas le renvoyer.
//
// Scrutin nominatif : email et nom en clair (vote assumé non secret).
// Scrutin secret : l'email n'est stocké que chiffré avec le jeton du votant,
// le temps d'envoyer la confirmation de vote, puis effacé.
export async function sendVoterLink(poll, email, name = '') {
  const token = newToken();
  const displayName = poll.is_nominative ? (String(name || '').trim().slice(0, 120) || null) : null;
  await query(
    `INSERT INTO poll_voters (poll_id, email_hash, token_hash, email, email_sealed, display_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (poll_id, email_hash) DO UPDATE SET
       token_hash   = EXCLUDED.token_hash,
       email        = CASE WHEN poll_voters.voted_at IS NULL THEN EXCLUDED.email ELSE poll_voters.email END,
       email_sealed = CASE WHEN poll_voters.voted_at IS NULL THEN EXCLUDED.email_sealed END,
       display_name = CASE WHEN poll_voters.voted_at IS NULL THEN EXCLUDED.display_name ELSE poll_voters.display_name END`,
    [
      poll.id, hashEmail(email), hashToken(token),
      poll.is_nominative ? email : null,
      poll.is_nominative ? null : sealWithToken(token, email),
      displayName,
    ]
  );
  await sendMagicLink({ to: email, pollTitle: poll.title, url: ballotUrl(poll.id, token) });
}
