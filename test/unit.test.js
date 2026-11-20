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
