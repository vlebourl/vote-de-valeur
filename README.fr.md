# Vote de valeur

[![CI](https://github.com/vlebourl/vote-de-valeur/actions/workflows/ci.yml/badge.svg)](https://github.com/vlebourl/vote-de-valeur/actions/workflows/ci.yml)
[![Licence : MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

*[English version](README.md)*

Application web pour organiser des **votes de valeur** : chaque votant note **chaque** option de **−2 à +2**, et le classement se fait à la **somme des notes**. Au lieu de choisir un seul favori, chacun exprime un avis nuancé sur chaque option, ce qui supprime le « vote utile ».

| Accueil | Bulletin | Résultats en direct |
|---|---|---|
| ![Page d'accueil](docs/screenshots/landing.png) | ![Bulletin](docs/screenshots/ballot.png) | ![Résultats](docs/screenshots/results.png) |

## Fonctionnalités

- **Organisateurs** : compte (email + mot de passe), puis scrutins avec options texte et/ou image, description, date de clôture facultative. Titre, description et options restent modifiables après l'ouverture.
- **Trois façons d'identifier les votants**, au choix pour chaque scrutin :
  - **lien magique par email** (par défaut) : un email = un vote, sans compte ;
  - **par nom** (mode léger, pour les groupes de confiance) : un nom = un vote ;
  - et tout scrutin peut être **privé** (lien + mot de passe).
- **Vote secret ou nominatif** : par défaut, personne, pas même l'organisateur, ne peut relier un bulletin à un votant. Un scrutin peut passer en nominatif ; les votants en sont alors avertis sur le bulletin.
- **Résultats** invisibles avant d'avoir voté (pas d'influence), puis affichés **en direct** via un lien personnel permanent, aussi envoyé dans l'email de confirmation.
- **Classement** : somme des notes, abstention = 0, ex æquo au même rang (méthode « 1224 »).

## Le secret du bulletin

En scrutin secret, la base ne contient rien qui relie un votant à son bulletin :

- l'email (ou le nom) du votant n'est stocké que sous forme de **HMAC**, qui garantit un seul vote par personne ;
- le jeton du lien magique n'est stocké que sous forme d'**empreinte SHA-256** : une fuite de la base ne donne accès à aucun bulletin ;
- pour envoyer la confirmation, l'email est gardé **chiffré avec une clé dérivée du jeton du votant** (AES-256-GCM, HKDF). Le serveur ne peut le déchiffrer qu'au moment où le votant ouvre son lien pour voter, puis l'efface ;
- les bulletins n'ont **ni référence au votant, ni horodatage**, et la date de vote du votant est arrondie au jour.

Limites, dites franchement : quelqu'un qui observe le serveur en direct pendant les votes (journaux, trafic, réplication de la base) pourrait encore les rapprocher. L'ordre physique des lignes en base peut aussi trahir l'ordre des votes d'une même journée.

## Stack

Node.js 20+ · Express 5 · PostgreSQL (`pg`) · rendu serveur EJS · nodemailer (SMTP) · cookie de session httpOnly (JWT) + bcrypt. Aucune étape de build côté navigateur : un peu de JavaScript natif pour les résultats en direct.

Sécurité : validation des UUID de toutes les routes, contrôle d'origine sur toute écriture (CSRF), limitation de débit par IP (connexion, inscription, liens magiques, mots de passe des scrutins), pas de redirection ouverte, en-têtes de sécurité (`Referrer-Policy: same-origin` : les jetons ne fuient pas par le `Referer`), refus de démarrer en production avec des secrets absents ou faibles.

## Lancer l'application

### Avec Docker Compose (application + PostgreSQL)

```bash
npm run init-env          # crée .env avec des secrets générés (nécessite Node)
docker compose up --build # http://localhost:3000
```

Les migrations s'appliquent au démarrage. Avec `SMTP_DEV_MODE=true` (par défaut), aucun email n'est envoyé : les liens magiques s'affichent dans les journaux (`docker compose logs app`).

### En local

Prérequis : Node ≥ 20.19 et une base PostgreSQL.

```bash
npm install
npm run init-env   # puis renseignez DATABASE_URL dans .env
npm run migrate
npm run dev        # http://localhost:3000, redémarre à chaque modification
```

## Tests

```bash
npm test     # tests unitaires et d'intégration contre un vrai PostgreSQL
npm run lint
```

`npm test` démarre un PostgreSQL embarqué jetable : rien à installer. Pour utiliser une base existante (comme la CI), définissez `TEST_DATABASE_URL`. Les tests couvrent :

- le parcours de vote complet ;
- le secret du bulletin, vérifié directement en base ;
- les doubles votes simultanés ;
- la migration d'une base existante ;
- les droits d'accès, le CSRF, les redirections et la limitation de débit.

La CI lance le lint, les tests (Node 20 et 22), `npm audit` et la construction de l'image Docker à chaque push.

## Configuration

Voir [`.env.example`](.env.example). Variables principales :

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | Connexion PostgreSQL |
| `BASE_URL` | URL publique, utilisée dans les liens envoyés par email |
| `JWT_SECRET`, `EMAIL_HASH_SECRET` | Secrets aléatoires d'au moins 32 caractères (`openssl rand -hex 32`), obligatoires en production |
| `TRUST_PROXY` | Nombre de proxys devant l'application (`1` derrière Traefik/Coolify) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | Fournisseur d'email transactionnel (Resend, Postmark, Brevo…) |
| `SMTP_DEV_MODE` | `true` : emails affichés dans la console au lieu d'être envoyés |

## Déploiement sur Coolify

1. **Base de données** : créez une ressource *PostgreSQL* dans Coolify et notez son URL de connexion interne.
2. **Application** : nouvelle ressource depuis ce dépôt Git, *build pack* Dockerfile. Le conteneur applique les migrations puis démarre (`node src/migrate.js && node src/server.js`).
3. **Variables d'environnement** : celles du tableau ci-dessus, avec `TRUST_PROXY=1` et `SMTP_DEV_MODE=false`. Rangez les secrets comme des secrets Coolify, jamais dans le dépôt.
4. **Port** `3000`, domaine, puis déployez. Le healthcheck `/healthz` vérifie aussi la base.
5. **Email** : configurez SPF et DKIM du domaine expéditeur chez votre fournisseur SMTP.

Pour redéployer depuis votre poste : `deploy/coolify.env` (à créer depuis `deploy/coolify.env.example`, ignoré par git), puis `npm run deploy`. Le script pousse la branche puis déclenche le déploiement par l'API Coolify. Il refuse de tourner s'il reste des modifications non commitées. Si l'auto-deploy est activé sur la branche, un simple `git push` suffit.

## Modèle de données

- `users` : comptes organisateurs.
- `polls` : titre, description, privé et hash du mot de passe, nominatif, mode d'identification, statut, clôture.
- `options` : options d'un scrutin ; les images sont stockées dans PostgreSQL, aucun volume de fichiers à gérer.
- `poll_voters` : participation (`email_hash`, `token_hash`, email chiffré jusqu'au vote, dates), unique par `(poll_id, email_hash)`.
- `ballots` + `ballot_scores` : bulletins anonymes et leurs notes de −2 à +2.

## Pistes d'évolution

- Choix du mode de calcul par scrutin (somme, moyenne, médiane ; le *jugement majoritaire* résiste mieux au vote stratégique).
- Import d'une liste d'invités et relances.
- Export CSV des résultats.
- Gestion du fuseau horaire de la date de clôture (aujourd'hui interprétée dans le fuseau du serveur).

## Licence

[MIT](LICENSE) © 2026 Vincent Le Bourlot
