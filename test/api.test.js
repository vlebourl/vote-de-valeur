import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import SwaggerParser from '@apidevtools/swagger-parser';
import pool from '../src/db.js';
import { openapi } from '../src/api/openapi.js';
import { devFailures } from '../src/mailer.js';
import { newApp, organizer, submitBallot, lastMail, pathOf, unique, query } from './helpers.js';

after(() => pool.end());
const app = newApp();

// Crée un jeton depuis la page « API » de l'organisateur (session).
async function apiToken(agent, scope = 'write') {
  const res = await agent.post('/account/api/tokens').type('form').send({ name: `jeton ${scope}`, scope }).expect(201);
  return res.text.match(/value="(vdv_[A-Za-z0-9_-]{43})"/)[1];
}

async function client(scope = 'write') {
  const org = await organizer(app);
  const token = await apiToken(org.agent, scope);
  const call = (method, path) => request(app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
  return { ...org, token, call };
}

const newPoll = (call, extra = {}) => call('post', '/polls')
  .send({ title: 'Destination', options: ['Annecy', 'Lyon', { label: 'Bordeaux', description: 'Océan' }], min_ballots_for_results: 0, ...extra });

describe('authentification et jetons', () => {
  test('sans jeton, jeton mal formé ou cookie de session seul : 401', async () => {
    const res = await request(app).get('/api/v1/polls').expect(401);
    assert.equal(res.body.error.code, 'unauthorized');
    assert.match(res.headers['www-authenticate'], /Bearer/);
    await request(app).get('/api/v1/polls').set('Authorization', 'Bearer vdv_faux').expect(401);
    const { agent } = await organizer(app);
    await agent.get('/api/v1/polls').expect(401); // l'API n'accepte jamais le cookie
  });

  test('page API : création (affiché une fois, seule l\'empreinte en base), liste, révocation', async () => {
    const { agent, call, token } = await client();
    const me = await call('get', '/me').expect(200);
    assert.equal(me.body.token.scope, 'write');

    const stored = await query('SELECT token_hash, token_prefix FROM api_tokens WHERE user_id = $1', [me.body.user.id]);
    assert.ok(!JSON.stringify(stored.rows).includes(token));
    assert.equal(stored.rows[0].token_prefix, token.slice(0, 10));

    const page = await agent.get('/account/api').expect(200);
    assert.ok(page.text.includes(token.slice(0, 10)));
    assert.ok(!page.text.includes(token), 'le jeton complet n\'est plus jamais affiché');

    const id = page.text.match(/\/account\/api\/tokens\/([0-9a-f-]{36})\/revoke/)[1];
    await agent.post(`/account/api/tokens/${id}/revoke`).expect(302);
    await call('get', '/me').expect(401);
  });

  test('jeton en lecture seule : lecture permise, écriture refusée', async () => {
    const { call } = await client('read');
    await call('get', '/polls').expect(200);
    const res = await newPoll(call).expect(403);
    assert.equal(res.body.error.code, 'insufficient_scope');
  });

  test('le scrutin d\'un autre organisateur est introuvable', async () => {
    const alice = await client();
    const bob = await client();
    const { body } = await newPoll(alice.call).expect(201);
    await bob.call('get', `/polls/${body.id}`).expect(404);
    await bob.call('delete', `/polls/${body.id}`).expect(404);
    await alice.call('get', `/polls/${body.id}`).expect(200);
  });

  test('une requête d\'une autre origine passe (pas de cookie, pas de CSRF possible)', async () => {
    const { call } = await client();
    await newPoll(call).set('Origin', 'https://autre.example').expect(201);
  });
});

describe('scrutins', () => {
  test('création, lecture, liste', async () => {
    const { call } = await client();
    const res = await newPoll(call, { close_at: '2026-12-15T18:00:00+01:00', is_nominative: true }).expect(201);
    assert.equal(res.headers.location, `http://vote.test/api/v1/polls/${res.body.id}`);
    assert.equal(res.body.close_at, '2026-12-15T17:00:00.000Z');
    assert.equal(res.body.vote_url, `http://vote.test/vote/${res.body.id}`);
    assert.equal(res.body.is_nominative, true);
    assert.deepEqual(res.body.options.map((o) => o.label), ['Annecy', 'Lyon', 'Bordeaux']);
    assert.equal(res.body.options[2].description, 'Océan');

    const detail = await call('get', `/polls/${res.body.id}`).expect(200);
    assert.deepEqual(detail.body.participation, { requested: 0, voted: 0 });
    const list = await call('get', '/polls').expect(200);
    assert.equal(list.body.polls[0].id, res.body.id);
    assert.equal(list.body.polls[0].ballot_count, 0);
  });

  test('scrutin privé : mot de passe exigé, puis demandé aux votants', async () => {
    const { call } = await client();
    await newPoll(call, { is_private: true }).expect(400);
    const { body } = await newPoll(call, { is_private: true, password: 'sesame-ouvre-toi' }).expect(201);
    const page = await request(app).get(`/vote/${body.id}`).expect(200);
    assert.match(page.text, /name="password"/);
  });

  test('validation : erreurs explicites', async () => {
    const { call } = await client();
    const cases = [
      [{ options: ['A', 'B'] }, /title/],
      [{ title: 'T', options: ['Seule'] }, /2 options/],
      [{ title: 'T', options: ['A', 'B'], couleur: 'rouge' }, /couleur/],
      [{ title: 'T', options: ['A', 'B'], close_at: '15/12/2026' }, /ISO 8601/],
      [{ title: 'T', options: ['A', 'B'], close_at: '2026-12-15T18:00' }, /ISO 8601/],
      [{ title: 'T', options: ['A', 'B'], close_at: '2027-02-30T18:00:00Z' }, /ISO 8601/],
      [{ title: 'T', options: ['A', 'B'], close_at: '2027-02-10T24:30:00Z' }, /ISO 8601/],
      [{ title: 'T', options: ['A', 'B'], is_private: 'oui' }, /booléen/],
      [{ title: 'T', options: ['A', 'B'], auth_mode: 'sms' }, /auth_mode/],
      [{ title: 'x'.repeat(201), options: ['A', 'B'] }, /200 caractères/],
      [{ title: 'T', options: Array.from({ length: 51 }, (_, i) => `O${i}`) }, /50 options/],
    ];
    for (const [payload, message] of cases) {
      const res = await call('post', '/polls').send(payload).expect(400);
      assert.equal(res.body.error.code, 'validation_error');
      assert.match(res.body.error.message, message);
    }
    const bad = await call('post', '/polls').set('Content-Type', 'application/json').send('{"title":').expect(400);
    assert.equal(bad.body.error.code, 'invalid_json');
    const form = await call('post', '/polls').type('form').send({ title: 'T' }).expect(415);
    assert.equal(form.body.error.code, 'unsupported_media_type');
  });

  test('modification, clôture, retrait de la date, suppression', async () => {
    const { call } = await client();
    const { body } = await newPoll(call, { close_at: '2026-12-15T18:00:00Z' }).expect(201);
    const upd = await call('patch', `/polls/${body.id}`).send({ title: 'Nouveau titre', status: 'closed', close_at: null }).expect(200);
    assert.equal(upd.body.title, 'Nouveau titre');
    assert.equal(upd.body.status, 'closed');
    assert.equal(upd.body.is_closed, true);
    assert.equal(upd.body.close_at, null);
    await call('patch', `/polls/${body.id}`).send({ title: '' }).expect(400);
    await call('patch', `/polls/${body.id}`).send({ status: 'paused' }).expect(400);
    await call('delete', `/polls/${body.id}`).expect(204);
    await call('get', `/polls/${body.id}`).expect(404);
  });

  test('identifiant invalide et route inconnue', async () => {
    const { call } = await client();
    assert.equal((await call('get', '/polls/xyz').expect(404)).body.error.code, 'not_found');
    assert.equal((await call('get', '/nimporte').expect(404)).body.error.code, 'route_not_found');
  });
});

describe('options', () => {
  // PNG 1×1 transparent.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

  test('ajout (JSON et image), modification, suppression avec minimum de 2', async () => {
    const { call } = await client();
    const { body: poll } = await call('post', '/polls').send({ title: 'T', options: ['A', 'B'] }).expect(201);

    const added = await call('post', `/polls/${poll.id}/options`).send({ label: 'C', description: 'troisième' }).expect(201);
    assert.equal(added.body.position, 2);

    const img = await call('post', `/polls/${poll.id}/options`)
      .field('label', 'Avec image').attach('image', png, { filename: 'p.png', contentType: 'image/png' }).expect(201);
    assert.equal(img.body.has_image, true);
    const served = await request(app).get(pathOf(img.body.image_url)).expect(200);
    assert.equal(served.headers['content-type'], 'image/png');

    await call('post', `/polls/${poll.id}/options`)
      .attach('image', Buffer.from('pas une image'), { filename: 'x.txt', contentType: 'text/plain' }).expect(400);
    await call('post', `/polls/${poll.id}/options`).send({}).expect(400);

    // Image ajoutée à une option existante (texte seul au départ).
    const withImage = await call('put', `/polls/${poll.id}/options/${added.body.id}/image`)
      .attach('image', png, { filename: 'p.png', contentType: 'image/png' }).expect(200);
    assert.equal(withImage.body.has_image, true);
    assert.equal(withImage.body.label, 'C');
    await call('put', `/polls/${poll.id}/options/${added.body.id}/image`).send({}).expect(415);
    await call('put', `/polls/${poll.id}/options/${added.body.id}/image`)
      .attach('image', Buffer.from('texte'), { filename: 't.txt', contentType: 'text/plain' }).expect(400);

    // Modifications simultanées de champs distincts : aucune n'est perdue.
    await Promise.all([
      call('patch', `/polls/${poll.id}/options/${added.body.id}`).send({ label: 'C bis' }).expect(200),
      call('patch', `/polls/${poll.id}/options/${added.body.id}`).send({ description: 'troisième' }).expect(200),
    ]);
    const textOnly = poll.options.find((o) => o.label === 'A').id;
    const empty = await call('patch', `/polls/${poll.id}/options/${textOnly}`).send({ label: '' }).expect(400);
    assert.match(empty.body.error.message, /intitulé/);
    const edited = await call('patch', `/polls/${poll.id}/options/${added.body.id}`).send({}).expect(200);
    assert.equal(edited.body.label, 'C bis');
    assert.equal(edited.body.description, 'troisième', 'champ absent = inchangé');

    const ids = (await call('get', `/polls/${poll.id}`)).body.options.map((o) => o.id);
    await call('delete', `/polls/${poll.id}/options/${ids[0]}`).expect(204);
    await call('delete', `/polls/${poll.id}/options/${ids[1]}`).expect(204);
    const last = await call('delete', `/polls/${poll.id}/options/${ids[2]}`).expect(409);
    assert.equal(last.body.error.code, 'conflict');
    await call('delete', `/polls/${poll.id}/options/${ids[0]}`).expect(404);
  });
});

describe('votants et résultats', () => {
  test('invitations : liens envoyés, erreurs détaillées, puis vote et résultats', async () => {
    const { call } = await client();
    const { body: poll } = await newPoll(call).expect(201);
    const alice = `${unique('alice')}@test.local`;
    const bob = `${unique('bob')}@test.local`;

    const res = await call('post', `/polls/${poll.id}/invitations`)
      .send({ recipients: [alice, { email: bob, name: 'Bob' }, 'pas-un-email', alice.toUpperCase()] }).expect(200);
    assert.deepEqual(res.body.sent, [alice, bob]);
    assert.deepEqual(res.body.rejected.map((r) => r.reason), ['invalid_email', 'duplicate']);

    // Scrutin secret : l'email invité n'est pas stocké en clair.
    const stored = await query('SELECT email, display_name FROM poll_voters WHERE poll_id = $1', [poll.id]);
    assert.ok(stored.rows.every((r) => r.email === null && r.display_name === null));

    await submitBallot(app, pathOf(lastMail(alice, 'magic-link').url), { Annecy: 2, Lyon: -1 });
    await submitBallot(app, pathOf(lastMail(bob, 'magic-link').url), { Annecy: 1, Bordeaux: 1 });

    const results = await call('get', `/polls/${poll.id}/results`).expect(200);
    assert.equal(results.body.ballot_count, 2);
    assert.deepEqual(results.body.participation, { requested: 2, voted: 2 });
    assert.deepEqual(results.body.options.map((o) => [o.label, o.total, o.rank]),
      [['Annecy', 3, 1], ['Bordeaux', 1, 2], ['Lyon', -1, 3]]);

    const secret = await call('get', `/polls/${poll.id}/participants`).expect(409);
    assert.equal(secret.body.error.code, 'conflict');
  });

  test('participants d\'un scrutin nominatif', async () => {
    const { call } = await client();
    const { body: poll } = await newPoll(call, { is_nominative: true }).expect(201);
    const carol = `${unique('carol')}@test.local`;
    await call('post', `/polls/${poll.id}/invitations`).send({ recipients: [{ email: carol, name: 'Carol' }] }).expect(200);
    await submitBallot(app, pathOf(lastMail(carol, 'magic-link').url), { Lyon: 2 });
    const res = await call('get', `/polls/${poll.id}/participants`).expect(200);
    assert.equal(res.body.participants.length, 1);
    const p = res.body.participants[0];
    assert.equal(p.email, carol);
    assert.equal(p.name, 'Carol');
    assert.equal(p.voted, true);
    const lyon = poll.options.find((o) => o.label === 'Lyon').id;
    assert.equal(p.scores[lyon], 2);
  });

  test('invitations refusées : mode « nom », vote clos, liste vide ou trop longue', async () => {
    const { call } = await client();
    const { body: byName } = await newPoll(call, { auth_mode: 'name' }).expect(201);
    await call('post', `/polls/${byName.id}/invitations`).send({ recipients: ['a@test.local'] }).expect(409);

    const { body: poll } = await newPoll(call).expect(201);
    await call('post', `/polls/${poll.id}/invitations`).send({ recipients: [] }).expect(400);
    const many = Array.from({ length: 101 }, (_, i) => `v${i}@test.local`);
    await call('post', `/polls/${poll.id}/invitations`).send({ recipients: many }).expect(400);
    const none = await call('post', `/polls/${poll.id}/invitations`).send({ recipients: ['invalide'] }).expect(422);
    assert.deepEqual(none.body.sent, []);

    await call('patch', `/polls/${poll.id}`).send({ status: 'closed' }).expect(200);
    await call('post', `/polls/${poll.id}/invitations`).send({ recipients: ['a@test.local'] }).expect(409);
  });

  test('quota d\'invitations par organisateur, tous jetons confondus', async () => {
    const limited = newApp({ rateLimits: true });
    const org = await organizer(limited);
    const tokens = [];
    for (const name of ['un', 'deux']) {
      const res = await org.agent.post('/account/api/tokens').type('form').send({ name, scope: 'write' }).expect(201);
      tokens.push(res.text.match(/value="(vdv_[A-Za-z0-9_-]{43})"/)[1]);
    }
    const call = (i, m, p) => request(limited)[m](`/api/v1${p}`).set('Authorization', `Bearer ${tokens[i]}`);
    const { body: poll } = await newPoll((m, p) => call(0, m, p)).expect(201);
    const batch = (n) => Array.from({ length: 100 }, (_, i) => `q${n}-${i}@test.local`);
    for (let n = 0; n < 5; n++) {
      await call(n % 2, 'post', `/polls/${poll.id}/invitations`).send({ recipients: batch(n) }).expect(200);
    }
    const over = await call(1, 'post', `/polls/${poll.id}/invitations`).send({ recipients: ['encore@test.local'] }).expect(429);
    assert.equal(over.body.error.code, 'rate_limited');
  });

  test('échec d\'envoi : l\'ancien lien reste valable', async () => {
    const { call } = await client();
    const { body: poll } = await newPoll(call).expect(201);
    const dan = `${unique('dan')}@test.local`;
    await call('post', `/polls/${poll.id}/invitations`).send({ recipients: [dan] }).expect(200);
    const first = pathOf(lastMail(dan, 'magic-link').url);
    devFailures.next = 1;
    const res = await call('post', `/polls/${poll.id}/invitations`).send({ recipients: [dan] }).expect(422);
    assert.deepEqual(res.body.rejected, [{ email: dan, reason: 'send_failed' }]);
    await request(app).get(first).expect(200);
  });

  test('une personne qui a déjà voté n\'est pas relancée et garde son permalien', async () => {
    const { call } = await client();
    const { body: poll } = await newPoll(call).expect(201);
    const eve = `${unique('eve')}@test.local`;
    await call('post', `/polls/${poll.id}/invitations`).send({ recipients: [eve] }).expect(200);
    const ballot = pathOf(lastMail(eve, 'magic-link').url);
    await submitBallot(app, ballot, { Lyon: 1 });
    const permalink = pathOf(lastMail(eve, 'confirmation').permalink);
    const res = await call('post', `/polls/${poll.id}/invitations`).send({ recipients: [eve] }).expect(422);
    assert.deepEqual(res.body.rejected, [{ email: eve, reason: 'already_voted' }]);
    await request(app).get(permalink).expect(200);
  });

  test('alias d\'une même boîte : une seule invitation, un seul votant', async () => {
    const { call } = await client();
    const { body: poll } = await newPoll(call).expect(201);
    const base = unique('alias').replace(/[^a-z0-9]/g, '');
    const res = await call('post', `/polls/${poll.id}/invitations`)
      .send({ recipients: [`${base}@gmail.com`, `${base.slice(0, 3)}.${base.slice(3)}+vote@googlemail.com`, `${base}+x@exemple.fr`, `${base}@exemple.fr`] })
      .expect(200);
    assert.deepEqual(res.body.sent, [`${base}@gmail.com`, `${base}+x@exemple.fr`]);
    assert.deepEqual(res.body.rejected.map((r) => r.reason), ['duplicate', 'duplicate']);
  });

  test('adresses : uniquement des adresses nues', async () => {
    const { call } = await client();
    const { body: poll } = await newPoll(call).expect(201);
    const res = await call('post', `/polls/${poll.id}/invitations`)
      .send({ recipients: ['Alice <alice@test.local>', 'a(x)@test.local', 'a@test.local, b@test.local'] }).expect(422);
    assert.deepEqual(res.body.rejected.map((r) => r.reason), ['invalid_email', 'invalid_email', 'invalid_email']);
  });
});

describe('avis de nouveaux choix', () => {
  test('nombres seulement, jamais d\'adresse', async () => {
    const { call } = await client();
    const { body: poll } = await newPoll(call).expect(201);
    const voter = `${unique('api-avis')}@test.local`;
    await call('post', `/polls/${poll.id}/invitations`).send({ recipients: [voter] }).expect(200);
    await submitBallot(app, pathOf(lastMail(voter, 'magic-link').url), { Lyon: 1 }, { notify: 'on' });
    const none = await call('post', `/polls/${poll.id}/notifications`).send({}).expect(200);
    assert.deepEqual(none.body, { eligible: 0, sent: 0, failed: 0, remaining: 0 });
    await call('post', `/polls/${poll.id}/options`).send({ label: 'Nantes' }).expect(201);
    const res = await call('post', `/polls/${poll.id}/notifications`).send({}).expect(200);
    assert.deepEqual(res.body, { eligible: 1, sent: 1, failed: 0, remaining: 0 });
    assert.ok(!JSON.stringify(res.body).includes(voter));
    assert.deepEqual(lastMail(voter, 'new-options').labels, ['Nantes']);
    await call('post', `/polls/${poll.id}/notifications`).send({ x: 1 }).expect(400);
  });
});

describe('seuil de publication', () => {
  test('défaut à 5, résultats masqués, modifiable, bornes', async () => {
    const { call } = await client();
    const { body: poll } = await call('post', '/polls').send({ title: 'T', options: ['A', 'B'] }).expect(201);
    assert.equal(poll.min_ballots_for_results, 5);
    const voter = `${unique('api-seuil')}@test.local`;
    await call('post', `/polls/${poll.id}/invitations`).send({ recipients: [voter] }).expect(200);
    await submitBallot(app, pathOf(lastMail(voter, 'magic-link').url), { A: 2 });

    const hidden = await call('get', `/polls/${poll.id}/results`).expect(200);
    assert.equal(hidden.body.results_hidden, true);
    assert.equal(hidden.body.ballot_count, 1);
    assert.deepEqual(hidden.body.options, []);

    const upd = await call('patch', `/polls/${poll.id}`).send({ min_ballots_for_results: 1 }).expect(200);
    assert.equal(upd.body.min_ballots_for_results, 1);
    const shown = await call('get', `/polls/${poll.id}/results`).expect(200);
    assert.equal(shown.body.results_hidden, false);
    assert.equal(shown.body.options[0].total, 2);

    await call('patch', `/polls/${poll.id}`).send({ min_ballots_for_results: -1 }).expect(400);
    await call('patch', `/polls/${poll.id}`).send({ min_ballots_for_results: '3' }).expect(400);
    await call('post', '/polls').send({ title: 'T', options: ['A', 'B'], min_ballots_for_results: 10001 }).expect(400);
  });
});

describe('documentation OpenAPI', () => {
  test('la spécification est valide et servie', async () => {
    const res = await request(app).get('/api/v1/openapi.json').expect(200);
    assert.equal(res.body.servers[0].url, 'http://vote.test/api/v1');
    await SwaggerParser.validate(structuredClone(res.body));
    await request(app).get('/api/docs').expect(200);
  });

  test('chaque opération documentée existe, et chaque route est documentée', async () => {
    const { call } = await client('write');
    const spec = openapi('');
    const fake = '00000000-0000-4000-8000-000000000000';
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of ['get', 'post', 'patch', 'put', 'delete']) {
        if (!item[method]) continue;
        const res = await call(method, path.replace(/\{[^}]+\}/g, fake)).send({});
        assert.notEqual(res.body?.error?.code, 'route_not_found', `${method.toUpperCase()} ${path} non routé`);
      }
    }
    const documented = Object.entries(spec.paths)
      .flatMap(([p, item]) => Object.keys(item).filter((k) => k !== 'parameters').map((m) => `${m} ${p}`)).sort();
    assert.deepEqual(documented, [
      'delete /polls/{pollId}', 'delete /polls/{pollId}/options/{optionId}', 'get /me', 'get /polls',
      'get /polls/{pollId}', 'get /polls/{pollId}/participants', 'get /polls/{pollId}/results',
      'patch /polls/{pollId}', 'patch /polls/{pollId}/options/{optionId}', 'post /polls',
      'post /polls/{pollId}/invitations', 'post /polls/{pollId}/notifications', 'post /polls/{pollId}/options',
      'put /polls/{pollId}/options/{optionId}/image',
    ]);
  });
});
