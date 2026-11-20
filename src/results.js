import { query } from './db.js';

// Calcule le classement des options d'un vote.
// Règle retenue : SOMME des scores, abstention = 0.
// Comme chaque bulletin contient une ligne (score, défaut 0) par option,
// la somme sur ballot_scores traite naturellement l'abstention comme 0.
// Les égalités sont autorisées : même somme => même rang.
export async function computeResults(pollId) {
  const { rows } = await query(
    `SELECT o.id, o.label, o.description, o.position,
            (o.image_data IS NOT NULL) AS has_image,
            COALESCE(SUM(s.score), 0)::int AS total,
            COUNT(s.score)::int            AS votes_count
       FROM options o
       LEFT JOIN ballot_scores s ON s.option_id = o.id
      WHERE o.poll_id = $1
      GROUP BY o.id, o.label, o.description, o.position
      ORDER BY total DESC, o.position ASC`,
    [pollId]
  );

  const { rows: ballotRows } = await query(
    'SELECT COUNT(*)::int AS n FROM ballots WHERE poll_id = $1 AND NOT is_supplement',
    [pollId]
  );
  const ballotCount = ballotRows[0].n;

  return { options: rankOptions(rows), ballotCount };
}

// Attribue les rangs à des options déjà triées par total décroissant, avec
// gestion des égalités (classement standard « 1224 » : deux ex æquo partagent
// le même rang, le suivant prend le rang correspondant à sa position).
export function rankOptions(sorted) {
  let rank = 0;
  let prevTotal = null;
  return sorted.map((option, index) => {
    if (option.total !== prevTotal) {
      rank = index + 1;
      prevTotal = option.total;
    }
    return { ...option, rank };
  });
}
