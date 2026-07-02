import nodemailer from 'nodemailer';

const DEV_MODE = String(process.env.SMTP_DEV_MODE).toLowerCase() === 'true';

let transporter = null;
if (!DEV_MODE) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  });
}

const FROM = process.env.SMTP_FROM || 'Vote de valeur <noreply@example.com>';

export async function sendMagicLink({ to, pollTitle, url }) {
  const subject = `Votez : « ${pollTitle} »`;
  const text = `Bonjour,\n\nVous avez demandé à participer au vote « ${pollTitle} ».\nCliquez sur ce lien personnel et unique pour accéder au bulletin :\n\n${url}\n\nCe lien ne fonctionne qu'une fois et vous identifie comme votant. Ne le partagez pas.\n\n— Vote de valeur`;
  const html = `<p>Bonjour,</p>
<p>Vous avez demandé à participer au vote <strong>« ${escapeHtml(pollTitle)} »</strong>.</p>
<p><a href="${url}" style="display:inline-block;padding:12px 20px;background:#4f46e5;color:#fff;border-radius:8px;text-decoration:none">Accéder au bulletin</a></p>
<p style="color:#666;font-size:13px">Ce lien personnel et unique ne fonctionne qu'une fois. Ne le partagez pas.</p>
<p style="color:#666;font-size:13px">Ou copiez ce lien : ${url}</p>`;

  if (DEV_MODE) {
    console.log('\n📧 [SMTP_DEV_MODE] Email non envoyé. Lien magique :');
    console.log(`   → ${to} : ${url}\n`);
    return { devMode: true };
  }

  return transporter.sendMail({ from: FROM, to, subject, text, html });
}

// Confirmation envoyée au votant après son vote : son bulletin, les résultats
// du moment, et le permalien (qui reste à jour en temps réel).
export async function sendVoteConfirmation({ to, pollTitle, myScores, results, permalink }) {
  const subject = `Confirmation de votre vote : « ${pollTitle} »`;
  const fmt = (s) => (s > 0 ? '+' + s : String(s));
  const myLines = myScores.map((o) => `  • ${o.label || '(image)'} : ${fmt(o.score)}`).join('\n');
  const resLines = results.map((o) => `  ${o.rank}. ${o.label || '(image)'} — ${fmt(o.total)}`).join('\n');
  const text = `Bonjour,\n\nVotre vote pour « ${pollTitle} » a bien été enregistré. Merci !\n\n` +
    `Votre vote :\n${myLines}\n\nRésultats actuels :\n${resLines}\n\n` +
    `Consultez les résultats à jour à tout moment (lien à conserver) :\n${permalink}\n\n— Vote de valeur`;
  const myHtml = myScores.map((o) => `<li>${escapeHtml(o.label || '(image)')} : <strong>${fmt(o.score)}</strong></li>`).join('');
  const resHtml = results.map((o) => `<li>${o.rank}. ${escapeHtml(o.label || '(image)')} — <strong>${fmt(o.total)}</strong></li>`).join('');
  const html = `<p>Bonjour,</p>
<p>Votre vote pour <strong>« ${escapeHtml(pollTitle)} »</strong> a bien été enregistré. Merci !</p>
<p><strong>Votre vote :</strong></p><ul>${myHtml}</ul>
<p><strong>Résultats actuels :</strong></p><ul>${resHtml}</ul>
<p><a href="${permalink}" style="display:inline-block;padding:12px 20px;background:#4f46e5;color:#fff;border-radius:8px;text-decoration:none">Voir les résultats à jour</a></p>
<p style="color:#666;font-size:13px">Ce lien reste valable et affiche les résultats en temps réel :<br>${permalink}</p>`;

  if (DEV_MODE) {
    console.log('\n📧 [SMTP_DEV_MODE] Confirmation de vote non envoyée :');
    console.log(`   → ${to} : ${permalink}\n`);
    return { devMode: true };
  }
  return transporter.sendMail({ from: FROM, to, subject, text, html });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
