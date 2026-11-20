// Logique métier des scrutins, partagée par les pages HTML et l'API.
// Les fonctions reçoivent des valeurs déjà extraites de la requête et lèvent
// une ServiceError en cas de refus ; elles ne connaissent ni Express ni HTTP.
import { query, tx } from '../db.js';
import { hashPassword } from '../auth.js';
import { computeResults } from '../results.js';
import { notFound, forbidden, invalid, conflict } from './errors.js';

export const LIMITS = {
  title: 200,
  description: 5000,
  label: 200,
  optionDescription: 1000,
  options: 50,
  minOptions: 2,
  password: { min: 4, max: 200 },
};
// Seuil par défaut des nouveaux scrutins : résultats masqués sous 5 bulletins.
export const DEFAULT_MIN_BALLOTS = 5;
export const MAX_MIN_BALLOTS = 10000;
export const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const IMAGE_MAX_BYTES = 3 * 1024 * 1024;

const text = (v) => (v === undefined || v === null ? '' : String(v).trim());

function checkLength(value, max, what) {
  if (value.length > max) throw invalid(`${what} : ${max} caractères maximum.`);
  return value;
}

// Normalise une option ; image = { buffer, mimetype } ou null.
function normalizeOption(o, index) {
  const label = checkLength(text(o.label), LIMITS.label, `Intitulé de l'option ${index + 1}`);
  const description = checkLength(text(o.description), LIMITS.optionDescription, `Description de l'option ${index + 1}`);
  const image = o.image || null;
  if (image && !IMAGE_MIME.has(image.mimetype)) throw invalid('Image : formats PNG, JPEG, WebP ou GIF uniquement.');
  return { label, description, image };
}

// Un vote est-il effectivement clos ? (statut ou date de clôture dépassée)
export function isClosed(poll) {
  if (poll.status === 'closed') return true;
  return Boolean(poll.close_at && new Date(poll.close_at) <= new Date());
}

function checkMinBallots(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_MIN_BALLOTS) {
    throw invalid(`Seuil de publication des résultats : entier de 0 à ${MAX_MIN_BALLOTS}.`);
  }
  return value;
}

// Les résultats sont-ils visibles pour ce lecteur ? viewer : 'voter' | 'owner'.
export function resultsVisible(poll, ballotCount, viewer) {
  if (viewer === 'owner' && poll.is_nominative) return true;
  return ballotCount >= (poll.min_ballots_for_results || 0);
}

// Résultats tels qu'un lecteur a le droit de les voir : sous le seuil, le
// nombre de bulletins seulement, aucune note ni aucun classement.
export async function visibleResults(poll, viewer) {
  const { options, ballotCount } = await computeResults(poll.id);
  const visible = resultsVisible(poll, ballotCount, viewer);
  return { visible, ballotCount, threshold: poll.min_ballots_for_results || 0, options: visible ? options : [] };
}

export async function listPolls(ownerId) {
  const { rows } = await query(
    `SELECT p.*, (SELECT COUNT(*) FROM ballots b WHERE b.poll_id = p.id AND NOT b.is_supplement)::int AS ballots
       FROM polls p
      WHERE p.owner_id = $1
      ORDER BY p.created_at DESC`,
    [ownerId]
  );
  return rows;
}

// input : { title, description, isPrivate, password, isNominative, authMode, minBallots,
//           closeAt (Date|null), options: [{ label, description, image }] }
export async function createPoll(ownerId, input) {
  const title = checkLength(text(input.title), LIMITS.title, 'Titre');
  const description = checkLength(text(input.description), LIMITS.description, 'Description');
  const isPrivate = Boolean(input.isPrivate);
  const password = input.password === undefined || input.password === null ? '' : String(input.password);
  const authMode = input.authMode === 'name' ? 'name' : 'email';
  const options = (input.options || [])
    .map(normalizeOption)
    .filter((o) => o.label.length > 0 || o.image);

  if (!title) throw invalid('Titre requis.');
  if (options.length < LIMITS.minOptions) throw invalid('Au moins 2 options (image ou intitulé) sont requises.');
  if (options.length > LIMITS.options) throw invalid(`${LIMITS.options} options au maximum.`);
  if (isPrivate && (password.length < LIMITS.password.min || password.length > LIMITS.password.max)) {
    throw invalid('Mot de passe de 4 à 200 caractères pour un vote privé.');
  }
  if (input.closeAt !== null && input.closeAt !== undefined && !(input.closeAt instanceof Date && !Number.isNaN(input.closeAt.getTime()))) {
    throw invalid('Date de clôture invalide.');
  }
  const minBallots = input.minBallots === undefined || input.minBallots === null ? DEFAULT_MIN_BALLOTS : checkMinBallots(input.minBallots);
  const passwordHash = isPrivate ? await hashPassword(password) : null;

  return tx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO polls (owner_id, title, description, is_private, password_hash, close_at, is_nominative, auth_mode, min_ballots_for_results)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [ownerId, title, description, isPrivate, passwordHash, input.closeAt || null, Boolean(input.isNominative), authMode, minBallots]
    );
    const id = rows[0].id;
    for (let i = 0; i < options.length; i++) {
      const o = options[i];
      await client.query(
        `INSERT INTO options (poll_id, label, description, image_data, image_mime, position)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, o.label, o.description, o.image ? o.image.buffer : null, o.image ? o.image.mimetype : null, i]
      );
    }
    return id;
  });
}

// Scrutin appartenant à l'utilisateur, ou erreur (404 s'il n'existe pas,
// 403 s'il appartient à quelqu'un d'autre).
export async function getOwnedPoll(ownerId, pollId) {
  const { rows } = await query('SELECT * FROM polls WHERE id = $1', [pollId]);
  const poll = rows[0];
  if (!poll) throw notFound();
  if (poll.owner_id !== ownerId) throw forbidden();
  return poll;
}

export async function listOptions(pollId) {
  const { rows } = await query(
    `SELECT id, label, description, position, (image_data IS NOT NULL) AS has_image
       FROM options WHERE poll_id = $1 ORDER BY position`,
    [pollId]
  );
  return rows;
}

export async function voterStats(pollId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS requested, COUNT(voted_at)::int AS voted
       FROM poll_voters WHERE poll_id = $1`,
    [pollId]
  );
  return rows[0];
}

export { computeResults };

// Détail nominatif des participants (scrutin nominatif uniquement) : identité
// en clair et notes de leur bulletin lié. Les votants enregistrés avant le
// passage en nominatif restent anonymes (identité nulle, bulletin non lié).
export async function listParticipants(poll) {
  if (!poll.is_nominative) throw conflict('Détail des participants disponible seulement pour un scrutin nominatif.');
  const { rows: voters } = await query(
    `SELECT pv.id, pv.email, pv.display_name, pv.voted_at
       FROM poll_voters pv
      WHERE pv.poll_id = $1
      ORDER BY (pv.voted_at IS NULL), pv.display_name NULLS LAST, pv.email NULLS LAST, pv.created_at`,
    [poll.id]
  );
  // Notes des bulletins liés (bulletin principal et éventuels compléments).
  const { rows: scores } = await query(
    `SELECT b.voter_id, s.option_id, s.score
       FROM ballots b JOIN ballot_scores s ON s.ballot_id = b.id
      WHERE b.poll_id = $1 AND b.voter_id IS NOT NULL`,
    [poll.id]
  );
  const { rows: linked } = await query(
    'SELECT DISTINCT voter_id FROM ballots WHERE poll_id = $1 AND voter_id IS NOT NULL', [poll.id]
  );
  const hasBallot = new Set(linked.map((r) => r.voter_id));
  const byVoter = {};
  for (const r of scores) (byVoter[r.voter_id] ||= {})[r.option_id] = r.score;
  return voters.map((v) => ({
    email: v.email,
    name: v.display_name,
    voted: Boolean(v.voted_at),
    anonymous: Boolean(v.voted_at) && !hasBallot.has(v.id), // a voté avant le passage en nominatif
    scores: hasBallot.has(v.id) ? (byVoter[v.id] || {}) : null,
  }));
}

// changes : { title?, description?, closeAt? (Date ou null pour retirer),
//             status? ('open'|'closed'), isNominative? }
export async function updatePoll(poll, changes) {
  const sets = [];
  const values = [];
  const set = (column, value) => { values.push(value); sets.push(`${column} = $${values.length}`); };

  if (changes.title !== undefined) {
    const title = checkLength(text(changes.title), LIMITS.title, 'Titre');
    if (!title) throw invalid('Le titre ne peut pas être vide.');
    set('title', title);
  }
  if (changes.description !== undefined) {
    set('description', checkLength(text(changes.description), LIMITS.description, 'Description'));
  }
  if (changes.closeAt !== undefined) {
    if (changes.closeAt !== null && !(changes.closeAt instanceof Date && !Number.isNaN(changes.closeAt.getTime()))) {
      throw invalid('Date de clôture invalide.');
    }
    set('close_at', changes.closeAt);
  }
  if (changes.status !== undefined) {
    if (changes.status !== 'open' && changes.status !== 'closed') throw invalid('Statut : "open" ou "closed".');
    set('status', changes.status);
  }
  if (changes.isNominative !== undefined) set('is_nominative', Boolean(changes.isNominative));
  if (changes.minBallots !== undefined) set('min_ballots_for_results', checkMinBallots(changes.minBallots));
  if (!sets.length) return poll;

  values.push(poll.id);
  return tx(async (client) => {
    const { rows } = await client.query(`UPDATE polls SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`, values);
    if (!rows[0]) throw notFound();
    // Retour au vote secret : les personnes inscrites mais n'ayant pas encore
    // voté voteront en secret, leur identité en clair n'a plus lieu d'être.
    // (Les bulletins déjà déposés en nominatif restent liés, mais ne sont plus affichés.)
    // Clôture : les adresses des votants qui voulaient être prévenus sont effacées.
    if (changes.status === 'closed') {
      await client.query('DELETE FROM voter_notifications WHERE poll_id = $1', [poll.id]);
    }
    if (changes.isNominative === false) {
      await client.query(
        `UPDATE poll_voters SET email = NULL, display_name = NULL
          WHERE poll_id = $1 AND voted_at IS NULL AND (email IS NOT NULL OR display_name IS NOT NULL)`,
        [poll.id]
      );
    }
    return rows[0];
  });
}

export async function deletePoll(poll) {
  await query('DELETE FROM polls WHERE id = $1', [poll.id]);
}

// option : { label, description, image }
export async function addOption(poll, option) {
  const o = normalizeOption(option, 0);
  if (!o.label && !o.image) throw invalid('Une option doit avoir au moins un intitulé ou une image.');
  return tx(async (client) => {
    // Verrou sur le scrutin : positions et nombre d'options cohérents en cas d'ajouts simultanés.
    await client.query('SELECT id FROM polls WHERE id = $1 FOR UPDATE', [poll.id]);
    const { rows: stats } = await client.query(
      'SELECT COUNT(*)::int AS n, COALESCE(MAX(position), -1) + 1 AS next FROM options WHERE poll_id = $1',
      [poll.id]
    );
    if (stats[0].n >= LIMITS.options) throw conflict(`${LIMITS.options} options au maximum.`);
    const { rows } = await client.query(
      `INSERT INTO options (poll_id, label, description, image_data, image_mime, position)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, label, description, position, (image_data IS NOT NULL) AS has_image`,
      [poll.id, o.label, o.description, o.image ? o.image.buffer : null, o.image ? o.image.mimetype : null, stats[0].next]
    );
    return rows[0];
  });
}

// changes : { label?, description? } ; un champ absent reste inchangé.
export async function editOption(poll, optionId, changes) {
  const label = changes.label === undefined ? null : checkLength(text(changes.label), LIMITS.label, 'Intitulé');
  const description = changes.description === undefined
    ? null
    : checkLength(text(changes.description), LIMITS.optionDescription, 'Description');
  // Mise à jour des seuls champs fournis, en une requête (pas de perte en cas
  // de modifications simultanées) ; une option sans image garde un intitulé.
  const { rows } = await query(
    `UPDATE options
        SET label = COALESCE($1, label), description = COALESCE($2, description)
      WHERE id = $3 AND poll_id = $4
        AND (image_data IS NOT NULL OR COALESCE($1, label) <> '')
      RETURNING id, label, description, position, (image_data IS NOT NULL) AS has_image`,
    [label, description, optionId, poll.id]
  );
  if (rows[0]) return rows[0];
  const { rows: exists } = await query('SELECT 1 FROM options WHERE id = $1 AND poll_id = $2', [optionId, poll.id]);
  if (!exists[0]) throw notFound('Option introuvable.');
  throw invalid('Une option sans image doit conserver un intitulé.');
}

// Remplace l'image d'une option ; image = { buffer, mimetype }.
export async function setOptionImage(poll, optionId, image) {
  if (!image) throw invalid('Image attendue (champ « image »).');
  if (!IMAGE_MIME.has(image.mimetype)) throw invalid('Image : formats PNG, JPEG, WebP ou GIF uniquement.');
  const { rows } = await query(
    `UPDATE options SET image_data = $1, image_mime = $2 WHERE id = $3 AND poll_id = $4
     RETURNING id, label, description, position, (image_data IS NOT NULL) AS has_image`,
    [image.buffer, image.mimetype, optionId, poll.id]
  );
  if (!rows[0]) throw notFound('Option introuvable.');
  return rows[0];
}

// Un scrutin doit conserver au moins 2 options.
export async function deleteOption(poll, optionId) {
  await tx(async (client) => {
    await client.query('SELECT id FROM polls WHERE id = $1 FOR UPDATE', [poll.id]);
    const { rows } = await client.query(
      'SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE id = $2)::int AS found FROM options WHERE poll_id = $1',
      [poll.id, optionId]
    );
    if (!rows[0].found) throw notFound('Option introuvable.');
    if (rows[0].n <= LIMITS.minOptions) throw conflict('Un vote doit conserver au moins 2 options.');
    await client.query('DELETE FROM options WHERE id = $1 AND poll_id = $2', [optionId, poll.id]);
  });
}
