import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import pool from '../src/db.js';
import { hashToken } from '../src/tokens.js';
import {
  newApp, organizer, createPoll, requestBallot, submitBallot, ballotForm, lastMail, pathOf, unique, query,
  hiddenFields,
} from './helpers.js';

after(() => pool.end());
const app = newApp();

test('santé : /healthz vérifie la base', async () => {
  const res = await request(app).get('/healthz').expect(200);
  assert.deepEqual(res.body, { ok: true });
});

test('un identifiant invalide renvoie 404 sans faire tomber le serveur', async () => {
  for (const path of ['/vote/xyz', '/vote/xyz/ballot/abc', '/vote/xyz/results/abc', '/options/xyz/image']) {
    await request(app).get(path).expect(404);
  }
  await request(app).get('/api/polls/xyz/results').expect(404);
  await request(app).get('/healthz').expect(200);
});

test('parcours complet en scrutin secret : vote, confirmation, résultats', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  const email = `${unique('votant')}@test.local`;

  const ballot = await requestBallot(app, pollId, email);
  const token = ballot.split('/').pop();

  // Avant le vote, pas de résultats.
  await request(app).get(`/api/polls/${pollId}/results?token=${token}`).expect(403);

  const res = await submitBallot(app, ballot, { Lyon: 2, Marseille: -1 });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, new RegExp(`/vote/${pollId}/results/${token}`));

  // Confirmation envoyée à la bonne adresse, avec le permalien.
  const mail = lastMail(email, 'confirmation');
  assert.ok(mail, 'email de confirmation attendu');
  assert.equal(pathOf(mail.permalink), `/vote/${pollId}/results/${token}`);

  const api = await request(app).get(`/api/polls/${pollId}/results?token=${token}`).expect(200);
  assert.equal(api.body.ballotCount, 1);
  assert.deepEqual(api.body.options.map((o) => [o.label, o.total, o.rank]),
    [['Lyon', 2, 1], ['Bordeaux', 0, 2], ['Marseille', -1, 3]]);

  await request(app).get(`/vote/${pollId}/results/${token}`).expect(200);
});

test('secret du bulletin : ni email, ni jeton, ni horodatage reliant le votant à son bulletin', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  const email = `${unique('secret')}@test.local`;
  const ballot = await requestBallot(app, pollId, email);
  const token = ballot.split('/').pop();

  const before = await query('SELECT email, email_sealed, token_hash FROM poll_voters WHERE poll_id = $1', [pollId]);
  assert.equal(before.rows[0].email, null);
  assert.ok(before.rows[0].email_sealed, 'email chiffré gardé jusqu\'au vote');
  assert.ok(!before.rows[0].email_sealed.includes(email));
  assert.equal(before.rows[0].token_hash, hashToken(token));

  await submitBallot(app, ballot, { Lyon: 1 });

  const voter = (await query('SELECT * FROM poll_voters WHERE poll_id = $1', [pollId])).rows[0];
  assert.equal(voter.email, null);
  assert.equal(voter.email_sealed, null, 'email chiffré effacé après le vote');
  assert.equal(voter.display_name, null);
  const day = (d) => d.toISOString().slice(11);
  assert.equal(day(voter.voted_at), '00:00:00.000Z', 'date de vote arrondie au jour');

  const ballotRow = (await query('SELECT * FROM ballots WHERE poll_id = $1', [pollId])).rows[0];
  assert.equal(ballotRow.voter_id, null);
  assert.equal(ballotRow.created_at, null);

  // Aucune colonne de la base ne contient l'email ou le jeton en clair.
  const dump = JSON.stringify((await query('SELECT * FROM poll_voters')).rows);
  assert.ok(!dump.includes(email));
  assert.ok(!dump.includes(token));
});

test('un votant ne peut voter qu\'une fois, même avec dix soumissions simultanées', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  const ballot = await requestBallot(app, pollId, `${unique('double')}@test.local`);
  const form = await ballotForm(app, ballot, { Lyon: 2 });
  await Promise.all(Array.from({ length: 10 }, () => request(app).post(ballot).type('form').send(form)));
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM ballots WHERE poll_id = $1', [pollId]);
  assert.equal(rows[0].n, 1);
});

test('une nouvelle demande de lien remplace l\'ancien', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  const email = `${unique('relance')}@test.local`;
  const first = await requestBallot(app, pollId, email);
  const second = await requestBallot(app, pollId, email);
  assert.notEqual(first, second);
  await request(app).get(first).expect(404);
  await request(app).get(second).expect(200);
});

test('scrutin nominatif : l\'organisateur voit l\'identité et le vote', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent, { nominative: true });
  const email = `${unique('nominatif')}@test.local`;
  const ballot = await requestBallot(app, pollId, email, { name: 'Alice Martin' });
  await submitBallot(app, ballot, { Bordeaux: 2 });
  assert.ok(lastMail(email, 'confirmation'));
  const page = await agent.get(`/polls/${pollId}/manage`).expect(200);
  assert.match(page.text, /Alice Martin/);
  assert.ok(page.text.includes(email));
});

test('mode « nom » : un nom = un vote', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent, { auth_mode: 'name' });
  const first = await request(app).post(`/vote/${pollId}/name`).type('form').send({ name: 'Bob  Dupont' }).expect(302);
  await submitBallot(app, first.headers.location, { Lyon: 1 });
  const again = await request(app).post(`/vote/${pollId}/name`).type('form').send({ name: 'bob dupont' });
  assert.equal(again.status, 409);
  const { rows } = await query('SELECT display_name FROM poll_voters WHERE poll_id = $1', [pollId]);
  assert.equal(rows[0].display_name, null, 'nom non conservé en scrutin secret');
});

test('scrutin privé : le mot de passe est exigé', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent, { password: 'sesame-ouvre-toi' });
  const page = await request(app).get(`/vote/${pollId}`).expect(200);
  assert.match(page.text, /name="password"/);
  await request(app).post(`/vote/${pollId}/access`).type('form').send({ password: 'faux' }).expect(401);
  const visitor = request.agent(app);
  await visitor.post(`/vote/${pollId}/access`).type('form').send({ password: 'sesame-ouvre-toi' }).expect(302);
  const unlocked = await visitor.get(`/vote/${pollId}`).expect(200);
  assert.match(unlocked.text, /name="email"/);
});

test('un autre organisateur n\'a pas accès à la gestion du scrutin', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  const { agent: other } = await organizer(app);
  await other.get(`/polls/${pollId}/manage`).expect(403);
  await other.get(`/polls/${pollId}/results.json`).expect(403);
});

test('connexion : pas de redirection vers un autre site', async () => {
  const { email } = await organizer(app);
  const res = await request(app).post('/login').type('form')
    .send({ email, password: 'motdepasse-solide', next: '//evil.example' }).expect(302);
  assert.equal(res.headers.location, '/dashboard');
});

test('écriture depuis une autre origine refusée (CSRF)', async () => {
  const { agent } = await organizer(app);
  await agent.post('/polls/new').set('Origin', 'https://evil.example').expect(403);
  await agent.post('/logout').set('Origin', 'http://vote.test').expect(302);
});

test('limitation de débit sur la connexion', async () => {
  const limited = newApp({ rateLimits: true });
  let last;
  for (let i = 0; i < 21; i++) {
    last = await request(limited).post('/login').type('form').send({ email: 'x@test.local', password: 'faux-faux-faux' });
  }
  assert.equal(last.status, 429);
});

test('en-têtes de sécurité', async () => {
  const res = await request(app).get('/').expect(200);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'same-origin');
  assert.equal(res.headers['x-powered-by'], undefined);
});

test('date de clôture : saisie à l\'heure de Paris, affichée à l\'heure de Paris', async () => {
  const { agent } = await organizer(app);
  // Sans JavaScript : saisie brute lue dans le fuseau de l'application.
  const pollId = await createPoll(agent, { close_at: '2026-07-15T18:00' });
  const { rows } = await query('SELECT close_at FROM polls WHERE id = $1', [pollId]);
  assert.equal(rows[0].close_at.toISOString(), '2026-07-15T16:00:00.000Z');
  const page = await agent.get(`/polls/${pollId}/manage`).expect(200);
  assert.match(page.text, /Clôture automatique le 15\/07 à 18:00/);

  // Avec JavaScript : instant UTC calculé par le navigateur, prioritaire.
  const other = await createPoll(agent, { close_at: '2026-07-15T18:00', close_at_utc: '2026-07-15T22:30:00.000Z' });
  const r2 = await query('SELECT close_at FROM polls WHERE id = $1', [other]);
  assert.equal(r2.rows[0].close_at.toISOString(), '2026-07-15T22:30:00.000Z');

  const bad = await createPoll(agent, { close_at: 'demain', expectStatus: 400 });
  assert.match(bad.text, /Date de clôture invalide/);
});

test('bascule secret → nominatif pendant le vote : bulletin refusé et réaffiché avec l\'avertissement', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  const email = `${unique('bascule')}@test.local`;
  const ballot = await requestBallot(app, pollId, email);
  const page = await request(app).get(ballot).expect(200);
  const ids = [...new Set([...page.text.matchAll(/name="score_([0-9a-f-]{36})"/g)].map((m) => m[1]))];
  const form = { ...hiddenFields(page.text), ...Object.fromEntries(ids.map((id) => [`score_${id}`, '1'])) };

  await agent.post(`/polls/${pollId}/nominative`).type('form').send({ nominative: 'on' }).expect(302);
  const refused = await request(app).post(ballot).type('form').send(form).expect(409);
  assert.match(refused.text, /passé en mode <strong>nominatif<\/strong>/);
  assert.match(refused.text, /name="mode" value="nominative"/);
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM ballots WHERE poll_id = $1', [pollId]);
  assert.equal(rows[0].n, 0);

  await request(app).post(ballot).type('form').send({ ...form, mode: 'nominative' }).expect(302);
  const linked = await query('SELECT voter_id FROM ballots WHERE poll_id = $1', [pollId]);
  assert.ok(linked.rows[0].voter_id, 'bulletin lié : le votant a vu l\'avertissement nominatif');
});

test('retour au secret : identités des personnes n\'ayant pas voté effacées', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent, { nominative: true });
  const voted = `${unique('a-vote')}@test.local`;
  const pending = `${unique('en-attente')}@test.local`;
  await submitBallot(app, await requestBallot(app, pollId, voted, { name: 'A' }), { Lyon: 1 });
  await requestBallot(app, pollId, pending, { name: 'B' });
  await agent.post(`/polls/${pollId}/nominative`).type('form').send({ nominative: 'off' }).expect(302);
  const { rows } = await query('SELECT email, display_name, voted_at IS NOT NULL AS voted FROM poll_voters WHERE poll_id = $1 ORDER BY voted DESC', [pollId]);
  assert.equal(rows[0].email, voted, 'bulletin déposé en nominatif : identité conservée (non affichée)');
  assert.deepEqual([rows[1].email, rows[1].display_name], [null, null]);
});

test('page de gestion : formulaire sans titre refusé', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  const res = await agent.post(`/polls/${pollId}/edit`).type('form').send({ description: 'x' }).expect(302);
  assert.match(decodeURIComponent(res.headers.location), /err=Le titre ne peut pas être vide/);
});

test('alias Gmail : la même boîte ne vote qu\'une fois', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  const base = unique('gm').replace(/[^a-z0-9]/g, '');
  const first = await requestBallot(app, pollId, `${base}@gmail.com`);
  await submitBallot(app, first, { Lyon: 1 });
  // Variante de la même boîte : nouveau lien, mais même votant, qui a déjà voté.
  const second = await requestBallot(app, pollId, `${base.slice(0, 2)}.${base.slice(2)}+2@gmail.com`);
  const res = await request(app).get(second).expect(302);
  assert.match(res.headers.location, /\/results\//);
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM poll_voters WHERE poll_id = $1', [pollId]);
  assert.equal(rows[0].n, 1);
});

test('inscription antérieure à la normalisation reconnue (ancienne empreinte)', async () => {
  const { hashEmail } = await import('../src/auth.js');
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  const email = `${unique('ancien').replace(/[^a-z0-9]/g, '')}+tag@exemple.fr`;
  await query("INSERT INTO poll_voters (poll_id, email_hash, token_hash, voted_at) VALUES ($1, $2, 'legacy-' || gen_random_uuid(), now())", [pollId, hashEmail(email)]);
  await requestBallot(app, pollId, email);
  const { rows } = await query('SELECT COUNT(*)::int AS n, bool_and(voted_at IS NOT NULL) AS voted FROM poll_voters WHERE poll_id = $1', [pollId]);
  assert.deepEqual(rows[0], { n: 1, voted: true });
});

test('seuil de publication : résultats masqués partout tant qu\'il manque des bulletins', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent, { min_ballots: '' }); // champ vide : seuil par défaut (5)
  const { rows } = await query('SELECT min_ballots_for_results FROM polls WHERE id = $1', [pollId]);
  assert.equal(rows[0].min_ballots_for_results, 5);
  await agent.post(`/polls/${pollId}/edit`).type('form').send({ title: 'Où partir ?', min_ballots_for_results: '2' }).expect(302);

  const alice = `${unique('seuil-a')}@test.local`;
  const ballotA = await requestBallot(app, pollId, alice);
  const tokenA = ballotA.split('/').pop();
  await submitBallot(app, ballotA, { Lyon: 2, Marseille: -2 });

  // Un seul bulletin : rien ne doit trahir son contenu.
  const page = await request(app).get(`/vote/${pollId}/results/${tokenA}`).expect(200);
  assert.match(page.text, /Résultats masqués/);
  assert.ok(!/res-score/.test(page.text), 'aucun total affiché');
  const api = await request(app).get(`/api/polls/${pollId}/results?token=${tokenA}`).expect(200);
  assert.equal(api.body.hidden, true);
  assert.deepEqual(api.body.options, []);
  assert.match(page.text, /<strong>1<\/strong> votant</);
  assert.match(page.text, /il faut au moins 2 votants/);
  const manage = await agent.get(`/polls/${pollId}/manage`).expect(200);
  assert.match(manage.text, /Résultats masqués/);
  assert.equal((await agent.get(`/polls/${pollId}/results.json`).expect(200)).body.hidden, true);

  // Seuil atteint : résultats publiés.
  await submitBallot(app, await requestBallot(app, pollId, `${unique('seuil-b')}@test.local`), { Lyon: 1 });
  const after = await request(app).get(`/api/polls/${pollId}/results?token=${tokenA}`).expect(200);
  assert.equal(after.body.hidden, false);
  assert.equal(after.body.options.find((o) => o.label === 'Lyon').total, 3);
  const shown = await request(app).get(`/vote/${pollId}/results/${tokenA}`).expect(200);
  assert.match(shown.text, /<strong>2<\/strong> votants/);
  assert.match(shown.text, /res-score/);
});

test('email de confirmation : ni notes ni résultats', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  const voter = `${unique('confirm')}@test.local`;
  await submitBallot(app, await requestBallot(app, pollId, voter), { Lyon: 2, Marseille: -1 });
  const mail = lastMail(voter, 'confirmation');
  assert.match(mail.text, /Votre vote a bien été enregistré/);
  assert.match(mail.text, /ne contient pas vos notes/);
  assert.doesNotMatch(mail.text + mail.html, /Lyon|Marseille|\+2|Résultats actuels|rang|total/i);
});

test('seuil en scrutin nominatif : l\'organisateur voit tout, pas les votants', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent, { nominative: true, min_ballots: '3' });
  const ballot = await requestBallot(app, pollId, `${unique('nomi')}@test.local`, { name: 'N' });
  await submitBallot(app, ballot, { Lyon: 1 });
  assert.equal((await agent.get(`/polls/${pollId}/results.json`).expect(200)).body.hidden, false);
  const token = ballot.split('/').pop();
  assert.equal((await request(app).get(`/api/polls/${pollId}/results?token=${token}`).expect(200)).body.hidden, true);
});

test('seuil invalide refusé dans le formulaire', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  const res = await agent.post(`/polls/${pollId}/edit`).type('form').send({ title: 'T', min_ballots_for_results: '-1' }).expect(302);
  assert.match(decodeURIComponent(res.headers.location), /err=Seuil/);
});

test('favicon : déclarée dans les pages et servie', async () => {
  const page = await request(app).get('/').expect(200);
  assert.match(page.text, /rel="icon" href="\/favicon.svg"/);
  assert.match((await request(app).get('/favicon.svg').expect(200)).headers['content-type'], /image\/svg\+xml/);
  await request(app).get('/favicon.ico').expect(200);
  await request(app).get('/favicon-32.png').expect(200);
  await request(app).get('/apple-touch-icon.png').expect(200);
  assert.match((await request(app).get('/api/docs').expect(200)).text, /favicon.svg/);
});

test('fichiers statiques versionnés (cache des navigateurs et du CDN)', async () => {
  const { version } = JSON.parse((await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const page = await request(app).get('/').expect(200);
  assert.ok(page.text.includes(`/style.css?v=${version}`));
});
