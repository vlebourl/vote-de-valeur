import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankOptions } from '../src/results.js';
import { safeNext, isUuid } from '../src/security.js';
import { newToken, hashToken, sealWithToken, openWithToken } from '../src/tokens.js';
import { readSecret } from '../src/config.js';

test('rankOptions : classement standard « 1224 » avec ex æquo', () => {
  const ranked = rankOptions([{ total: 5 }, { total: 3 }, { total: 3 }, { total: -1 }]);
  assert.deepEqual(ranked.map((o) => o.rank), [1, 2, 2, 4]);
});

test('rankOptions : toutes les options à égalité partagent le rang 1', () => {
  assert.deepEqual(rankOptions([{ total: 0 }, { total: 0 }]).map((o) => o.rank), [1, 1]);
});

test('safeNext : accepte un chemin local, refuse les autres origines', () => {
  assert.equal(safeNext('/polls/new'), '/polls/new');
  assert.equal(safeNext('//evil.example'), '/dashboard');
  assert.equal(safeNext('/\\evil.example'), '/dashboard');
  assert.equal(safeNext('https://evil.example'), '/dashboard');
  assert.equal(safeNext(undefined), '/dashboard');
});

test('isUuid', () => {
  assert.ok(isUuid('9e5ed607-79b8-4cf5-ae9b-19e409bad1c5'));
  assert.ok(!isUuid('xyz'));
  assert.ok(!isUuid("9e5ed607-79b8-4cf5-ae9b-19e409bad1c5' OR 1=1"));
});

test('jetons : empreinte stable, chiffrement lisible seulement avec le bon jeton', () => {
  const token = newToken();
  assert.equal(token.length, 32);
  assert.equal(hashToken(token), hashToken(token));
  assert.notEqual(hashToken(token), token);
  const sealed = sealWithToken(token, 'alice@example.org');
  assert.ok(!sealed.includes('alice'));
  assert.equal(openWithToken(token, sealed), 'alice@example.org');
  assert.equal(openWithToken(newToken(), sealed), null);
  assert.equal(openWithToken(token, null), null);
});

test('readSecret : refuse en production un secret absent, court ou d\'exemple', () => {
  const strong = 'a'.repeat(64);
  assert.equal(readSecret('S', { S: strong }, true), strong);
  assert.throws(() => readSecret('S', {}, true), /openssl rand/);
  assert.throws(() => readSecret('S', { S: 'court' }, true));
  assert.throws(() => readSecret('S', { S: 'change-me-please-with-a-long-random-string' }, true));
  assert.match(readSecret('S', {}, false), /^dev-insecure/);
});

test('dates : heure de Paris convertie en UTC, été comme hiver', async () => {
  const { zonedLocalToUtc, parseCloseAt, formatDateTime } = await import('../src/dates.js');
  assert.equal(zonedLocalToUtc('2026-12-15T18:00', 'Europe/Paris').toISOString(), '2026-12-15T17:00:00.000Z');
  assert.equal(zonedLocalToUtc('2026-07-15T18:00', 'Europe/Paris').toISOString(), '2026-07-15T16:00:00.000Z');
  // Lendemain du passage à l'heure d'été (29 mars 2026, 2 h → 3 h).
  assert.equal(zonedLocalToUtc('2026-03-29T12:00', 'Europe/Paris').toISOString(), '2026-03-29T10:00:00.000Z');
  assert.equal(zonedLocalToUtc('pas une date', 'Europe/Paris'), null);

  // L'instant calculé par le navigateur est prioritaire.
  assert.equal(parseCloseAt({ close_at: '2026-12-15T18:00', close_at_utc: '2026-12-15T23:00:00.000Z' }, 'Europe/Paris')
    .toISOString(), '2026-12-15T23:00:00.000Z');
  assert.equal(parseCloseAt({ close_at: '' }, 'Europe/Paris'), null);
  assert.equal(parseCloseAt({ close_at: 'n\'importe quoi' }, 'Europe/Paris'), undefined);

  assert.equal(formatDateTime(new Date('2026-07-15T16:00:00Z'), 'Europe/Paris'), '15/07 à 18:00');
});

test('emails : forme canonique des alias', async () => {
  const { canonicalEmail } = await import('../src/services/voters.js');
  assert.equal(canonicalEmail('jean.dupont+vote@gmail.com'), 'jeandupont@gmail.com');
  assert.equal(canonicalEmail('jean.dupont@googlemail.com'), 'jeandupont@gmail.com');
  assert.equal(canonicalEmail('jean.dupont+x@exemple.fr'), 'jean.dupont@exemple.fr');
  assert.equal(canonicalEmail('+abc@exemple.fr'), '+abc@exemple.fr');
});
