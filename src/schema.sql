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
-- email_hash = HMAC(email) : garantit l'unicité sans stocker l'email en clair lié au bulletin.
CREATE TABLE IF NOT EXISTS poll_voters (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id       UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  email_hash    TEXT NOT NULL,
  magic_token   TEXT NOT NULL UNIQUE,   -- jeton du lien de vote envoyé par email
  verified_at   TIMESTAMPTZ,            -- date de clic sur le lien magique
  voted_at      TIMESTAMPTZ,            -- date de soumission du bulletin (vote définitif)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (poll_id, email_hash)          -- 1 email = 1 vote par scrutin
);
CREATE INDEX IF NOT EXISTS idx_voters_poll ON poll_voters(poll_id);

-- Un bulletin (anonyme, non liable à l'identité du votant)
CREATE TABLE IF NOT EXISTS ballots (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id    UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
