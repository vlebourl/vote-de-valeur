// Crée un fichier .env à partir de .env.example en générant les secrets.
// Ne remplace jamais un .env existant.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';

if (existsSync('.env')) {
  console.log('.env existe déjà : rien n\'a été modifié.');
  process.exit(0);
}
const generated = ['JWT_SECRET', 'EMAIL_HASH_SECRET', 'POSTGRES_PASSWORD'];
const content = readFileSync('.env.example', 'utf8').replace(
  new RegExp(`^(${generated.join('|')})=$`, 'gm'),
  (line, key) => `${key}=${crypto.randomBytes(32).toString('hex')}`
);
writeFileSync('.env', content, { mode: 0o600 });
console.log(`.env créé (secrets générés : ${generated.join(', ')}).`);
