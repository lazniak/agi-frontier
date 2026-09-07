# Deploy

Target: Hostinger VPS `hexart-main` (72.61.80.71), checkout at `/opt/agi-frontier`, web on
`127.0.0.1:3040` behind the host nginx (`agi.pablogfx.com`, TLS by certbot).

```
deploy/deploy.sh          pull main on the server, rebuild images, restart (idempotent)
deploy/deploy.sh --logs   …then tail the worker
```

## Pieces

| file | purpose |
|---|---|
| `docker-compose.yml` | `web` (nginx, static build, serves `/latest.json` from `../data/public`) + `worker` (bun, repo bind-mounted at `/repo`, commits `data/` with the bot deploy key) |
| `Dockerfile.web` | two-stage: bun builds `web/dist`, nginx serves it |
| `web-nginx.conf` | container nginx: SPA fallback, immutable assets, `/latest.json` alias |
| `Dockerfile.worker` | bun + git + ssh; entrypoint runs `bun install` into the mounted checkout |
| `nginx-agi.pablogfx.com.conf` | host nginx site (before certbot rewrites it) |
| `.env.example` | env for the worker; copy to `/opt/agi-frontier/.env` |

## First-time steps already done on the server (2026-09-07)

1. DNS `agi.pablogfx.com A 72.61.80.71` (Hostinger).
2. Host nginx site + `certbot --nginx -d agi.pablogfx.com`.
3. Bot key `/root/.ssh/agi_frontier_bot` registered as a GitHub deploy key with write access; `git config core.sshCommand` set in the checkout.
4. `.env` with `OPENROUTER_API_KEY`.

## Operations

```
ssh hexart-main
cd /opt/agi-frontier
docker compose -f deploy/docker-compose.yml logs -f worker      # hourly runs, JSON lines
docker compose -f deploy/docker-compose.yml exec worker bun run worker/src/cli.ts poll --dry-run
docker compose -f deploy/docker-compose.yml exec worker bun run worker/src/cli.ts verify --only-unverified
git log --oneline -- data | head                                 # bot commits: data(bot): …
```

The worker commits to `main` and pushes; the site itself only needs a rebuild (`deploy.sh`)
when code changes — data changes are live through the mounted `data/public/latest.json`.
