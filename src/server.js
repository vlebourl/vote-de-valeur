import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadUser } from './auth.js';
import authRoutes from './routes/auth.js';
import pollRoutes from './routes/polls.js';
import voteRoutes from './routes/vote.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.set('view engine', 'ejs');
app.set('views', join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(join(__dirname, '..', 'public')));
app.use(loadUser);

// Landing
app.get('/', (req, res) => res.render('landing'));

// Santé (utile pour Coolify / healthcheck)
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use(authRoutes);
app.use(pollRoutes);
app.use(voteRoutes);

// 404
app.use((req, res) => res.status(404).render('error', { message: 'Page introuvable.' }));

// Gestion d'erreurs
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { message: 'Erreur serveur.' });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`✅ Vote de valeur démarré sur http://localhost:${PORT}`);
});
