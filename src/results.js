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
            COUNT(s.score)                 AS votes_count
       FROM options o
       LEFT JOIN ballot_scores s ON s.option_id = o.id
      WHERE o.poll_id = $1
      GROUP BY o.id, o.label, o.description, o.position
      ORDER BY total DESC, o.position ASC`,
    [pollId]
  );

  const { rows: ballotRows } = await query(
    'SELECT COUNT(*)::int AS n FROM ballots WHERE poll_id = $1',
    [pollId]
  );
  const ballotCount = ballotRows[0].n;

  // Attribution des rangs avec gestion des égalités (rang standard "1224").
  let rank = 0;
  let prevTotal = null;
  let seen = 0;
  const ranked = rows.map((r) => {
    seen += 1;
    if (r.total !== prevTotal) {
      rank = seen;
      prevTotal = r.total;
    }
    return { ...r, rank };
  });

  return { options: ranked, ballotCount };
}
