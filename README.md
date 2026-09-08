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
  a **release lens**: a shape whose thickness follows the probability density of the launch date,
  with the 68 % window as its inner outline and the 90 % window as its outer edge. It narrows on
  its own as the launch nears, because the conditional law does; an announced window is drawn as
  a flat trapezoid, because a stated window is not a law. Chained releases and fans continue to
  the right edge whatever the zoom.
- **Family ribbons** — a filled band per lab between the best and the weakest model it has
  shipped in the trailing year: the real-data counterpart of the forecast fan, collapsing onto
  the line when a lab has only one current model.
- **Benchmark lifetimes** — benchmarks are born, get scored, saturate at 95 % of their range and
  are retired, and the site draws that life as a strip. The Rasch fit is the shared-benchmark
  comparison generalised, so a dead benchmark costs nothing: its difficulty stays in the fit. The
  Method section says plainly how much evidence the newest rows actually rest on.
- **Backtest** — drag the NOW rule into the past and see the forecast as it would have been made
  that day next to what actually happened; coverage and calibration are published.
- **Reading it** — a plain wheel scrolls the page, as it should. The chart zooms on
  **Ctrl + Shift + scroll** (Ctrl alone for time, Shift alone for rating), drag pans, `+` / `−`
  zoom both axes, `0` fits and `Esc` resets. Hovering emphasises the family nearest the pointer —
  with enough hysteresis that it does not flicker — clicking pins it, Escape unpins. The rating
  axis is unbounded upwards; far above the data sit four labelled speculative landmarks, up to
  "technological singularity", which are signposts on an empty axis and never enter a
  calculation.
- **Audit everything** — click any point: each score shows benchmark, configuration, source
  URL, verbatim quote and retrieval time. The whole dataset is this repo (`data/`), and every
  change is a git commit plus a row in `data/history/changes.jsonl`.
- **Auto-updated hourly, researched by machine** — a worker polls the labs' newsrooms and,
  only when a page changes, asks an LLM (via OpenRouter) to extract releases and scores, which
  are validated and quote-verified before they can appear. A researcher rebuilds the whole
  dataset through OpenRouter (`backfill`, `arena`) from the labs' **launch posts** rather than
  their model catalogues, is graded against a frozen gold set (`eval` — a correct find the gold
  set lacks still costs precision, but it is listed for a human to promote rather than written
  off in silence) and only then
  published (`promote`). Research is scheduled to match real readership: weekly by default,
  faster as daily unique visitors rise, counted server-side as salted hashes — no analytics
  script, no cookies, no address stored — under a monthly spend cap. The header shows the
  countdown to the next run.

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

Read [`docs/DATA-GUIDE.md`](docs/DATA-GUIDE.md), edit `data/gold/<lab>.json` — human research
goes to the gold set, the frozen answer key the researcher is graded against, not to the
published dataset — run `bun run validate`, open a PR. A score without a primary-source URL and
a verbatim quote will be rejected by CI.

## License

Code: MIT. Data: CC BY 4.0 — cite *AGI Frontier (agi.pablogfx.com)*.
