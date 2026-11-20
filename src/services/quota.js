// Compteurs à fenêtre fixe, en mémoire (une seule instance de l'application).
// Servent à plafonner les emails envoyés via l'API, quel que soit le nombre de
// jetons utilisés.
export function createQuota({ limit, windowMs }) {
  const windows = new Map();
  return {
    limit,
    // Réserve `amount` unités pour `key` ; false si le plafond serait dépassé.
    take(key, amount) {
      const now = Date.now();
      let w = windows.get(key);
      if (!w || now - w.start >= windowMs) {
        w = { start: now, used: 0 };
        windows.set(key, w);
      }
      if (w.used + amount > limit) return false;
      w.used += amount;
      return true;
    },
  };
}

// Quota d'emails envoyés à des tiers à la demande d'un organisateur
// (invitations, avis de nouveaux choix), partagé par l'interface et l'API.
export const EMAILS_PER_HOUR = { user: 500, service: Number(process.env.API_INVITATIONS_PER_HOUR) || 2000 };
const userEmails = createQuota({ limit: EMAILS_PER_HOUR.user, windowMs: 3600_000 });
const serviceEmails = createQuota({ limit: EMAILS_PER_HOUR.service, windowMs: 3600_000 });

// Réserve `amount` emails pour l'organisateur ; false si un plafond serait dépassé.
export function takeEmails(userId, amount) {
  if (!userEmails.take(userId, amount)) return false;
  if (!serviceEmails.take('service', amount)) {
    userEmails.take(userId, -amount); // rend la réservation
    return false;
  }
  return true;
}
