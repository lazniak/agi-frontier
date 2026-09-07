# AGI Frontier

**https://agi.pablogfx.com** — the living chart of flagship AI.

One interactive, never-ending timeline of every frontier LLM, scored on a fixed basket of
official benchmarks, with a calibrated forecast of *when* each lab ships its next flagship.

- **Frontier Rating** — one unbounded capability number per model, R = 1000 + 173.72·θ, where θ
  is the latent ability fitted from the lab's own reported scores on a basket of benchmarks
  (weighted Rasch model: every benchmark gets a difficulty, every model an ability, so a model
  that skipped a benchmark is not punished or rewarded for it). 400 points = 10× the odds of
  solving a basket item. Saturated benchmarks cannot flatten it; four generations of benchmarks
  chain the history back to GPT-2. The bounded **Frontier Index** (0–100) is the same number in
  other units. Standard: [`docs/PAPER.md`](docs/PAPER.md); operations: [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md).
- **Stages** — a ladder of levels derived from the fit (human baselines, benchmark saturation,
  generation ceilings), when the frontier crossed them and when it is predicted to cross the
  next ones; eras of pace (dormant / climb / acceleration / takeoff); odds-doubling time.
- **Release forecast** — per lab, a log-normal model of flagship cadence gives the next launch as
  a circle whose diameter is the 68 % window and shrinks as the launch nears; chained releases
  and fans continue to the right edge whatever the zoom. Family bands show each lab's lineup.
- **Backtest** — drag the NOW rule into the past and see the forecast as it would have been made
  that day next to what actually happened; coverage and calibration are published.
- **Audit everything** — click any point: each score shows benchmark, configuration, source
  URL, verbatim quote and retrieval time. The whole dataset is this repo (`data/`), and every
  change is a git commit plus a row in `data/history/changes.jsonl`.
- **Auto-updated hourly, researched by machine** — a worker polls the labs' newsrooms and,
  only when a page changes, asks an LLM (via OpenRouter) to extract releases and scores, which
  are validated and quote-verified before they can appear. A researcher rebuilds the whole
  dataset through OpenRouter (`backfill`, weekly `arena`), is graded against a frozen gold set
  (`eval`) and only then published (`promote`). The header shows the countdown to the next run.

## Repository

```
shared/   data contract + all math (pure TypeScript, unit-tested)
worker/   hourly poller / extractor / validator / bundler (Node 22)
web/      static site (Vite + TypeScript + D3)
data/     labs, benchmark basket, per-lab releases, audit log, generated bundle
deploy/   Docker, nginx, deploy script
docs/     paper (the standard), methodology, data guide, redesign spec
```

## Run locally

```bash
bun install
bun run validate && bun run bundle
bun run --filter @agi/web dev
```

## Contribute a release or a score

Read [`docs/DATA-GUIDE.md`](docs/DATA-GUIDE.md), edit `data/models/<lab>.json`, run
`bun run validate`, open a PR. A score without a primary-source URL and a verbatim quote will
be rejected by CI.

## License

Code: MIT. Data: CC BY 4.0 — cite *AGI Frontier (agi.pablogfx.com)*.
