// Configuration lue dans l'environnement, validée une seule fois au démarrage.
import 'dotenv/config';

const isProduction = process.env.NODE_ENV === 'production';
const MIN_SECRET_LENGTH = 32;
const PLACEHOLDER = /^(change-me|dev-insecure|your-)/i;

// Lit un secret obligatoire. En production, un secret absent, trop court ou
// resté à sa valeur d'exemple empêche le démarrage (plutôt qu'un repli
// silencieux sur une valeur connue de tous). En développement, une valeur de
// repli est utilisée avec un avertissement.
export function readSecret(name, env = process.env, production = isProduction) {
  const value = env[name];
  const weak = !value || value.length < MIN_SECRET_LENGTH || PLACEHOLDER.test(value);
  if (!weak) return value;
  if (production) {
    throw new Error(
      `${name} est absent, trop court (moins de ${MIN_SECRET_LENGTH} caractères) ou resté à sa valeur d'exemple. ` +
      'Générez-en un avec : openssl rand -hex 32'
    );
  }
  if (env === process.env) {
    console.warn(`⚠ ${name} absent ou trop faible : valeur de développement utilisée (refusée en production).`);
  }
  return `dev-insecure-${name}-not-for-production`;
}

// Nombre de proxys de confiance devant l'application (Traefik, Nginx…), pour
// que l'adresse IP du client soit correcte (limitation de débit).
function readTrustProxy(raw) {
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function readTimeZone(raw) {
  const zone = raw || 'Europe/Paris';
  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone: zone });
    return zone;
  } catch {
    console.warn(`⚠ APP_TIMEZONE invalide (${zone}) : Europe/Paris utilisé.`);
    return 'Europe/Paris';
  }
}

export const config = {
  isProduction,
  port: Number(process.env.PORT || 3000),
  baseUrl: (process.env.BASE_URL || '').replace(/\/$/, ''),
  jwtSecret: readSecret('JWT_SECRET'),
  emailHashSecret: readSecret('EMAIL_HASH_SECRET'),
  trustProxy: readTrustProxy(process.env.TRUST_PROXY),
  // Fuseau d'affichage des dates et de lecture des saisies sans JavaScript.
  timeZone: readTimeZone(process.env.APP_TIMEZONE),
};
