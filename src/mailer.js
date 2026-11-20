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

// En mode développement, les emails ne partent pas : ils sont affichés dans la
// console et gardés ici (les 50 derniers), ce qui sert aussi aux tests.
export const devOutbox = [];
// Mode développement : nombre de prochains envois à faire échouer (tests).
export const devFailures = { next: 0 };
function keepInOutbox(message) {
  if (devFailures.next > 0) {
    devFailures.next -= 1;
    throw Object.assign(new Error('Échec SMTP simulé'), { code: 'EDEVFAIL' });
  }
  devOutbox.push(message);
  if (devOutbox.length > 50) devOutbox.shift();
}

export async function sendMagicLink({ to, pollTitle, url }) {
  const subject = `Votez : « ${pollTitle} »`;
  const text = `Bonjour,\n\nVous avez demandé à participer au vote « ${pollTitle} ».\nCliquez sur ce lien personnel pour accéder au bulletin :\n\n${url}\n\nCe lien vous identifie comme votant : ne le partagez pas. Une nouvelle demande remplace ce lien par un nouveau.\n\n— Vote de valeur`;
  const html = `<p>Bonjour,</p>
<p>Vous avez demandé à participer au vote <strong>« ${escapeHtml(pollTitle)} »</strong>.</p>
<p><a href="${url}" style="display:inline-block;padding:12px 20px;background:#4f46e5;color:#fff;border-radius:8px;text-decoration:none">Accéder au bulletin</a></p>
<p style="color:#666;font-size:13px">Ce lien vous identifie comme votant : ne le partagez pas. Une nouvelle demande le remplace par un nouveau.</p>
<p style="color:#666;font-size:13px">Ou copiez ce lien : ${url}</p>`;

  if (DEV_MODE) {
    keepInOutbox({ kind: 'magic-link', to, url });
    console.log('\n📧 [SMTP_DEV_MODE] Email non envoyé. Lien magique :');
    console.log(`   → ${to} : ${url}\n`);
    return { devMode: true };
  }

  return transporter.sendMail({ from: FROM, to, subject, text, html });
}

// Confirmation envoyée au votant après son vote : le rappel de SES notes et le
// permalien des résultats. Jamais de résultats dans l'email : un email se
// transfère et se conserve, et un total figé sur peu de bulletins trahirait des votes.
export async function sendVoteConfirmation({ to, pollTitle, myScores, permalink }) {
  const subject = `Confirmation de votre vote : « ${pollTitle} »`;
  const fmt = (s) => (s > 0 ? '+' + s : String(s));
  const myLines = myScores.map((o) => `  • ${o.label || '(image)'} : ${fmt(o.score)}`).join('\n');
  const text = `Bonjour,\n\nVotre vote pour « ${pollTitle} » a bien été enregistré. Merci !\n\n` +
    `Votre vote :\n${myLines}\n\n` +
    `Suivez les résultats à tout moment avec ce lien personnel (à conserver, ne le partagez pas) :\n${permalink}\n\n— Vote de valeur`;
  const myHtml = myScores.map((o) => `<li>${escapeHtml(o.label || '(image)')} : <strong>${fmt(o.score)}</strong></li>`).join('');
  const html = `<p>Bonjour,</p>
<p>Votre vote pour <strong>« ${escapeHtml(pollTitle)} »</strong> a bien été enregistré. Merci !</p>
<p><strong>Votre vote :</strong></p><ul>${myHtml}</ul>
<p><a href="${permalink}" style="display:inline-block;padding:12px 20px;background:#4f46e5;color:#fff;border-radius:8px;text-decoration:none">Suivre les résultats</a></p>
<p style="color:#666;font-size:13px">Lien personnel à conserver, ne le partagez pas :<br>${permalink}</p>`;

  if (DEV_MODE) {
    keepInOutbox({ kind: 'confirmation', to, permalink, myScores, text, html });
    console.log('\n📧 [SMTP_DEV_MODE] Confirmation de vote non envoyée :');
    console.log(`   → ${to} : ${permalink}\n`);
    return { devMode: true };
  }
  return transporter.sendMail({ from: FROM, to, subject, text, html });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
