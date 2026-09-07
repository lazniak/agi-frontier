#!/usr/bin/env bash
# Deploy/update agi.pablogfx.com on the Hostinger VPS (ssh alias: hexart-main).
# Usage: deploy/deploy.sh            # pull main, rebuild images, restart
#        deploy/deploy.sh --logs     # tail worker logs after deploy
set -euo pipefail
HOST="${DEPLOY_HOST:-hexart-main}"
APP_DIR="/opt/agi-frontier"

ssh "$HOST" bash -s <<'REMOTE'
set -euo pipefail
APP_DIR=/opt/agi-frontier
if [ ! -d "$APP_DIR/.git" ]; then
  git clone git@github.com:lazniak/agi-frontier.git "$APP_DIR"
fi
cd "$APP_DIR"
git fetch origin main
git checkout -q main
git pull --ff-only origin main
if [ ! -f .env ]; then
  echo "!! $APP_DIR/.env missing — copy deploy/.env.example and fill OPENROUTER_API_KEY"; exit 1
fi
mkdir -p data/public worker/.state
docker compose -f deploy/docker-compose.yml up -d --build --remove-orphans
# latest.json is generated, not tracked: rebuild it right away so the site never 404s after a pull
docker compose -f deploy/docker-compose.yml exec -T worker bun run worker/src/cli.ts bundle
docker compose -f deploy/docker-compose.yml ps
REMOTE

if [ "${1:-}" = "--logs" ]; then
  ssh "$HOST" "cd $APP_DIR && docker compose -f deploy/docker-compose.yml logs -f --tail=100 worker"
fi
