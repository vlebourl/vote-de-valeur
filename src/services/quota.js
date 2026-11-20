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
