#!/usr/bin/env bash
# Déploie une nouvelle version : commit + push git, puis déclenche Coolify.
# Usage : ./deploy/deploy.sh "message de commit optionnel"
set -euo pipefail
cd "$(dirname "$0")/.."

# Charge la config de déploiement si présente
if [ -f deploy/coolify.env ]; then
  set -a; . deploy/coolify.env; set +a
fi
GIT_REMOTE="${GIT_REMOTE:-origin}"
GIT_BRANCH="${GIT_BRANCH:-main}"
MSG="${1:-deploy $(date '+%Y-%m-%d %H:%M')}"

echo "▶ 1/2  Commit & push git ($GIT_REMOTE/$GIT_BRANCH)…"
git add -A
if git diff --cached --quiet; then
  echo "   (rien à committer, on pousse l'état courant)"
else
  git commit -m "$MSG"
fi
git push "$GIT_REMOTE" "$GIT_BRANCH"

echo "▶ 2/2  Déclenchement du déploiement Coolify…"
if [ -n "${COOLIFY_BASE_URL:-}" ] && [ -n "${COOLIFY_API_TOKEN:-}" ] && [ -n "${COOLIFY_APP_UUID:-}" ]; then
  code=$(curl -s -o /tmp/coolify_deploy.out -w '%{http_code}' \
    -H "Authorization: Bearer $COOLIFY_API_TOKEN" \
    "$COOLIFY_BASE_URL/api/v1/deploy?uuid=$COOLIFY_APP_UUID&force=false")
  echo "   HTTP $code"
  cat /tmp/coolify_deploy.out; echo
  [ "$code" = "200" ] && echo "✅ Déploiement déclenché." || { echo "❌ Échec (voir réponse ci-dessus)."; exit 1; }
else
  echo "   ⚠ COOLIFY_* non configuré dans deploy/coolify.env."
  echo "   Si l'auto-deploy Coolify est activé sur la branche, le push suffit."
fi
