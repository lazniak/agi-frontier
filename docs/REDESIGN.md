# AGI Frontier — redesign spec (v2)

Owner: main session (Claude, commander). Implementers: GLM-5.3-Flash workers, one per task in
`TASKS.md` (T30–T36). This document is the contract every worker builds against. When code and
this spec disagree, the spec wins until the commander changes the spec.

Decision log in one line: the site becomes an **unbounded, source-verified rating of frontier AI,
with a calibrated, back-testable forecast, produced end-to-end by an OpenRouter researcher** —
and it is presented as a standard (see `docs/PAPER.md`).

---

## 0. What the user asked for (distilled)

1. The curve must not end — forecasts continue indefinitely ("infinity").
2. One simple, readable in-house score that keeps growing when benchmarks saturate.
3. A timeline of development **stages** (eras, "take-off"), past and predicted, that stirs the
   imagination but is computed mathematically — no LLM anywhere in the charts.
4. Scrubbing NOW must show how the prediction algorithm performed against what really happened.
5. Predictions must be accurate in the mathematical sense: measured, calibrated.
6. Labs with several models in a family are drawn as a vertically filled min–max band.
7. All published data comes from the **OpenRouter researcher**. Human/Claude research is only used
   to optimise the researcher (as a gold set), never published directly.
8. A progress bar to the next research run.
9. Prediction circles shrink as a launch approaches.
10. Everything much easier to use — current options exist but are hard to find.
11. LMArena (community votes) is a legitimate, important benchmark — use it.
12. A paper, in the user's name, explaining the method as a general standard.

---

## 1. Scoring

### 1.1 Rasch fit (unchanged core, three extensions)

    y_mb = logit(p_mb) = θ_m − δ_b

- **p_mb from any unit.** `scoreToProbability(benchmark, value)`:
  - unit `%`: `clip(value, 0.5, 99.5) / 100`
  - unit `elo` (LMArena): `1 / (1 + 10^((elo_reference − value) / 400))`, then clipped to
    [0.005, 0.995]. `elo_reference` is a fixed number on the benchmark (1200 for LMArena text). An
    Elo difference of 400 is one order of magnitude of odds, so a 100-Elo gap is 0.576 logits.
    δ for the Arena benchmark absorbs the reference; the model treats "beat the reference model"
    as one more item.
- **Weights.** Every benchmark has `weight` (default 1). Weighted ALS:

      θ_m = Σ_b w_b (y_mb + δ_b) / (Σ_b w_b + λ)
      δ_b = Σ_m w_b (θ_m − y_mb) / (Σ_m w_b + λ)   (= same as before when all w = 1)

  Residual σ uses weighted squared residuals and Σw − (M + B − 1) degrees of freedom. LMArena
  weight is 2 (user decision); everything else 1. `qualified` counts *benchmarks*, not weight.
- **Anchor** (already live): δ is re-centred to mean 0 over observed benchmarks with
  `legacy: false`. Generations (below) do not change the anchor.

### 1.2 Frontier Rating — the unbounded score

    R = 1000 + (400 / ln 10) · θ  ≈ 1000 + 173.72 · θ

- 400 rating points = 10× the odds of solving any basket item. 1000 = a model that would score
  50 % on an item of average difficulty in the current (anchor) basket.
- Unbounded above and below. It is the primary y axis and the primary number in rankings.
- The **Frontier Index** `100·σ(θ)` stays as the secondary, bounded reading ("expected score on an
  average item"). Toggle on the chart; both shown in tooltips.
- Per-model uncertainty: `± 173.72 · se`.
- Why it does not compress: the index saturates because σ does; θ does not. When a benchmark
  saturates it stops discriminating (its residual grows, its weight in θ effectively falls), and
  harder benchmarks that only recent models report take over. The chain of overlapping benchmark
  **generations** (LAMBADA…→ MMLU…→ GPQA…→ HLE…) is what lets θ keep moving. Adding a harder
  generation later does not move past ratings, because the anchor is the non-legacy set and every
  δ re-estimate is published with the bundle.

Constants live in `shared/src/rating.ts` (`RATING_BASE`, `RATING_PER_LOGIT`).

### 1.3 Benchmark generations

`Benchmark.generation` (integer ≥ 1): 1 = LAMBADA, ARC-C, HellaSwag, WinoGrande (2016–2019);
2 = MMLU, HumanEval, MATH, GSM8K (2020–2021); 3 = GPQA, MMMU, SWE-bench Verified, AIME, MMLU-Pro,
LiveCodeBench (2023–2024); 4 = HLE, ARC-AGI-2, Terminal-Bench 2, τ²-bench (2025); LMArena = 3
(community, `weight: 2`). `legacy` stays the anchor switch (generations 1–2 are legacy).

---

## 2. Levels, stages, eras (`shared/src/stages.ts`)

All derived from the fit and the frontier line. Nothing hand-written except the names of regimes.

### 2.1 Levels — the y-axis ladder

    Level { id, kind: 'human' | 'saturation' | 'generation' | 'ceiling',
            label, theta, rating, benchmark?: string, generation?: number }

- `human`: for every benchmark with `human_baseline`: θ = δ_b + logit(h/100)
  (label "Human experts · GPQA 69.7 %").
- `saturation`: per benchmark, θ = δ_b + logit(0.95) ("Saturated · MMLU (95 %)").
- `generation`: mean saturation θ over the generation's benchmarks ("Generation 3 basket saturated").
- `ceiling`: max over the current (non-legacy) basket saturation levels ("Current basket ceiling —
  new benchmarks needed").
Levels are sorted by θ; the UI de-duplicates labels closer than a pixel gap.

### 2.2 Crossings — when the frontier reached / will reach a level

    Crossing { level, kind: 'past' | 'predicted', date, p05?, p16?, p84?, p95?, release_id?, lab? }

- `past`: first frontier knot with θ ≥ level.θ (date = knot date, release the knot's model).
- `predicted`: from the **frontier trend** — OLS of θ on time over the trailing `windowDays`
  (default 365 → `FrontierTrend { slopePerDay, intercept, slopeSe, residualSigma, n }`).
  Crossing time t* = t_ref + (L − θ̂(t_ref)) / b. Delta-method variance
  `var(t*) = ((L − θ̂)/b²)² · se_b² + (σ_res / b)²`; quantiles from the normal approximation.
  No crossing when b ≤ 0 or the level is already passed. Predicted crossings are what the chart
  draws as circles on the trend line, and what the "Stages" panel lists ("Generation 4 basket
  saturated — median Mar 2028, 68 %: Oct 2027 – Nov 2028").

### 2.3 Eras — pace regimes

Monthly grid from the first knot + 365 d to `asOf`; at each month compute `frontierPace`
(logits/yr, trailing 365 d) and classify:

| regime | logits / yr |
|---|---|
| `dormant` | < 0.5 |
| `climb` | 0.5 – 1.5 |
| `acceleration` | 1.5 – 3 |
| `takeoff` | ≥ 3 |

Merge consecutive months with the same regime → `Era { start, end, regime, meanPace, maxPace }`.
The projected era = regime of the current trend slope, open-ended ("at the current pace…").
Regime names are the only prose in the maths; thresholds are constants in `stages.ts`.

---

## 3. Family bands (`shared/src/lineup.ts`)

- `ModelRelease.tier: 'flagship' | 'mid' | 'small'` (absent ⇒ flagship). Non-flagship models
  are now allowed in the data (Claude Sonnet/Haiku, GPT-5 mini, Gemini Flash, Qwen small…).
- Fit: all tiers enter the Rasch fit (more observations, better δ). Frontier line, rankings lead,
  cadence forecast: **flagship only**. Rankings show a tier filter.
- `labLineup(fit, releases, lab, asOf)` = latest released model per tier as of `asOf`.
- `lineupBand(fit, releases, lab, opts)` → step series `BandPoint { date, hiTheta, loTheta, hiId,
  loId }` at every date the lineup changes: hi = flagship θ, lo = min θ over the lineup. A lab with
  one tier has hi = lo (no band, just the line).
- Chart: filled band in the lab colour at 10 % between hi and lo, flagship line on top, lower
  tiers as small hollow markers (not on the line). The band fades into the fan after `asOf`.

---

## 4. Infinite forecast (`shared/src/prediction.ts`)

- No hard horizon. `forecastLab` takes `horizonDays` and `maxReleases` from options; the web
  requests whatever the visible x-domain needs (cap `maxReleases` 24). Chained widening stays
  `√k`. `capabilityFan(forecast, {toDate})` extrapolates to any date; variance grows with
  `(t − t_last)²·se_b² + σ_res²`, so the fan keeps opening.
- **Frontier trend fan**: `frontierFan(line, asOf, {toDate, stepDays})` from the trend of §2.2 —
  the grey/yellow "infinity" band the running maximum continues into, drawn to the right edge
  whatever the zoom. Its median is the dotted continuation of the frontier line.
- Circles shrink: the window drawn is that of `T | T > t0` (already), so as elapsed time cuts the
  distribution the p16–p84 span narrows; an `expected_window` from the lab collapses it further.
  A unit test asserts the p84 − p16 span is non-increasing in t0 for a fixed (μ, σ).
- Cadence uses **flagship releases only** (tier filter in `forecastLab`).

---

## 5. Backtest & calibration (`shared/src/backtest.ts`)

    backtestAsOf(releases, benchmarks, labIds, asOf, opts) → BacktestAsOf
      { asOf, rows: BacktestRow[] }
    BacktestRow { lab, predicted: PredictedRelease | null, actual: { release_id, date, theta, index } | null,
                  errorDays: number | null, in68: boolean | null, in90: boolean | null,
                  predictedTheta, actualTheta, thetaError }

    backtestSeries(releases, benchmarks, labIds, { from, to, stepDays = 30 }) → BacktestReport
      { n, coverage68, coverage90, maeDays, medianAbsDays, biasDays,
        byLab: Record<LabId, {n, coverage68, coverage90, maeDays}>,
        calibration: { nominal: number, observed: number }[]   // nominal ∈ {0.1..0.9}
        thetaMae, rows: BacktestRow[] }

- For each grid date `asOf`, fit + forecast as of that date; for each lab compare the k = 1
  prediction with the lab's first *flagship* release after `asOf` (none ⇒ row with actual null,
  excluded from coverage). `errorDays = actual − median`. Calibration curve: for nominal q, share
  of actual dates ≤ the q-quantile date (perfect calibration ⇒ observed = nominal).
- Deterministic and cheap enough for the browser (memoise fits per `asOf`); the worker also writes
  the full report into the bundle (`bundle.backtest`) so the page can show it without recomputing.
- The chart overlays, when scrubbed: for each lab the circle predicted as of `asOf` and the actual
  release (solid dot) joined by a hairline — green inside 68 %, amber inside 90 %, red outside.

---

## 6. Researcher v2 (worker)

Principle: **the site publishes only what the researcher found.** `data/gold/` is the frozen
human-curated seed (never published); `data/models/` is the published dataset; the researcher
writes to `data/researched/` and a `promote` step copies it into `data/models/` when it passes
the eval thresholds. The eval report is published (`bundle.worker.researcher.eval`).

### 6.1 Commands

- `backfill [--lab X] [--out data/researched]` — for each lab: (1) `:online` model discovery
  ("list every model <lab> has released, with tier and launch page URL", json_schema, several
  queries: flagship / mid / small / by year), (2) canonicalise + dedupe against known ids,
  (3) fetch each launch page / model card through the existing fetcher (jina fallback), (4)
  extract release + all basket scores (existing `extract` prompt, extended with `tier` and with
  the benchmark list including generation-1/2 items and LMArena), (5) quote-gate, (6) write
  `data/researched/<lab>.json`. Idempotent; resumable; budget-guarded (`RESEARCH_MAX_CALLS`).
- `arena [--out ...]` — fetch the LMArena text leaderboard (lmarena.ai via jina; fallback: the HF
  space `lmarena-ai/chatbot-arena-leaderboard`), map rows to known release ids by canonical name,
  write `lmarena` scores with `reported_by: 'maintainer'` and the leaderboard URL + row quote.
  Runs weekly inside `loop`.
- `eval [--candidate data/researched] [--gold data/gold]` → `ResearcherEval`: release
  precision/recall (match by canonical name + date within 45 d), score recall (same benchmark,
  |Δ| ≤ 1.0 point or ≤ 15 Elo), quote verification rate, per-lab table. Written to
  `worker/.state/researcher-eval.json` and into `state.json`.
- `promote` — copies `data/researched/` → `data/models/` if `recall_releases ≥ 0.85`,
  `precision_releases ≥ 0.95`, `score_recall ≥ 0.8`; appends `changes.jsonl` rows; never deletes
  a gold release that the researcher missed — it *adds* the researcher's finds and keeps the rest,
  flagged `origin: 'gold'` vs `'researcher'` on the release (new optional field).
- `loop`: writes `next_run_at`, `run_status`, `run_step` to state before every sleep/step, runs
  `arena` weekly and `backfill --incremental` weekly (Sunday), `eval` after each backfill.

### 6.2 Reliability

- OpenRouter client: retry on 429/5xx with exponential backoff + jitter (base 2 s, max 60 s,
  6 attempts), honour `Retry-After`, global concurrency limiter (`RESEARCH_CONCURRENCY`, default
  2), per-run call budget and token/cost accounting logged and stored in `last_run_summary`.
- Every extracted number must pass the quote gate before it is written. Failures are logged with
  the reason and count in the eval.

### 6.3 Bundle / state contract additions

    WorkerState {
      … existing …,
      next_run_at, run_status: 'idle'|'running', run_step: string|null, interval_minutes,
      last_run_summary: string|null,
      researcher: { version: string, last_backfill_at, last_arena_at, last_eval_at,
                    eval: ResearcherEval | null, budget: { calls, tokens_in, tokens_out, usd_estimate } | null }
    }

---

## 7. Web redesign

### 7.1 Views

- **Chart** (main): x infinite (d3-zoom, pan/zoom both axes; wheel = x zoom, shift+wheel or the
  vertical handle = y zoom; pinch on touch), y = Rating by default (ladder on the right gutter
  with level labels; Index toggle relabels the same axis). Layers (z-order): grid, ladder,
  bands, frontier-fan, fans, lines, points, tiers, markers, forecast circles, backtest overlay,
  labels, pace strip, overlay (NOW rule + handle).
- **Stages**: a vertical panel (future at the top, scrollable) listing predicted crossings with
  windows, then the eras with their pace, then past crossings with the model that did it.
- **Backtest**: when the scrubber is off today, a card under the chart: per-lab rows
  (predicted / actual / error / hit) + the global calibration (coverage 68 / 90, MAE, curve).
- **Rankings**: rating first, index second, tier filter, family band summary per lab.
- **Researcher**: status (last run, next run progress bar, current step), eval table (precision,
  recall, score recall, quote rate), budget, what changed last.
- **Paper**: `/paper.html` rendered from `docs/PAPER.md` at build time.

### 7.2 Controls — discoverable, labelled

A single control bar with labelled segmented controls, each with a tooltip and a keyboard
shortcut (`?` opens the shortcut sheet):

    Axis: [Rating | Index]     Range: [Story (2018→) | Recent (2023→)]     Forecast: [Next | Long]
    [Fit]  [Reset]     Focus: legend chips (hover = focus, click = toggle, double-click = solo)
    NOW: date pill + [◀ ▶] nudge + [Back to today]     Backtest: [auto when scrubbed]

- Mobile: a bottom sheet with the same controls, big touch targets; gyroscope parallax stays.
- First visit: a 4-step tour (what the axis is, the circle, the scrubber, the stages), dismissible,
  remembered in localStorage.
- Header: "Next research in 42 min" progress bar (from `next_run_at`, `interval_minutes`,
  `last_run_at`), live-updating; "running · step" while the worker runs.

### 7.3 Copy

English, en-dash ranges, no emoji. Names: **Frontier Rating** (primary), **Frontier Index**
(secondary), **Stages**, **Eras**, **Backtest**, **Researcher**.

---

## 8. Contract — types (`shared/src/types.ts`, `schema.ts`) — owned by the commander

```ts
export type ModelTier = 'flagship' | 'mid' | 'small';
export type DataOrigin = 'gold' | 'researcher';

// ModelRelease additions
tier?: ModelTier;          // absent ⇒ 'flagship'
origin?: DataOrigin;       // absent ⇒ 'gold' (seed); researcher writes 'researcher'

// Benchmark changes
unit: '%' | 'elo';
min: number; max: number;  // % ⇒ 0/100; elo ⇒ 0/4000
elo_reference?: number;    // required when unit === 'elo'
weight: number;            // default 1; LMArena 2
generation: number;        // 1..n, see §1.3
community?: boolean;       // true for LMArena (votes, not a test)

// WorkerState additions — see §6.3 (ResearcherEval below)
export interface ResearcherEval {
  evaluated_at: ISOTimestamp;
  gold_releases: number; found_releases: number; matched_releases: number;
  precision_releases: number; recall_releases: number;
  gold_scores: number; matched_scores: number; score_recall: number; score_mae: number;
  quotes_total: number; quotes_verified: number; quote_verified_rate: number;
  by_lab: Record<LabId, { gold: number; found: number; matched: number; scores_gold: number; scores_matched: number }>;
}

// Bundle additions
backtest?: BacktestReport;   // §5, written by the worker's bundle command
```

Score selection (`selectIndexScores`) is unchanged; `official` still beats `maintainer` for the
same benchmark. LMArena scores are always `maintainer`.

---

## 9. Module APIs (exact signatures)

`shared/src/rating.ts`
```ts
export const RATING_BASE = 1000;
export const RATING_PER_LOGIT = 400 / Math.LN10;
export function ratingFromTheta(theta: number): number;
export function thetaFromRating(rating: number): number;
export function ratingFromIndex(index: number): number;
export function scoreToProbability(b: Benchmark, value: number, clip?: [number, number]): number;
```

`shared/src/stages.ts`
```ts
export const PACE_REGIMES: { dormant: 0.5; climb: 1.5; acceleration: 3 };
export function benchmarkLevels(fit: IndexFit, benchmarks: Benchmark[]): Level[];
export function frontierTrend(line: FrontierPoint[], asOf: ISODate, windowDays?: number): FrontierTrend | null;
export function frontierFan(line: FrontierPoint[], asOf: ISODate, opts: { toDate: ISODate; stepDays?: number; windowDays?: number }): FanPoint[];
export function frontierCrossings(line: FrontierPoint[], levels: Level[], asOf: ISODate, opts?: { windowDays?: number; maxYears?: number }): Crossing[];
export function paceEras(line: FrontierPoint[], asOf: ISODate, opts?: { windowDays?: number }): Era[];
export function projectedEra(trend: FrontierTrend | null): Era['regime'] | null;
```

`shared/src/lineup.ts`
```ts
export function tierOf(r: ModelRelease): ModelTier;
export function labLineup(fit: IndexFit, releases: ModelRelease[], lab: LabId, asOf: ISODate): Partial<Record<ModelTier, { release: ModelRelease; mi: ModelIndex }>>;
export function lineupBand(fit: IndexFit, releases: ModelRelease[], lab: LabId, opts?: { asOf?: ISODate; qualifiedOnly?: boolean }): BandPoint[];
```

`shared/src/backtest.ts` — §5 signatures.

`shared/src/prediction.ts` — `ForecastOptions.tierFilter?: ModelTier[]` (default `['flagship']`),
`horizonDays` default `Infinity`-safe (cap by `maxReleases`), `capabilityFan` unchanged signature.

`shared/src/frontier-index.ts` — weighted ALS, `scoreToProbability`, `frontierLine(fit, { includeProvisional?, tiers? })` default flagship only for the *line*; rankings helper `rankCurrentFlagships` gains `tiers?`.

Everything exported from `shared/src/index.ts`. Every new function has unit tests in
`shared/tests/<module>.test.ts` with the same fixture helpers (`tests/test-helpers.ts`).

---

## 10. Tasks and ownership (file scopes are exclusive)

| task | worker | owns |
|---|---|---|
| T30 shared: rating, weights, Elo, generations, levels, trend, frontier fan, crossings, eras | GLM | `shared/src/rating.ts`, `shared/src/stages.ts`, `shared/src/frontier-index.ts`, `shared/tests/rating.test.ts`, `shared/tests/stages.test.ts`, `shared/tests/frontier-index.test.ts` |
| T31 shared: lineup bands, infinite forecast, tier filter, backtest | GLM | `shared/src/lineup.ts`, `shared/src/backtest.ts`, `shared/src/prediction.ts`, `shared/src/timeline.ts`, `shared/src/bundle.ts`, `shared/tests/lineup.test.ts`, `shared/tests/backtest.test.ts`, `shared/tests/prediction.test.ts`, `shared/tests/timeline.test.ts` |
| T32 worker: researcher v2 (backfill, arena, eval, promote), retry/backoff, state/progress, loop | GLM | `worker/**` |
| T33 web: chart core (rating axis + ladder, 2D zoom, bands, infinite fans, backtest overlay, tiers) | GLM | `web/src/chart/**`, `web/src/data.ts`, `web/src/state.ts` |
| T34 web: UI (control bar, tour, progress bar, stages panel, backtest card, researcher panel, rankings, paper page build, styles, index.html, main.ts) | GLM | `web/src/ui/**`, `web/src/styles/**`, `web/index.html`, `web/paper.html`, `web/src/main.ts`, `web/src/paper.ts`, `web/vite.config.ts`, `web/scripts/**` |
| T35 docs: PAPER.md, METHODOLOGY.md, DATA-GUIDE.md, READMEs | commander | `docs/**`, `README.md` |
| T36 data: gold freeze, benchmarks.json (generations, weights, lmarena), CLAUDE.md rules | commander | `data/**`, `CLAUDE.md` |

Order: T36 → (T30 ∥ T31 ∥ T32) → (T33 ∥ T34) → T35 → integration → deploy → backfill/eval loop.

Verification for every worker: `bun install && bun run typecheck && bun run test && bun run validate`
from the repo root (plus `bun run --filter @agi/web build` for web tasks). A worker may not edit
files outside its scope; if it needs an API that does not exist yet it asks in its report rather
than adding it elsewhere.

---

## 11. Constants

| name | value | where |
|---|---|---|
| `RATING_BASE` | 1000 | rating.ts |
| `RATING_PER_LOGIT` | 400 / ln 10 = 173.7178 | rating.ts |
| Rasch clip | [0.5 %, 99.5 %] (% ) / [0.005, 0.995] (p) | frontier-index.ts |
| ridge λ | 0.05 | frontier-index.ts |
| `MIN_QUALIFIED_SCORES` | 3 | frontier-index.ts |
| saturation level | 95 % | stages.ts |
| pace regimes | 0.5 / 1.5 / 3 logits/yr | stages.ts |
| trend window | 365 d | stages.ts |
| backtest grid | 30 d, from first knot + 365 d to asOf − 30 d | backtest.ts |
| LMArena reference | 1200 Elo, weight 2 | benchmarks.json |
| researcher promote thresholds | recall ≥ 0.85, precision ≥ 0.95, score recall ≥ 0.8 | worker |
