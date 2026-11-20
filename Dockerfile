FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Dépendances de production, versions figées par le fichier de verrouillage.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Code de l'application uniquement (aucun fichier local ni de configuration).
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz" >/dev/null || exit 1

# Applique les migrations puis démarre le serveur.
CMD ["sh", "-c", "node src/migrate.js && exec node src/server.js"]
