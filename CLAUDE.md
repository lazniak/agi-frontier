# AGI Frontier — repo conventions

Live site: https://agi.pablogfx.com · Repo: https://github.com/lazniak/agi-frontier

A living chart of flagship LLM capability over time (the **Frontier Index**, fitted from official
benchmark scores) with calibrated **release-date prediction** per lab. Everything is auditable:
every number links to a primary source and a verbatim quote.

## Layout (bun workspaces)

| path | role | owner rules |
|---|---|---|
| `shared/` | data contract (`types.ts`, `schema.ts`) + all math (`frontier-index.ts`, `prediction.ts`, `timeline.ts`). Pure TS, zero DOM, zero Node APIs. Unit-tested with `bun test`. | Both worker and web import it. Never duplicate math elsewhere. |
| `worker/` | Node 22 CLI: `validate`, `bundle`, `verify`, `poll`, `loop`. Fetches lab pages hourly, hash-diffs them, extracts new flagship releases/scores via OpenRouter, validates with zod, appends the audit log, commits `data/` to git. | Only place that talks to the network or writes `data/`. |
| `web/` | Vite + TypeScript + D3 static site. Reads `/latest.json`. No framework. | No network calls except `/latest.json` and self-hosted fonts. |
| `data/` | Source of truth: `labs.json`, `benchmarks.json`, `models/<lab>.json`, `history/changes.jsonl`; `public/latest.json` is generated on the server and git-ignored. | Every edit must pass `bun run validate`. |
| `deploy/` | Dockerfiles, `docker-compose.yml`, nginx site conf, `deploy.sh`. | Target: `/opt/agi-frontier` on the Hostinger VPS `hexart-main`, port `127.0.0.1:3040`. |
| `docs/` | `METHODOLOGY.md` (public, linked from the site), `DATA-GUIDE.md` (how to add a release by hand). | Docs change in the same PR as the code they describe. |

## Data rules (non-negotiable)

- `status: released` only for models actually available to the public (API or product). Announced = grey, rumored = grey dashed, never on the index.
- Every score carries `source.url` + `source.quote` (verbatim, ≤300 chars). `worker verify` re-fetches and marks `verified`.
- Official lab numbers only (`reported_by: official`). Benchmark-maintainer leaderboards are allowed as `maintainer` and are flagged in the UI. **LMArena** (community Elo) is the one non-test benchmark: `maintainer`, unit `elo`, weight 2 (user decision 2026-09-07).
- Every lineup tier may be recorded (`tier: flagship | mid | small`, absent = flagship). Only flagships form the frontier line, the rankings lead and the release cadence; the other tiers feed the fit and the family bands.
- **Publication rule (user decision 2026-09-07):** the site shows only what the OpenRouter researcher produced (`data/models/`). Human/Claude research goes to `data/gold/` — the frozen answer key the researcher is evaluated against — and is never published directly. See `docs/REDESIGN.md` §6.
- Dates are the public launch date (`date_precision` says how sure we are). Never guess a day; use `month`/`quarter` precision instead.
- Never delete history. Corrections are new commits + a `changes.jsonl` row.

## Delegation (user decision 2026-09-07, this repo)

Implementation tasks are delegated to **GLM-5.3-Flash** workers (skill `glm-code`, effort max),
one task per worker with an exclusive file scope from `docs/REDESIGN.md` §10. Claude designs the
spec and contracts, writes the briefs, reviews every diff, runs CI and integrates. At most three
workers run at once; the launcher retries 429s with backoff. This overrides the global
"write code yourself" rule for this repository.

## Git

- Branch per task: `agent/<session>/<slug>`; Conventional Commits, scope = package (`feat(web): …`, `fix(worker): …`, `data(openai): …`).
- `main` is deployed. Humans merge via PR. **Exception:** the worker bot commits `data/**` directly to `main` with prefix `data(bot):` — machine-generated, reviewed post-hoc via the site changelog.
- Never commit `.env`, `worker/.state/`, or `data/public/latest.json` produced locally with secrets (it has none, but keep it generated on the server).
- Commit trailer: `Co-Authored-By: <model> <noreply@anthropic.com>`.

## Commands

```bash
bun install
bun run typecheck && bun run test
bun run validate          # zod-validate all data files + cross-references
bun run bundle            # build data/public/latest.json
bun run --filter @agi/web dev  # local site at http://localhost:5173
bun run --filter @agi/worker verify   # re-fetch sources, check quotes
```

## Style

- English UI, en-dash for ranges, no emoji in UI.
- Typography: Jost (self-hosted, `@fontsource-variable/jost`), weights 200/300 for text, 600 for accents.
- Palette: white background, soft shadows, lab colours from `data/labs.json`, prediction yellow `#F5C400`, announced grey `#9AA0A6`.
