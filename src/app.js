import express from 'express';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { config } from './config.js';
import { query } from './db.js';
import { loadUser } from './auth.js';
import { formatDateTime } from './dates.js';
import { securityHeaders, sameOriginWrites, createLimiters } from './security.js';
import authRoutes from './routes/auth.js';
import pollRoutes from './routes/polls.js';
import voteRoutes from './routes/vote.js';
import accountRoutes from './routes/account.js';
import { createApiRouter } from './routes/api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp({ rateLimits = true } = {}) {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', join(__dirname, 'views'));
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.locals.formatDateTime = (date) => formatDateTime(date, config.timeZone);

  app.use(securityHeaders);
  app.use(express.static(join(__dirname, '..', 'public')));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use((req, res, next) => { req.body ??= {}; next(); });
  app.use(cookieParser());
  app.use(loadUser);
  // L'API s'authentifie par jeton, jamais par cookie : pas de contrôle d'origine.
  const checkOrigin = sameOriginWrites({ baseUrl: config.baseUrl });
  app.use((req, res, next) => (req.path.startsWith('/api/v1/') ? next() : checkOrigin(req, res, next)));

  if (rateLimits) {
    const limit = createLimiters();
    app.post(['/login', '/register'], limit.auth);
    app.post('/vote/:id/request', limit.magicLink);
    app.post('/vote/:id/access', limit.pollPassword);
    app.post('/vote/:id/name', limit.nameVote);
  }

  app.use('/api/v1', createApiRouter({ rateLimits }));
  app.get('/api/docs', (req, res) => res.render('api_docs'));

  app.get('/', (req, res) => res.render('landing'));

  // Santé (healthcheck Coolify / Docker) : vérifie aussi l'accès à la base.
  app.get('/healthz', async (req, res) => {
    try {
      await query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.use(authRoutes);
  app.use(pollRoutes);
  app.use(voteRoutes);
  app.use(accountRoutes);

  app.use((req, res) => res.status(404).render('error', { message: 'Page introuvable.' }));

  // Express 5 transmet ici les erreurs des gestionnaires asynchrones : une
  // requête qui échoue renvoie une page 500 au lieu d'arrêter le processus.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return;
    res.status(500).render('error', { message: 'Erreur serveur.' });
  });

  return app;
}
