// Dates de clôture : saisies dans le navigateur (heure locale du créateur),
// stockées en UTC, affichées dans le fuseau de l'application.

// Décalage (ms) du fuseau `timeZone` par rapport à UTC à l'instant `ts`.
function offsetMs(ts, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(ts).map((p) => [p.type, p.value])
  );
  const wallAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wallAsUtc - Math.floor(ts / 1000) * 1000;
}

// « 2026-11-20T18:00 » vu dans `timeZone` → instant UTC (Date), ou null.
export function zonedLocalToUtc(local, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let ts = wall - offsetMs(wall, timeZone);
  const corrected = wall - offsetMs(ts, timeZone); // changement d'heure
  if (corrected !== ts) ts = corrected;
  return new Date(ts);
}

// Date de clôture d'un formulaire : l'instant UTC calculé par le navigateur
// (close_at_utc) s'il est présent, sinon la saisie brute lue dans le fuseau de
// l'application (navigateur sans JavaScript).
// Renvoie null (pas de clôture), une Date, ou undefined si la saisie est invalide.
export function parseCloseAt(body, timeZone) {
  const utc = String(body.close_at_utc || '').trim();
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(utc)) {
    const d = new Date(utc);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const local = String(body.close_at || '').trim();
  if (!local) return null;
  return zonedLocalToUtc(local, timeZone) || undefined;
}

// « 20/11 à 18:00 » dans le fuseau donné.
export function formatDateTime(date, timeZone) {
  if (!date) return '';
  const fmt = new Intl.DateTimeFormat('fr-FR', {
    timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(date));
  const p = Object.fromEntries(fmt.map((x) => [x.type, x.value]));
  return `${p.day}/${p.month} à ${p.hour}:${p.minute}`;
}
