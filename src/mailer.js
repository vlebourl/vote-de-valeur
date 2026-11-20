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

// Avis à un votant qui l'a demandé : de nouveaux choix ont été ajoutés depuis
// son vote. Le lien lui permet de les noter (son lien précédent reste valable).
export async function sendNewOptionsNotice({ to, pollTitle, labels, url }) {
  const subject = `Nouveau choix à noter : « ${pollTitle} »`;
  const list = labels.map((l) => `  • ${l}`).join('\n');
  const text = `Bonjour,\n\nVous avez voté pour « ${pollTitle} » et demandé à être prévenu(e) des nouveaux choix.\n` +
    `Depuis votre vote, ${labels.length > 1 ? 'ces choix ont été ajoutés' : 'ce choix a été ajouté'} :\n${list}\n\n` +
    `Notez-${labels.length > 1 ? 'les' : 'le'} avec ce lien personnel (vos autres notes restent inchangées) :\n${url}\n\n` +
    `Votre lien précédent reste valable. Ne partagez pas ce lien personnel.\n\n— Vote de valeur`;
  const html = `<p>Bonjour,</p>
<p>Vous avez voté pour <strong>« ${escapeHtml(pollTitle)} »</strong> et demandé à être prévenu(e) des nouveaux choix. Depuis votre vote :</p>
<ul>${labels.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
<p><a href="${url}" style="display:inline-block;padding:12px 20px;background:#4f46e5;color:#fff;border-radius:8px;text-decoration:none">Noter ${labels.length > 1 ? 'ces choix' : 'ce choix'}</a></p>
<p style="color:#666;font-size:13px">Vos autres notes restent inchangées. Votre lien précédent reste valable. Ne partagez pas ce lien personnel.</p>`;
  if (DEV_MODE) {
    keepInOutbox({ kind: 'new-options', to, url, labels });
    console.log('\n📧 [SMTP_DEV_MODE] Avis de nouveau choix non envoyé :');
    console.log(`   → ${to} : ${url}\n`);
    return { devMode: true };
  }
  return transporter.sendMail({ from: FROM, to, subject, text, html });
}

// Confirmation envoyée au votant après son vote : l'enregistrement et son lien
// personnel, rien d'autre. Ni résultats, ni ses propres notes : un email se
// conserve et se transfère (y compris dans le dossier « Envoyés » de
// l'expéditeur) et ne doit révéler aucun vote.
export async function sendVoteConfirmation({ to, pollTitle, permalink, supplement = false }) {
  const subject = `Confirmation de votre vote : « ${pollTitle} »`;
  const what = supplement ? 'Vos notes pour les nouveaux choix ont bien été enregistrées' : 'Votre vote a bien été enregistré';
  const text = `Bonjour,\n\n${what} pour « ${pollTitle} ». Merci !\n\n` +
    `Pour préserver le secret du vote, cet email ne contient pas vos notes.\n\n` +
    `Suivez les résultats avec ce lien personnel (à conserver, ne le partagez pas) :\n${permalink}\n\n— Vote de valeur`;
  const html = `<p>Bonjour,</p>
<p>${what} pour <strong>« ${escapeHtml(pollTitle)} »</strong>. Merci !</p>
<p style="color:#666;font-size:13px">Pour préserver le secret du vote, cet email ne contient pas vos notes.</p>
<p><a href="${permalink}" style="display:inline-block;padding:12px 20px;background:#4f46e5;color:#fff;border-radius:8px;text-decoration:none">Suivre les résultats</a></p>
<p style="color:#666;font-size:13px">Lien personnel à conserver, ne le partagez pas :<br>${permalink}</p>`;

  if (DEV_MODE) {
    keepInOutbox({ kind: 'confirmation', to, permalink, text, html });
    console.log('\n📧 [SMTP_DEV_MODE] Confirmation de vote non envoyée :');
    console.log(`   → ${to} : ${permalink}\n`);
    return { devMode: true };
  }
  return transporter.sendMail({ from: FROM, to, subject, text, html });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
