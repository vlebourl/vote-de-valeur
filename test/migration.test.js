// Vérifie qu'une base créée avec l'ancien schéma est migrée sans casser les
// liens déjà envoyés et sans laisser d'identité en clair en scrutin secret.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';
import pool from '../src/db.js';
import { hashToken } from '../src/tokens.js';

const legacySql = readFileSync(new URL('./fixtures/legacy-schema.sql', import.meta.url), 'utf8');
const currentSql = readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8');
const dbName = `vdv_legacy_${crypto.randomBytes(4).toString('hex')}`;
let client;

after(async () => {
  await client?.end();
  await pool.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await pool.end();
});

test('migration d\'une base existante', async () => {
  await pool.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${dbName}`;
  client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  await client.query(legacySql);

  const { rows: [user] } = await client.query(
    "INSERT INTO users (email, password_hash) VALUES ('org@test.local', 'x') RETURNING id");
  const { rows: [secret] } = await client.query(
    "INSERT INTO polls (owner_id, title) VALUES ($1, 'secret') RETURNING id", [user.id]);
  const { rows: [nominative] } = await client.query(
    "INSERT INTO polls (owner_id, title, is_nominative) VALUES ($1, 'nominatif', true) RETURNING id", [user.id]);

  const secretToken = 'jeton-secret-0123456789abcdefghij';
  const { rows: [secretVoter] } = await client.query(
    `INSERT INTO poll_voters (poll_id, email_hash, magic_token, email, verified_at, voted_at)
     VALUES ($1, 'h1', $2, 'alice@test.local', now(), now()) RETURNING id`, [secret.id, secretToken]);
  await client.query('INSERT INTO ballots (poll_id) VALUES ($1)', [secret.id]);
  const { rows: [legacyOption] } = await client.query(
    "INSERT INTO options (poll_id, label) VALUES ($1, 'Ancienne') RETURNING id", [secret.id]);

  const { rows: [nomVoter] } = await client.query(
    `INSERT INTO poll_voters (poll_id, email_hash, magic_token, email, display_name, voted_at)
     VALUES ($1, 'h2', 'jeton-nominatif-0123456789abcdef', 'bob@test.local', 'Bob', now()) RETURNING id`, [nominative.id]);
  await client.query('INSERT INTO ballots (poll_id, voter_id) VALUES ($1, $2)', [nominative.id, nomVoter.id]);

  await client.query(currentSql);
  await client.query(currentSql); // idempotente

  const voter = (await client.query('SELECT * FROM poll_voters WHERE id = $1', [secretVoter.id])).rows[0];
  assert.equal(voter.token_hash, hashToken(secretToken), 'les liens déjà envoyés restent valables');
  assert.ok(!('magic_token' in voter));
  assert.equal(voter.email, null);
  assert.equal(voter.voted_at.toISOString().slice(11), '00:00:00.000Z');
  assert.equal(voter.rated_option_ids, null, 'vote antérieur : options notées inconnues');
  // Seules les options créées après la migration seront proposées à ces votants.
  const opt = (await client.query('SELECT created_at FROM options WHERE id = $1', [legacyOption.id])).rows[0];
  assert.equal(opt.created_at, null);
  const { rows: [fresh] } = await client.query(
    "INSERT INTO options (poll_id, label) VALUES ($1, 'Nouvelle') RETURNING created_at", [secret.id]);
  assert.ok(fresh.created_at, 'nouvelle option datée');

  const secretBallot = (await client.query('SELECT created_at FROM ballots WHERE poll_id = $1', [secret.id])).rows[0];
  assert.equal(secretBallot.created_at, null);

  const nom = (await client.query('SELECT email, display_name FROM poll_voters WHERE id = $1', [nomVoter.id])).rows[0];
  assert.deepEqual(nom, { email: 'bob@test.local', display_name: 'Bob' }, 'scrutin nominatif inchangé');
  const nomBallot = (await client.query('SELECT created_at FROM ballots WHERE poll_id = $1', [nominative.id])).rows[0];
  assert.ok(nomBallot.created_at);
});
