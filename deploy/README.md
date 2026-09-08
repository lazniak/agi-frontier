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
| `docker-compose.yml` | `web` (nginx, static build, serves `/latest.json` from `../data/public`) + `worker` (bun, repo bind-mounted at `/repo`, commits `data/` with the bot deploy key) + the `weblogs` volume they share |
| `Dockerfile.web` | two-stage: bun builds `web/dist`, nginx serves it |
| `web-nginx.conf` | container nginx: SPA fallback, immutable assets, `/latest.json` alias, and the `traffic` log behind the research cadence |
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

## Traffic-scaled research cadence (REDESIGN §12.8)

The researcher runs as often as people actually visit: weekly under 3 visitors a day, up to every
6 h at 100+. The signal is the `weblogs` volume — nginx writes one `traffic` line per
`GET /latest.json` (one per page load) to `/var/log/nginx/traffic.log`, and the worker reads the
same file at `/logs/traffic.log`, counts *daily unique* visitors and empties it.

Nothing about a visitor is stored. Each UTC day gets a random salt; addresses become 12-hex-char
salted hashes for that day only; when the day closes the salt and the hashes are dropped and a
bare count remains for 14 days. The bundle carries only `worker.researcher.cadence`. The web
container's ordinary access log is off, because nginx's default format ends with
`$http_x_forwarded_for` and would otherwise keep every visitor's address in Docker's json log.

```
docker compose -f deploy/docker-compose.yml exec web wc -l /var/log/nginx/traffic.log   # since the last ingest
docker compose -f deploy/docker-compose.yml logs worker | grep 'traffic ingested'       # tier, mean, days measured
docker volume inspect agi-frontier_weblogs
```

Two things to expect on the first deploy that carries this change:

- The `weblogs` volume does not exist yet, so compose creates it and recreates **both** containers
  (their mounts changed). `deploy.sh` already does that.
- There is no log yet, so the first ingests measure nothing: the cadence stays `weekly` with
  `days_measured: 0` until a UTC day has closed. Expect the panel to show a real number roughly
  48 h after the deploy (one closed day to measure, and the tier only steps up on the mean).

`RESEARCH_MONTHLY_USD` (default 60) is the guard: once the month-to-date OpenRouter estimate
reaches it the cadence falls back to weekly and the published cadence is flagged `capped`. The
month-to-date figure is anchored the first time the worker sees a new month, so the month in which
this ships starts from zero rather than from the lifetime total.
