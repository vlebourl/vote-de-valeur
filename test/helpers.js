import request from 'supertest';
import { createApp } from '../src/app.js';
import { devOutbox } from '../src/mailer.js';
import { query } from '../src/db.js';

export { query };

let counter = 0;
export const unique = (prefix) => `${prefix}-${Date.now()}-${++counter}`;

export function newApp(options = { rateLimits: false }) {
  return createApp(options);
}

// Crée un organisateur connecté et renvoie son agent HTTP (avec cookies).
export async function organizer(app) {
  const agent = request.agent(app);
  const email = `${unique('org')}@test.local`;
  await agent.post('/register').type('form').send({ email, password: 'motdepasse-solide' }).expect(302);
  return { agent, email };
}

// Crée un scrutin et renvoie son identifiant.
export async function createPoll(agent, fields = {}) {
  const res = await agent.post('/polls')
    .field('title', fields.title || 'Où partir ?')
    .field('option_label_0', 'Lyon')
    .field('option_label_1', 'Marseille')
    .field('option_label_2', 'Bordeaux')
    .field('auth_mode', fields.auth_mode || 'email')
    .field('is_nominative', fields.nominative ? 'on' : '')
    .field('is_private', fields.password ? 'on' : '')
    .field('password', fields.password || '')
    .field('close_at', fields.close_at || '')
    .field('min_ballots_for_results', fields.min_ballots ?? '0')
    .field('close_at_utc', fields.close_at_utc || '')
    .expect(fields.expectStatus || 302);
  if (fields.expectStatus) return res;
  return res.headers.location.match(/\/polls\/([0-9a-f-]{36})\/manage/)[1];
}

// Dernier email de développement envoyé à cette adresse.
export function lastMail(to, kind) {
  return [...devOutbox].reverse().find((m) => m.to === to && (!kind || m.kind === kind));
}

export function pathOf(url) {
  return new URL(url).pathname;
}

// Demande un lien de vote par email et renvoie le chemin du bulletin.
export async function requestBallot(app, pollId, email, extra = {}) {
  await request(app).post(`/vote/${pollId}/request`).type('form').send({ email, ...extra }).expect(302);
  return pathOf(lastMail(email, 'magic-link').url);
}

// Lit le bulletin et prépare le formulaire ; scores = { Lyon: 2, ... } (0 par défaut).
export async function ballotForm(app, ballotPath, scores = {}) {
  const page = await request(app).get(ballotPath).expect(200);
  const ids = [...page.text.matchAll(/name="score_([0-9a-f-]{36})"/g)].map((m) => m[1]);
  const labels = [...page.text.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
  const form = { mode: page.text.match(/name="mode" value="(\w+)"/)[1] };
  [...new Set(ids)].forEach((id, i) => { form[`score_${id}`] = String(scores[labels[i]] ?? 0); });
  return form;
}

// Remplit et soumet un bulletin.
export async function submitBallot(app, ballotPath, scores = {}) {
  const form = await ballotForm(app, ballotPath, scores);
  return request(app).post(ballotPath).type('form').send(form);
}
