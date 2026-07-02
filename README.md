# Vote de valeur

Plateforme web pour organiser des **votes de valeur** (range voting) : chaque votant note *chaque* option de **−2 à +2**. Le classement se fait à la **somme des notes** (les égalités sont autorisées).

## Principes

- **Créateurs** : compte (email + mot de passe), tableau de bord de leurs votes.
- **Votants** : identification par email → **1 email = 1 vote** (lien magique unique envoyé par email). Pas de compte requis.
- **Votes** identifiés par **UUID**. Public (URL seule) ou privé (URL + mot de passe).
- **Résultats** : invisibles avant d'avoir voté (pas d'influence), puis visibles **en temps réel** une fois le bulletin soumis. Le vote est **définitif**.
- **Secret du bulletin** : l'email n'est jamais stocké en clair lié au bulletin. Seul un HMAC (`email_hash`) sert à garantir l'unicité, dans une table séparée des scores.

## Stack

Node.js + Express · PostgreSQL (`pg`) · EJS (rendu serveur) · nodemailer (SMTP) · auth cookie httpOnly (JWT + bcrypt). Un conteneur applicatif + un service Postgres.

## Développement local

Prérequis : Node ≥ 20 et un Postgres accessible (ou utilisez `docker compose`).

```bash
cp .env.example .env      # puis éditez les valeurs
npm install
npm run migrate           # crée les tables
npm run dev               # démarre sur http://localhost:3000
```

En dev, laissez `SMTP_DEV_MODE=true` : les emails ne sont pas envoyés, les **liens magiques sont affichés dans la console**.

### Avec Docker Compose (app + Postgres)

```bash
docker compose up --build
```

L'app applique automatiquement les migrations au démarrage puis écoute sur le port 3000.

## Déploiement sur Coolify

1. **Base de données** : créez une ressource *PostgreSQL* dans Coolify. Notez l'URL de connexion interne.
2. **Application** : nouvelle ressource à partir de ce dépôt Git. Coolify détecte le `Dockerfile`.
   - Le conteneur exécute `node src/migrate.js && node src/server.js` : les tables sont créées/à jour à chaque déploiement.
3. **Variables d'environnement** (onglet *Environment Variables*) :

   | Variable | Valeur |
   |---|---|
   | `DATABASE_URL` | URL de connexion du Postgres Coolify |
   | `BASE_URL` | URL publique de l'app, ex. `https://vote.mondomaine.fr` |
   | `JWT_SECRET` | longue chaîne aléatoire |
   | `EMAIL_HASH_SECRET` | longue chaîne aléatoire (différente) |
   | `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` | identifiants du service transactionnel (Resend, Postmark, Brevo…) |
   | `SMTP_FROM` | ex. `Vote de valeur <noreply@mondomaine.fr>` |
   | `SMTP_DEV_MODE` | `false` en production |

   Générer un secret : `openssl rand -hex 32`.
4. **Port** : l'app écoute sur `3000`. Configurez le domaine/port dans Coolify. Healthcheck disponible sur `/healthz`.
5. **Email** : configurez SPF/DKIM du domaine expéditeur chez votre fournisseur SMTP pour une bonne délivrabilité.

## Modèle de données

- `users` — comptes créateurs.
- `polls` — un scrutin (titre, description, privé + `password_hash`, `status`, `close_at`).
- `options` — options d'un scrutin.
- `poll_voters` — participation (`email_hash`, `magic_token`, `verified_at`, `voted_at`), contrainte d'unicité `(poll_id, email_hash)`.
- `ballots` + `ballot_scores` — bulletins anonymes et leurs notes (`-2..+2`), non liés à l'identité.

## Calcul du résultat

Somme des notes par option, **abstention = 0** (chaque bulletin porte une note par option, 0 par défaut). Tri décroissant. Rangs avec égalités (méthode « 1224 » : deux ex æquo partagent le même rang).

## Pistes d'évolution

- Choix du mode de calcul par scrutin (somme / moyenne / médiane — le *jugement majoritaire* résiste mieux au vote stratégique).
- Import d'une liste d'emails invités + relances.
- Export CSV des résultats, page publique de résultats après clôture.
- Limitation de débit sur la demande de lien (anti-spam).
