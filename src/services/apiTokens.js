// Jetons d'API des organisateurs. Format « vdv_<43 caractères> » : le préfixe
// permet aux outils de détection de secrets de les reconnaître. Seule leur
// empreinte est stockée ; la valeur n'est montrée qu'une fois, à la création.
import crypto from 'node:crypto';
import { query } from '../db.js';
import { hashToken } from '../tokens.js';
import { invalid, conflict } from './errors.js';

export const MAX_TOKENS_PER_USER = 20;
const FORMAT = /^vdv_[A-Za-z0-9_-]{43}$/;

export async function createApiToken(userId, { name, scope }) {
  const label = String(name ?? '').trim();
  if (!label || label.length > 100) throw invalid('Nom du jeton : 1 à 100 caractères.');
  if (scope !== 'read' && scope !== 'write') throw invalid('Portée : « read » ou « write ».');
  const { rows: count } = await query(
    'SELECT COUNT(*)::int AS n FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL', [userId]
  );
  if (count[0].n >= MAX_TOKENS_PER_USER) throw conflict(`${MAX_TOKENS_PER_USER} jetons actifs au maximum.`);

  const token = `vdv_${crypto.randomBytes(32).toString('base64url')}`;
  const { rows } = await query(
    `INSERT INTO api_tokens (user_id, name, token_hash, token_prefix, scope)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, token_prefix, scope, created_at`,
    [userId, label, hashToken(token), token.slice(0, 10), scope]
  );
  return { token, record: rows[0] };
}

export async function listApiTokens(userId) {
  const { rows } = await query(
    `SELECT id, name, token_prefix, scope, created_at, last_used_at
       FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

export async function revokeApiToken(userId, tokenId) {
  const { rowCount } = await query(
    'UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
    [tokenId, userId]
  );
  return rowCount > 0;
}

// Jeton actif → { tokenId, scope, user: { id, email } }, sinon null.
export async function authenticateApiToken(token) {
  if (typeof token !== 'string' || !FORMAT.test(token)) return null;
  const { rows } = await query(
    `SELECT t.id, t.scope, t.last_used_at, u.id AS user_id, u.email
       FROM api_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL`,
    [hashToken(token)]
  );
  const row = rows[0];
  if (!row) return null;
  // Date de dernière utilisation, mise à jour au plus une fois par minute.
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60_000) {
    await query('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [row.id]);
  }
  return { tokenId: row.id, scope: row.scope, user: { id: row.user_id, email: row.email } };
}
