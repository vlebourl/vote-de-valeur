import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pool from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  console.log('Application du schéma...');
  await pool.query(sql);
  console.log('✅ Migration terminée.');
  await pool.end();
}

main().catch((err) => {
  console.error('❌ Migration échouée :', err);
  process.exit(1);
});
