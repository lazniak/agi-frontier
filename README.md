# AGI Frontier

**https://agi.pablogfx.com** — the living chart of flagship AI.

One interactive, never-ending timeline of every frontier LLM, scored on a fixed basket of
official benchmarks, with a calibrated forecast of *when* each lab ships its next flagship.

- **Frontier Index** — a single 0–100 capability number per model, fitted from the lab's own
  reported scores on a fixed basket of benchmarks (Rasch-style ability/difficulty model, so a
  model that skipped a benchmark is not punished or rewarded for it). Not an average: the chart
  draws the latent ability on a logit axis, so progress near the top is not squashed, and a
  legacy tier of older benchmarks chains the history back to GPT-2. Method: [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md).
- **Pace** — the frontier's slope in logits per year and the implied odds-doubling time, plus a
  strip of the gain per quarter under the chart.
- **Release forecast** — per lab, a log-normal model of historical release cadence gives the
  probability of the next flagship landing in the next 30 / 90 days. Drawn as a yellow
  min–max fan and a circle whose diameter is the 68 % release window.
- **Audit everything** — click any point: each score shows benchmark, configuration, source
  URL, verbatim quote and retrieval time. The whole dataset is this repo (`data/`), and every
  change is a git commit plus a row in `data/history/changes.jsonl`.
- **Auto-updated hourly** — a worker polls the labs' newsrooms, and only when a page changes
  asks an LLM (via OpenRouter) to extract released models and scores, which are then validated
  and quote-verified before they can appear.

## Repository

```
shared/   data contract + all math (pure TypeScript, unit-tested)
worker/   hourly poller / extractor / validator / bundler (Node 22)
web/      static site (Vite + TypeScript + D3)
data/     labs, benchmark basket, per-lab releases, audit log, generated bundle
deploy/   Docker, nginx, deploy script
docs/     methodology and data guide
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
