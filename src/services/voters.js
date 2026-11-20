// Inscription des votants par email et envoi de leur lien personnel.
// Utilisé par la page de vote (demande du votant) et par l'API (invitations).
import { tx } from '../db.js';
import { config } from '../config.js';
import { hashEmail } from '../auth.js';
import { newToken, hashToken, sealWithToken } from '../tokens.js';
import { sendMagicLink } from '../mailer.js';

// Adresse « nue » uniquement (ni nom d'affichage, ni commentaire, ni chevrons) :
// la même valeur sert au HMAC d'unicité, à la déduplication et à l'envoi SMTP,
// ce qui empêche deux écritures différentes de désigner la même boîte.
const LOCAL = "[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*";
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const EMAIL = new RegExp(`^${LOCAL}@${LABEL}(?:\\.${LABEL})+$`);

export function normalizeEmail(raw) {
  const email = String(raw ?? '').trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

export const ballotUrl = (pollId, token) => `${config.baseUrl}/vote/${pollId}/ballot/${token}`;
export const resultsUrl = (pollId, token) => `${config.baseUrl}/vote/${pollId}/results/${token}`;

// Inscrit (ou réinscrit) un votant et lui envoie un nouveau lien, qui remplace
// le précédent : la base n'en garde que l'empreinte et ne peut pas le renvoyer.
// Le remplacement n'est validé que si l'email part : en cas d'échec d'envoi,
// l'ancien lien reste valable.
//
// Scrutin nominatif : email et nom en clair (vote assumé non secret).
// Scrutin secret : l'email n'est stocké que chiffré avec le jeton du votant,
// le temps d'envoyer la confirmation de vote, puis effacé.
//
// options.keepVoted : ne rien faire pour une personne qui a déjà voté (son
// permalien de résultats reste valable) ; renvoie alors 'already_voted'.
export async function sendVoterLink(poll, email, name = '', { keepVoted = false } = {}) {
  const token = newToken();
  const displayName = poll.is_nominative ? (String(name || '').trim().slice(0, 120) || null) : null;
  return tx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO poll_voters (poll_id, email_hash, token_hash, email, email_sealed, display_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (poll_id, email_hash) DO UPDATE SET
         token_hash   = EXCLUDED.token_hash,
         email        = CASE WHEN poll_voters.voted_at IS NULL THEN EXCLUDED.email ELSE poll_voters.email END,
         email_sealed = CASE WHEN poll_voters.voted_at IS NULL THEN EXCLUDED.email_sealed END,
         display_name = CASE WHEN poll_voters.voted_at IS NULL THEN EXCLUDED.display_name ELSE poll_voters.display_name END
       WHERE NOT $7 OR poll_voters.voted_at IS NULL
       RETURNING id`,
      [
        poll.id, hashEmail(email), hashToken(token),
        poll.is_nominative ? email : null,
        poll.is_nominative ? null : sealWithToken(token, email),
        displayName,
        keepVoted,
      ]
    );
    if (!rows[0]) return 'already_voted';
    // Envoi dans la transaction : un échec annule le remplacement du lien.
    await sendMagicLink({ to: email, pollTitle: poll.title, url: ballotUrl(poll.id, token) });
    return 'sent';
  });
}
