FROM node:22-alpine

WORKDIR /app

# Dépendances (couche cache)
COPY package.json ./
RUN npm install --omit=dev

# Code
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

# Applique les migrations puis démarre le serveur.
CMD ["sh", "-c", "node src/migrate.js && node src/server.js"]
