// Version 1.2 : choix ajoutés après un vote (avis sur demande, complément de bulletin).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import pool from '../src/db.js';
import {
  newApp, organizer, createPoll, requestBallot, submitBallot, lastMail, pathOf, unique, query,
} from './helpers.js';

after(() => pool.end());
const app = newApp();

const tokenOf = (path) => path.split('/').pop();
async function addOption(agent, pollId, label) {
  await agent.post(`/polls/${pollId}/options`).field('label', label).expect(302);
}

test('parcours : abonnement, nouveau choix, avis, complément, sans rien révéler', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  const email = `${unique('abonne')}@test.local`;
  const first = await requestBallot(app, pollId, email);
  const page = await request(app).get(first).expect(200);
  assert.match(page.text, /name="notify"/);
  await submitBallot(app, first, { Lyon: 1 }, { notify: 'on' });

  // L'adresse est gardée chiffrée, sans lien avec le bulletin.
  const sub = (await query('SELECT email_enc, created_at FROM voter_notifications WHERE poll_id = $1', [pollId])).rows;
  assert.equal(sub.length, 1);
  assert.ok(!sub[0].email_enc.includes(email));
  assert.equal(sub[0].created_at, null, 'pas d\'horodatage en scrutin secret');

  // Rien à signaler tant qu'aucun choix n'est ajouté.
  let manage = await agent.get(`/polls/${pollId}/manage`).expect(200);
  assert.match(manage.text, /<strong>1<\/strong> votant a demandé à être prévenu/);
  assert.ok(!manage.text.includes(email), 'l\'organisateur ne voit pas l\'adresse');

  await addOption(agent, pollId, 'Nice');
  manage = await agent.get(`/polls/${pollId}/manage`).expect(200);
  assert.match(manage.text, /Prévenir 1 votant/);
  const notify = await agent.post(`/polls/${pollId}/notify`).type('form').send({}).expect(302);
  assert.match(decodeURIComponent(notify.headers.location), /Avis envoyé à 1 votant\./);

  const notice = lastMail(email, 'new-options');
  assert.deepEqual(notice.labels, ['Nice']);
  const link = pathOf(notice.url);
  await request(app).get(first).expect(404); // l'ancien lien est remplacé

  // Le nouveau lien ne propose que le nouveau choix.
  const ballot = await request(app).get(link).expect(200);
  assert.match(ballot.text, /Ce choix a été ajouté/);
  assert.deepEqual([...ballot.text.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]), ['Nice']);
  const res = await submitBallot(app, link, { Nice: 2 });
  assert.match(res.headers.location, /v=2/);

  // Un seul votant, le choix ajouté est noté, rien n'est relié au votant.
  const api = await request(app).get(`/api/polls/${pollId}/results?token=${tokenOf(link)}`).expect(200);
  assert.equal(api.body.ballotCount, 1);
  assert.equal(api.body.options.find((o) => o.label === 'Nice').total, 2);
  assert.equal(api.body.options.find((o) => o.label === 'Lyon').total, 1);
  const supp = (await query('SELECT voter_id, created_at FROM ballots WHERE poll_id = $1 AND is_supplement', [pollId])).rows;
  assert.deepEqual(supp, [{ voter_id: null, created_at: null }]);
  assert.match(lastMail(email, 'confirmation').text, /Vos notes pour les nouveaux choix/);

  // Plus rien à noter ni à signaler.
  assert.match((await request(app).get(link).expect(302)).headers.location, /\/results\//);
  const again = await agent.post(`/polls/${pollId}/notify`).type('form').send({}).expect(302);
  assert.match(decodeURIComponent(again.headers.location), /Aucun votant à prévenir/);
});

test('sans abonnement : la page de résultats propose de noter le nouveau choix', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  const path = await requestBallot(app, pollId, `${unique('sansavis')}@test.local`);
  await submitBallot(app, path, { Lyon: 2 });
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM voter_notifications WHERE poll_id = $1', [pollId])).rows[0].n, 0);
  await addOption(agent, pollId, 'Toulouse');
  const results = await request(app).get(`/vote/${pollId}/results/${tokenOf(path)}`).expect(200);
  assert.match(results.text, /Nouveau choix depuis votre vote/);
  assert.match(results.text, /Toulouse/);
  // Le complément ignore toute tentative de renoter un ancien choix.
  const form = { mode: 'secret' };
  const { rows: opts } = await query('SELECT id, label FROM options WHERE poll_id = $1', [pollId]);
  for (const o of opts) form[`score_${o.id}`] = o.label === 'Toulouse' ? '1' : '-2';
  await request(app).post(path).type('form').send(form).expect(302);
  const api = await request(app).get(`/api/polls/${pollId}/results?token=${tokenOf(path)}`).expect(200);
  assert.equal(api.body.options.find((o) => o.label === 'Lyon').total, 2, 'note initiale inchangée');
  assert.equal(api.body.options.find((o) => o.label === 'Toulouse').total, 1);
});

test('option ajoutée pendant qu\'un bulletin est ouvert : elle reste à noter ensuite', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  const path = await requestBallot(app, pollId, `${unique('pendant')}@test.local`);
  const page = await request(app).get(path).expect(200);
  const ids = [...new Set([...page.text.matchAll(/name="score_([0-9a-f-]{36})"/g)].map((m) => m[1]))];
  await addOption(agent, pollId, 'Brest');
  const form = { mode: 'secret', ...Object.fromEntries(ids.map((id) => [`score_${id}`, '1'])) };
  await request(app).post(path).type('form').send(form).expect(302);
  const supplement = await request(app).get(path).expect(200);
  assert.deepEqual([...supplement.text.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]), ['Brest']);
});

test('clôture : les adresses gardées pour les avis sont effacées', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  await submitBallot(app, await requestBallot(app, pollId, `${unique('clos')}@test.local`), {}, { notify: 'on' });
  await agent.post(`/polls/${pollId}/status`).type('form').send({ status: 'closed' }).expect(302);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM voter_notifications WHERE poll_id = $1', [pollId])).rows[0].n, 0);

  const { purgeClosedSubscriptions } = await import('../src/services/followups.js');
  const other = await createPoll(agent);
  await submitBallot(app, await requestBallot(app, other, `${unique('date')}@test.local`), {}, { notify: 'on' });
  await query("UPDATE polls SET close_at = now() - interval '1 minute' WHERE id = $1", [other]);
  await purgeClosedSubscriptions();
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM voter_notifications WHERE poll_id = $1', [other])).rows[0].n, 0);
});

test('scrutin nominatif : notes du complément fusionnées dans le détail des participants', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent, { nominative: true });
  const path = await requestBallot(app, pollId, `${unique('nomi')}@test.local`, { name: 'Nina' });
  await submitBallot(app, path, { Lyon: 1 });
  await addOption(agent, pollId, 'Lille');
  await submitBallot(app, path, { Lille: -1 });
  const manage = await agent.get(`/polls/${pollId}/manage`).expect(200);
  assert.equal((manage.text.match(/<strong>Nina<\/strong>/g) || []).length, 1, 'une seule ligne pour Nina');
  assert.match(manage.text, /<span class="total neg">-1<\/span>/);
});

test('mode « nom » : un nom déjà votant peut noter un choix ajouté', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent, { auth_mode: 'name' });
  const first = await request(app).post(`/vote/${pollId}/name`).type('form').send({ name: 'Omar' }).expect(302);
  await submitBallot(app, first.headers.location, { Lyon: 1 });
  await request(app).post(`/vote/${pollId}/name`).type('form').send({ name: 'Omar' }).expect(409);
  await addOption(agent, pollId, 'Metz');
  const again = await request(app).post(`/vote/${pollId}/name`).type('form').send({ name: 'Omar' }).expect(302);
  const page = await request(app).get(again.headers.location).expect(200);
  assert.deepEqual([...page.text.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]), ['Metz']);
});
