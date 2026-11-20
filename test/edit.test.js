// Version 1.3 : modification du vote par le lien de l'email de confirmation.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import pool from '../src/db.js';
import { hashToken } from '../src/tokens.js';
import {
  newApp, organizer, createPoll, requestBallot, submitBallot, ballotForm, lastMail, pathOf, unique, query,
} from './helpers.js';

after(() => pool.end());
const app = newApp();
const tokenOf = (path) => path.split('/').pop();
const totals = async (pollId, token) => {
  const r = await request(app).get(`/api/polls/${pollId}/results?token=${token}`).expect(200);
  return { count: r.body.ballotCount, ...Object.fromEntries(r.body.options.map((o) => [o.label, o.total])) };
};

test('parcours : lien dans la confirmation, bulletin vierge, remplacement complet', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  const email = `${unique('modif')}@test.local`;
  const path = await requestBallot(app, pollId, email);
  const page = await request(app).get(path).expect(200);
  assert.match(page.text, /Vous pourrez le modifier jusqu'à la clôture/);
  assert.equal((await submitBallot(app, path, { Lyon: 2, Marseille: -1 })).status, 302);

  const mail = lastMail(email, 'confirmation');
  assert.ok(mail.editUrl, 'la confirmation porte le lien de modification');
  assert.match(mail.text, /modifier votre vote/);
  assert.doesNotMatch(mail.text, /\+2|−1|-1 /, 'aucune note dans l\'email');
  const editPath = pathOf(mail.editUrl);
  const key = tokenOf(editPath);

  // Seule l'empreinte est stockée, sur le bulletin, sans lien vers le votant.
  const { rows } = await query('SELECT voter_id, edit_hash FROM ballots WHERE poll_id = $1', [pollId]);
  assert.deepEqual(rows, [{ voter_id: null, edit_hash: hashToken(key) }]);
  const dump = JSON.stringify((await query('SELECT * FROM poll_voters WHERE poll_id = $1', [pollId])).rows);
  assert.ok(!dump.includes(key) && !dump.includes(hashToken(key)));

  // Bulletin vierge : les anciennes notes ne sont pas réaffichées.
  const edit = await request(app).get(editPath).expect(200);
  assert.match(edit.text, /Modification de votre vote/);
  assert.match(edit.text, /Remplacer mon vote/);
  assert.doesNotMatch(edit.text, /value="2" checked|value="-1" checked/);
  assert.doesNotMatch(edit.text, /name="notify"/);

  const res = await submitBallot(app, editPath, { Lyon: -2, Bordeaux: 1 });
  assert.equal(res.status, 200);
  assert.match(res.text, /Votre vote a bien été remplacé/);
  assert.doesNotMatch(res.text, /Lyon|Bordeaux/, "la page ne rappelle pas les notes");
  assert.deepEqual(await totals(pollId, tokenOf(path)), { count: 1, Lyon: -2, Marseille: 0, Bordeaux: 1 });

  // Le lien reste valable : nouvelle modification.
  assert.equal((await submitBallot(app, editPath, { Marseille: 2 })).status, 200);
  assert.deepEqual(await totals(pollId, tokenOf(path)), { count: 1, Lyon: 0, Marseille: 2, Bordeaux: 0 });
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM ballots WHERE poll_id = $1', [pollId])).rows[0].n, 1);
});

test('refus : clé inconnue, autre scrutin, bulletin incomplet ou case non cochée, scrutin clôturé', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  const other = await createPoll(agent);
  const email = `${unique('refus')}@test.local`;
  const path = await requestBallot(app, pollId, email);
  assert.equal((await submitBallot(app, path, { Lyon: 1 })).status, 302);
  const editPath = pathOf(lastMail(email, 'confirmation').editUrl);
  const key = tokenOf(editPath);

  await request(app).get(`/vote/${pollId}/modifier/inconnue`).expect(404);
  await request(app).get(`/vote/${other}/modifier/${key}`).expect(404);

  const form = await ballotForm(app, editPath, { Lyon: -2 });
  const scoreKeys = Object.keys(form).filter((k) => k.startsWith('score_'));
  const incomplete = { ...form };
  delete incomplete[scoreKeys[0]];
  assert.match((await request(app).post(editPath).type('form').send(incomplete).expect(400)).text, /Attribuez une note/);
  assert.match((await request(app).post(editPath).type('form').send({ ...form, final_ack: '' }).expect(400)).text, /Cochez la case/);
  assert.match((await request(app).post(editPath).type('form').send({ ...form, [scoreKeys[0]]: '5' }).expect(400)).text, /Attribuez une note/);
  // Liste signée d'un autre bulletin : refusée.
  const otherPath = await requestBallot(app, pollId, `${unique('autre')}@test.local`);
  const otherForm = await ballotForm(app, otherPath);
  await request(app).post(editPath).type('form').send({ ...form, shown: otherForm.shown }).expect(409);
  assert.equal((await totals(pollId, tokenOf(path))).Lyon, 1, 'rien n\'a changé');

  await agent.post(`/polls/${pollId}/status`).type('form').send({ status: 'closed' }).expect(302);
  const closed = await request(app).post(editPath).type('form').send(form).expect(200);
  assert.match(closed.text, /clôturé/);
  assert.match((await request(app).get(editPath).expect(200)).text, /clôturé/);
});

test('choix retiré : la modification porte sur les choix restants', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  const email = `${unique('retrait')}@test.local`;
  const path = await requestBallot(app, pollId, email);
  assert.equal((await submitBallot(app, path, { Lyon: 1, Marseille: 1, Bordeaux: 1 })).status, 302);
  const editPath = pathOf(lastMail(email, 'confirmation').editUrl);
  const form = await ballotForm(app, editPath, { Lyon: 2, Marseille: 2, Bordeaux: 2 });
  const { rows: [bordeaux] } = await query("SELECT id FROM options WHERE poll_id = $1 AND label = 'Bordeaux'", [pollId]);
  await agent.post(`/polls/${pollId}/options/${bordeaux.id}/delete`).type('form').send({}).expect(302);
  // Le formulaire préparé avant le retrait reste accepté pour les choix restants.
  await request(app).post(editPath).type('form').send(form).expect(200);
  const t = await totals(pollId, tokenOf(path));
  assert.equal(t.Lyon, 2);
  assert.equal(t.Marseille, 2);
  assert.equal(t.Bordeaux, undefined);
});

test('complément : son propre lien de modification, limité aux nouveaux choix', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent);
  const email = `${unique('compl')}@test.local`;
  const path = await requestBallot(app, pollId, email);
  assert.equal((await submitBallot(app, path, { Lyon: 1 }, { notify: 'on' })).status, 302);
  const mainEdit = pathOf(lastMail(email, 'confirmation').editUrl);
  await agent.post(`/polls/${pollId}/options`).field('label', 'Nice').expect(302);
  await agent.post(`/polls/${pollId}/notify`).type('form').send({}).expect(302);
  const link = pathOf(lastMail(email, 'new-options').url);
  assert.equal((await submitBallot(app, link, { Nice: 2 })).status, 302);
  const suppEdit = pathOf(lastMail(email, 'confirmation').editUrl);
  assert.notEqual(suppEdit, mainEdit);

  const page = await request(app).get(suppEdit).expect(200);
  assert.deepEqual([...page.text.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]), ['Nice']);
  assert.equal((await submitBallot(app, suppEdit, { Nice: -1 })).status, 200);
  // Le bulletin principal ne propose pas le nouveau choix.
  const main = await request(app).get(mainEdit).expect(200);
  assert.ok(!main.text.includes('<h3>Nice</h3>'));
  const t = await totals(pollId, tokenOf(path));
  assert.deepEqual([t.count, t.Lyon, t.Nice], [1, 1, -1]);
});

test('mode par nom : pas de lien de modification, vote annoncé définitif', async () => {
  const { agent } = await organizer(app);
  const pollId = await createPoll(agent, { auth_mode: 'name' });
  const res = await request(app).post(`/vote/${pollId}/name`).type('form').send({ name: unique('Nom') }).expect(302);
  const page = await request(app).get(res.headers.location).expect(200);
  assert.match(page.text, /Votre vote est définitif/);
  assert.equal((await submitBallot(app, res.headers.location, { Lyon: 1 })).status, 302);
  const { rows } = await query('SELECT edit_hash FROM ballots WHERE poll_id = $1', [pollId]);
  assert.deepEqual(rows, [{ edit_hash: null }]);
});
