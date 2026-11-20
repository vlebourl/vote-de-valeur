// Jetons personnels des votants (liens magiques).
//
// - La base ne stocke que le SHA-256 du jeton : une fuite de la base ne donne
//   accès à aucun bulletin ni permalien.
// - En scrutin secret, l'email du votant n'est jamais stocké en clair. Il est
//   chiffré (AES-256-GCM) avec une clé dérivée du jeton, que seul le votant
//   détient (dans son lien). Le serveur ne peut donc le relire qu'au moment où
//   le votant présente son lien pour voter, envoie la confirmation, puis
//   efface la valeur chiffrée.
import crypto from 'node:crypto';

export function newToken() {
  return crypto.randomBytes(24).toString('base64url'); // 32 caractères, 192 bits
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function keyFromToken(token) {
  return Buffer.from(crypto.hkdfSync('sha256', String(token), 'vote-de-valeur', 'voter-email-v1', 32));
}

export function sealWithToken(token, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromToken(token), iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

// Renvoie le texte déchiffré, ou null si le jeton ne correspond pas.
export function openWithToken(token, sealed) {
  if (!sealed) return null;
  try {
    const raw = Buffer.from(sealed, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromToken(token), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
