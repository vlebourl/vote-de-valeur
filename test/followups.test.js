// Version 1.2 : choix ajoutés après un vote (avis sur demande, complément de bulletin).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import pool from '../src/db.js';
import {
  newApp, organizer, createPoll, requestBallot, submitBallot, lastMail, pathOf, unique, query, hiddenFields,
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
  await request(app).get(first).expect(200); // l'ancien lien reste valable (il mène aussi au complément)

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
  const supplementPage = await request(app).get(path).expect(200);
  const form = hiddenFields(supplementPage.text);
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
  const form = { ...hiddenFields(page.text), ...Object.fromEntries(ids.map((id) => [`score_${id}`, '1'])) };
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

test('mode « nom » : ressaisir un nom ne permet pas de prendre la main sur un complément', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent, { auth_mode: 'name' });
  const first = await request(app).post(`/vote/${pollId}/name`).type('form').send({ name: 'Omar' }).expect(302);
  await submitBallot(app, first.headers.location, { Lyon: 1 });
  await addOption(agent, pollId, 'Metz');
  await request(app).post(`/vote/${pollId}/name`).type('form').send({ name: 'Omar' }).expect(409);
  // Le détenteur du lien, lui, peut noter le nouveau choix.
  const own = await request(app).get(first.headers.location).expect(200);
  assert.deepEqual([...own.text.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]), ['Metz']);
});

test('choix ajouté : total et rang masqués tant qu\'il a moins de notes que le seuil', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent, { min_ballots: '2' });
  const paths = [];
  for (const n of [1, 2]) {
    const p = await requestBallot(app, pollId, `${unique('choix-seuil' + n)}@test.local`);
    await submitBallot(app, p, { Lyon: 1 });
    paths.push(p);
  }
  await addOption(agent, pollId, 'Caen');
  await submitBallot(app, paths[0], { Caen: -2 });
  const r = await request(app).get(`/api/polls/${pollId}/results?token=${tokenOf(paths[0])}`).expect(200);
  const caen = r.body.options.find((o) => o.label === 'Caen');
  assert.deepEqual([caen.pending, caen.total, caen.rank], [true, null, null]);
  const page = await request(app).get(`/vote/${pollId}/results/${tokenOf(paths[0])}`).expect(200);
  assert.match(page.text, /résultat masqué jusqu'à 2 notes \(1 pour l'instant\)/);
  await submitBallot(app, paths[1], { Caen: 1 });
  const after = await request(app).get(`/api/polls/${pollId}/results?token=${tokenOf(paths[0])}`).expect(200);
  assert.equal(after.body.options.find((o) => o.label === 'Caen').total, -1);
});

test('bulletin : confirmation obligatoire, note exigée pour chaque choix présenté', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  const path = await requestBallot(app, pollId, `${unique('ack')}@test.local`);
  const page = await request(app).get(path).expect(200);
  assert.match(page.text, /compris que je ne pourrai pas les revoir/);
  const fields = hiddenFields(page.text);
  const ids = [...new Set([...page.text.matchAll(/name="score_([0-9a-f-]{36})"/g)].map((m) => m[1]))];
  const scores = Object.fromEntries(ids.map((id) => [`score_${id}`, '1']));
  const noAck = await request(app).post(path).type('form').send({ ...fields, final_ack: '', ...scores }).expect(400);
  assert.match(noAck.text, /Cochez la case/);
  await request(app).post(path).type('form').send({ ...fields }).expect(400); // bulletin vide
  const partial = { ...fields, [`score_${ids[0]}`]: '2' };
  await request(app).post(path).type('form').send(partial).expect(400);
  await request(app).post(path).type('form').send({ ...fields, shown: 'faux', ...scores }).expect(409);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM ballots WHERE poll_id = $1', [pollId])).rows[0].n, 0);
  await request(app).post(path).type('form').send({ ...fields, ...scores }).expect(302);
});

test('avis : deux envois simultanés ne préviennent qu\'une fois', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  const email = `${unique('simul')}@test.local`;
  await submitBallot(app, await requestBallot(app, pollId, email), { Lyon: 1 }, { notify: 'on' });
  await addOption(agent, pollId, 'Pau');
  const { devOutbox } = await import('../src/mailer.js');
  const before = devOutbox.filter((m) => m.to === email && m.kind === 'new-options').length;
  await Promise.all([1, 2, 3].map(() => agent.post(`/polls/${pollId}/notify`).type('form').send({})));
  const after = devOutbox.filter((m) => m.to === email && m.kind === 'new-options').length;
  assert.equal(after - before, 1);
});

test('vote enregistré après la clôture refusé, abonnement non recréé', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  const path = await requestBallot(app, pollId, `${unique('tard')}@test.local`);
  const page = await request(app).get(path).expect(200);
  const ids = [...new Set([...page.text.matchAll(/name="score_([0-9a-f-]{36})"/g)].map((m) => m[1]))];
  await agent.post(`/polls/${pollId}/status`).type('form').send({ status: 'closed' }).expect(302);
  await request(app).post(path).type('form')
    .send({ ...hiddenFields(page.text), notify: 'on', ...Object.fromEntries(ids.map((id) => [`score_${id}`, '1'])) }).expect(200);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM ballots WHERE poll_id = $1', [pollId])).rows[0].n, 0);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM voter_notifications WHERE poll_id = $1', [pollId])).rows[0].n, 0);
});

test('votant d\'avant la 1.2 : ses choix d\'origine ne redeviennent jamais notables', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  const path = await requestBallot(app, pollId, `${unique('legacy')}@test.local`);
  await submitBallot(app, path, { Lyon: 1 });
  // Simule un vote antérieur à la migration : liste inconnue, options d'origine non datées.
  await query('UPDATE poll_voters SET rated_option_ids = NULL, rated_before_v12 = true WHERE poll_id = $1', [pollId]);
  await query('UPDATE options SET created_at = NULL WHERE poll_id = $1', [pollId]);
  await addOption(agent, pollId, 'Rennes');
  const first = await request(app).get(path).expect(200);
  assert.deepEqual([...first.text.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]), ['Rennes']);
  await submitBallot(app, path, { Rennes: 1 });
  // Après ce premier complément, rien d'autre (surtout pas Lyon, Marseille, Bordeaux).
  assert.match((await request(app).get(path).expect(302)).headers.location, /\/results\//);
  const { rows } = await query(
    `SELECT o.label, COUNT(s.score)::int AS n FROM options o LEFT JOIN ballot_scores s ON s.option_id = o.id
      WHERE o.poll_id = $1 GROUP BY o.label`, [pollId]);
  for (const r of rows) assert.equal(r.n, 1, `${r.label} noté une seule fois`);
});

test('choix en attente affichés dans l\'ordre du scrutin, jamais selon leurs notes', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent, { min_ballots: '2' });
  const paths = [];
  for (const n of [1, 2]) {
    const p = await requestBallot(app, pollId, `${unique('ordre' + n)}@test.local`);
    await submitBallot(app, p, { Lyon: 1 });
    paths.push(p);
  }
  await addOption(agent, pollId, 'Xertigny');
  await addOption(agent, pollId, 'Yvetot');
  await submitBallot(app, paths[0], { Xertigny: -2, Yvetot: 2 });
  const r = await request(app).get(`/api/polls/${pollId}/results?token=${tokenOf(paths[0])}`).expect(200);
  const pendingLabels = r.body.options.filter((o) => o.pending).map((o) => o.label);
  assert.deepEqual(pendingLabels, ['Xertigny', 'Yvetot']);
});

test('note vide refusée (pas prise pour un 0)', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  const path = await requestBallot(app, pollId, `${unique('vide')}@test.local`);
  const page = await request(app).get(path).expect(200);
  const ids = [...new Set([...page.text.matchAll(/name="score_([0-9a-f-]{36})"/g)].map((m) => m[1]))];
  const form = { ...hiddenFields(page.text), ...Object.fromEntries(ids.map((id) => [`score_${id}`, '1'])) };
  form[`score_${ids[0]}`] = '';
  await request(app).post(path).type('form').send(form).expect(400);
  form[`score_${ids[0]}`] = '3';
  await request(app).post(path).type('form').send(form).expect(400);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM ballots WHERE poll_id = $1', [pollId])).rows[0].n, 0);
});

test('avis : un échec d\'envoi laisse la personne à prévenir et le compte', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  const email = `${unique('echec')}@test.local`;
  await submitBallot(app, await requestBallot(app, pollId, email), { Lyon: 1 }, { notify: 'on' });
  await addOption(agent, pollId, 'Agen');
  const { devFailures } = await import('../src/mailer.js');
  devFailures.next = 1;
  const res = await agent.post(`/polls/${pollId}/notify`).type('form').send({}).expect(302);
  assert.match(decodeURIComponent(res.headers.location), /1 échec/);
  assert.doesNotMatch(decodeURIComponent(res.headers.location), /quota/, 'un échec d\'envoi n\'est pas un quota atteint');
  const { pendingCount } = await import('../src/services/followups.js');
  assert.equal(await pendingCount({ id: pollId }), 1);
  await agent.post(`/polls/${pollId}/notify`).type('form').send({}).expect(302);
  assert.equal(await pendingCount({ id: pollId }), 0);
});

test('lien supplémentaire d\'un avis : l\'ancien lien marche, une nouvelle demande remplace tout', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  const email = `${unique('liens')}@test.local`;
  const first = await requestBallot(app, pollId, email);
  await submitBallot(app, first, { Lyon: 1 }, { notify: 'on' });
  const permalink = pathOf(lastMail(email, 'confirmation').permalink);
  await addOption(agent, pollId, 'Albi');
  await agent.post(`/polls/${pollId}/notify`).type('form').send({}).expect(302);
  const extra = pathOf(lastMail(email, 'new-options').url);
  assert.match(lastMail(email, 'new-options').url, /ballot/);
  await request(app).get(permalink).expect(200); // permalien de la confirmation toujours valable
  await request(app).get(extra).expect(200);
  // Nouvelle demande de lien : tous les anciens liens sont remplacés.
  const renewed = await requestBallot(app, pollId, email);
  await request(app).get(permalink).expect(404);
  await request(app).get(extra).expect(404);
  await request(app).get(renewed).expect(200);
});
