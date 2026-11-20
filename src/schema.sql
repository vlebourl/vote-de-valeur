-- Schéma "Vote de valeur"
-- Extension pour générer des UUID côté serveur si besoin
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Créateurs de votes (comptes)
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un vote (scrutin)
CREATE TABLE IF NOT EXISTS polls (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  is_private    BOOLEAN NOT NULL DEFAULT false,
  password_hash TEXT,                 -- si privé : hash du mot de passe d'accès
  status        TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'closed'
  close_at      TIMESTAMPTZ,          -- clôture automatique optionnelle
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_polls_owner ON polls(owner_id);

-- Options proposées dans un vote
CREATE TABLE IF NOT EXISTS options (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id     UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  label       TEXT NOT NULL DEFAULT '',   -- intitulé optionnel (image OU texte requis)
  description TEXT NOT NULL DEFAULT '',
  image_data  BYTEA,                       -- image téléversée, stockée en base
  image_mime  TEXT,                        -- type MIME de l'image
  position    INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_options_poll ON options(poll_id);

-- Migration idempotente pour les bases existantes
ALTER TABLE options ADD COLUMN IF NOT EXISTS image_data BYTEA;
ALTER TABLE options ADD COLUMN IF NOT EXISTS image_mime TEXT;
ALTER TABLE options ALTER COLUMN label DROP NOT NULL;
ALTER TABLE options ALTER COLUMN label SET DEFAULT '';

-- Participation d'un votant à un vote (identité, séparée des scores)
-- email_hash = HMAC(email ou nom) : garantit l'unicité sans stocker l'identité en clair.
-- token_hash = SHA-256 du jeton du lien de vote : le jeton lui-même n'est jamais stocké.
CREATE TABLE IF NOT EXISTS poll_voters (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id       UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  email_hash    TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  verified_at   TIMESTAMPTZ,            -- ouverture du lien (au jour près si scrutin secret)
  voted_at      TIMESTAMPTZ,            -- soumission du bulletin (au jour près si scrutin secret)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (poll_id, email_hash)          -- 1 email = 1 vote par scrutin
);
CREATE INDEX IF NOT EXISTS idx_voters_poll ON poll_voters(poll_id);

-- Un bulletin (anonyme, non liable à l'identité du votant)
-- created_at n'est renseigné qu'en scrutin nominatif.
CREATE TABLE IF NOT EXISTS ballots (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id    UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ballots_poll ON ballots(poll_id);

-- Scores d'un bulletin, une ligne par option (-2..+2 ; abstention = 0)
CREATE TABLE IF NOT EXISTS ballot_scores (
  ballot_id UUID NOT NULL REFERENCES ballots(id) ON DELETE CASCADE,
  option_id UUID NOT NULL REFERENCES options(id) ON DELETE CASCADE,
  score     INT NOT NULL CHECK (score BETWEEN -2 AND 2),
  PRIMARY KEY (ballot_id, option_id)
);
CREATE INDEX IF NOT EXISTS idx_scores_option ON ballot_scores(option_id);

-- === Scrutin nominatif (option par vote) ===
-- Par défaut, le vote est SECRET : l'email n'est stocké que haché (email_hash)
-- et aucun lien n'existe entre un votant et son bulletin.
-- Si un scrutin est marqué nominatif, on stocke en plus l'email/nom en clair
-- et on relie chaque bulletin déposé à son votant (dé-anonymisation assumée).
ALTER TABLE polls        ADD COLUMN IF NOT EXISTS is_nominative BOOLEAN NOT NULL DEFAULT false;
-- Mode d'identification du votant : 'email' (lien magique, défaut) ou 'name'
-- (mode léger : on saisit son nom, un nom = un vote, sans email).
ALTER TABLE polls        ADD COLUMN IF NOT EXISTS auth_mode TEXT NOT NULL DEFAULT 'email';
ALTER TABLE poll_voters  ADD COLUMN IF NOT EXISTS email        TEXT;   -- en clair, uniquement si nominatif
ALTER TABLE poll_voters  ADD COLUMN IF NOT EXISTS display_name TEXT;   -- nom optionnel, uniquement si nominatif
ALTER TABLE ballots      ADD COLUMN IF NOT EXISTS voter_id     UUID REFERENCES poll_voters(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ballots_voter ON ballots(voter_id);

-- === Secret du bulletin (migration des bases existantes) ===
-- 1. Les jetons des liens ne sont plus stockés en clair, seulement leur SHA-256
--    (les liens déjà envoyés restent valables).
ALTER TABLE poll_voters ADD COLUMN IF NOT EXISTS token_hash   TEXT;
-- Email chiffré avec une clé dérivée du jeton du votant (scrutin secret), effacé après le vote.
ALTER TABLE poll_voters ADD COLUMN IF NOT EXISTS email_sealed TEXT;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'poll_voters' AND column_name = 'magic_token') THEN
    UPDATE poll_voters SET token_hash = encode(digest(magic_token, 'sha256'), 'hex') WHERE token_hash IS NULL;
    ALTER TABLE poll_voters DROP COLUMN magic_token;
  END IF;
END $$;
ALTER TABLE poll_voters ALTER COLUMN token_hash SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS poll_voters_token_hash_key ON poll_voters(token_hash);

-- 2. Scrutins secrets : aucune identité en clair pour les votants dont le
--    bulletin n'est pas lié (un bulletin lié a été déposé en scrutin nominatif).
UPDATE poll_voters pv
   SET email = NULL, display_name = NULL
  FROM polls p
 WHERE p.id = pv.poll_id AND NOT p.is_nominative
   AND (pv.email IS NOT NULL OR pv.display_name IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM ballots b WHERE b.voter_id = pv.id);

-- 3. Pas d'horodatage précis qui permettrait de rapprocher un votant de son
--    bulletin anonyme.
ALTER TABLE ballots ALTER COLUMN created_at DROP NOT NULL;
ALTER TABLE ballots ALTER COLUMN created_at DROP DEFAULT;
UPDATE ballots SET created_at = NULL WHERE voter_id IS NULL AND created_at IS NOT NULL;
UPDATE poll_voters pv
   SET voted_at    = date_trunc('day', pv.voted_at, 'UTC'),
       verified_at = date_trunc('day', pv.verified_at, 'UTC')
  FROM polls p
 WHERE p.id = pv.poll_id AND NOT p.is_nominative
   AND NOT EXISTS (SELECT 1 FROM ballots b WHERE b.voter_id = pv.id)
   AND (pv.voted_at <> date_trunc('day', pv.voted_at, 'UTC') OR pv.verified_at <> date_trunc('day', pv.verified_at, 'UTC'));

-- === Jetons d'API (accès programmatique des organisateurs) ===
-- Seule l'empreinte SHA-256 du jeton est stockée ; token_prefix sert à
-- reconnaître un jeton dans l'interface sans pouvoir l'utiliser.
CREATE TABLE IF NOT EXISTS api_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  scope        TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);

-- === Seuil de publication des résultats ===
-- Tant que le scrutin compte moins de bulletins que ce seuil, les résultats ne
-- sont montrés à personne (un total calculé sur 1 ou 2 bulletins révèle ces
-- votes). Exception : l'organisateur d'un scrutin nominatif voit déjà tout.
-- 0 = pas de seuil (comportement des scrutins créés avant cette option).
ALTER TABLE polls ADD COLUMN IF NOT EXISTS min_ballots_for_results INT NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'polls_min_ballots_for_results_check') THEN
    ALTER TABLE polls ADD CONSTRAINT polls_min_ballots_for_results_check
      CHECK (min_ballots_for_results BETWEEN 0 AND 10000);
  END IF;
END $$;

-- === Nouveaux choix ajoutés après un vote (1.2) ===
-- Options déjà notées par chaque votant : la liste des identifiants seulement,
-- sans aucune note, pour lui proposer de noter les choix ajoutés après son vote.
ALTER TABLE poll_voters ADD COLUMN IF NOT EXISTS rated_option_ids UUID[];
-- Votes antérieurs à cette version : liste inconnue (NULL). On ne leur propose
-- alors que les options créées après la migration (created_at renseigné), seule
-- règle sûre faute d'historique.
ALTER TABLE options ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
ALTER TABLE options ALTER COLUMN created_at SET DEFAULT now();

-- Bulletin complémentaire : notes des seuls choix ajoutés après le vote. Il ne
-- compte pas comme un bulletin de plus (nombre de votants inchangé).
ALTER TABLE ballots ADD COLUMN IF NOT EXISTS is_supplement BOOLEAN NOT NULL DEFAULT false;

-- Votants ayant demandé à être prévenus d'un nouveau choix : adresse chiffrée
-- (clé du serveur), rattachée à l'inscription et jamais au bulletin, effacée à
-- la clôture du scrutin. notified_option_ids évite de prévenir deux fois.
CREATE TABLE IF NOT EXISTS voter_notifications (
  voter_id            UUID PRIMARY KEY REFERENCES poll_voters(id) ON DELETE CASCADE,
  poll_id             UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  email_enc           TEXT NOT NULL,
  notified_option_ids UUID[] NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_voter_notifications_poll ON voter_notifications(poll_id);
