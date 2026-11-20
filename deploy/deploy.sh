#!/usr/bin/env bash
# Pousse la branche courante, puis déclenche le redéploiement Coolify.
# Le script ne commite rien : il refuse de tourner si des modifications ne
# sont pas commitées, pour ne jamais publier un fichier par mégarde.
# Usage : ./deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# Configuration de déploiement (URL Coolify, UUID de l'application, jeton API).
if [ -f deploy/coolify.env ]; then
  set -a; . deploy/coolify.env; set +a
fi
GIT_REMOTE="${GIT_REMOTE:-origin}"
GIT_BRANCH="${GIT_BRANCH:-main}"

if [ -n "$(git status --porcelain)" ]; then
  echo "❌ Des modifications ne sont pas commitées. Commitez-les (ou mettez-les de côté) avant de déployer."
  exit 1
fi

echo "▶ 1/2  Push git ($GIT_REMOTE/$GIT_BRANCH)…"
git push "$GIT_REMOTE" "HEAD:$GIT_BRANCH"

echo "▶ 2/2  Déclenchement du déploiement Coolify…"
if [ -n "${COOLIFY_BASE_URL:-}" ] && [ -n "${COOLIFY_API_TOKEN:-}" ] && [ -n "${COOLIFY_APP_UUID:-}" ]; then
  response="$(mktemp)"
  trap 'rm -f "$response"' EXIT
  # Le jeton passe par l'entrée standard de curl, jamais par sa ligne de commande
  # (visible des autres utilisateurs dans la liste des processus).
  code=$(printf 'Authorization: Bearer %s\n' "$COOLIFY_API_TOKEN" | curl -q -s -o "$response" -w '%{http_code}' \
    -H @- "$COOLIFY_BASE_URL/api/v1/deploy?uuid=$COOLIFY_APP_UUID&force=false")
  echo "   HTTP $code"
  cat "$response"; echo
  [ "$code" = "200" ] && echo "✅ Déploiement déclenché." || { echo "❌ Échec (voir réponse ci-dessus)."; exit 1; }
else
  echo "   ⚠ COOLIFY_* non configuré dans deploy/coolify.env."
  echo "   Si l'auto-deploy Coolify est activé sur la branche, le push suffit."
fi
