import { config } from './config.js';
import { createApp } from './app.js';
import { purgeClosedSubscriptions } from './services/followups.js';

const app = createApp();
app.listen(config.port, () => {
  console.log(`✅ Vote de valeur démarré sur le port ${config.port}`);
});

// Effacement, toutes les heures, des adresses gardées pour prévenir des nouveaux
// choix dans les scrutins clos (statut ou date de clôture passée).
async function purge() {
  try {
    const n = await purgeClosedSubscriptions();
    if (n) console.log(`Adresses d'avis effacées (scrutins clos) : ${n}`);
  } catch (err) {
    console.error('Effacement des adresses d\'avis échoué :', err.code || err.name);
  }
}
purge();
setInterval(purge, 3600_000).unref();
