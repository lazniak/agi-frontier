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


---

## 12. v3 — chart stage, smart hover, real-data ribbons, release lens, benchmark lifetimes, researcher truth (2026-09-07 evening)

User feedback after v2 went live, distilled:

1. Scrolling fights the chart. Plain wheel must scroll the page; the chart is zoomed/panned only
   with **Ctrl+Shift+wheel** (both axes), Ctrl+wheel (time), Shift+wheel (rating), drag, pinch,
   and the +/− buttons. Show the hint once. The chart, its date axis and its legend become one
   **stage** with the date bar pinned to the stage's bottom edge and a friendlier legend dock.
2. The rating axis must be scrollable **upwards without end**: zooming out reveals the fans
   opening like scissors, and far above the basket ceiling sit clearly-labelled **speculative
   markers** (up to "technological singularity") — the user asked for them half in jest; they are
   drawn as landmarks, never as data.
3. **Smart hover**: the family (lab) nearest to the pointer is emphasised and the others quieten,
   with hysteresis (the focus only moves when the pointer is clearly closer to another family) and
   an animated cross-fade. Click pins.
4. **Real-data family ribbons**: a filled vertical band per lab through time — the family's upper
   and lower bound — "like the forecast fan, but on real data".
5. The forecast **circles are weak**: replace them with a shape whose geometry follows the
   probability of the launch date (denser toward the centre).
6. Methodology worry: the chart rests on fragmentary benchmark data; benchmarks are born, live and
   burn out at 100 %; the index must come from shared benchmark sets and convert saturation into
   real developmental jumps. Gemini 3.1 Pro ranks too high for an outdated model.
7. The researcher panel says the LLM is not working (0 calls, 0 %). It works (107 calls on the
   first incremental run); the panel shows the last *poll*'s delta. Fix the truth of the panel and
   the researcher's first-run defects.

### 12.1 Chart stage (web, `web/src/chart/**`, `web/src/styles/chart.css`, `web/index.html` chart section)

- `.chart-stage`: one block = control bar (top) · canvas (flex 1) · **time axis strip** (fixed
  height 40 px, always at the stage's bottom, drawn from the same x scale) · **legend dock**
  (`[data-legend-dock]`, already in `index.html`): lab chips (visibility toggle + hover focus) and
  layer chips (fans, ribbons, ladder, crossings, backtest, tiers) that toggle `ChartApi.layers`.
  Stage height: `clamp(560px, calc(100vh - 120px), 1000px)`; on phones `calc(100vh - 160px)`.
  The x axis moves out of the main SVG into the strip (a second SVG sharing the x scale and the
  zoom transform) so the plot can pan vertically without the dates leaving the screen. The pace
  strip moves under the axis strip (same fixed area) or into the legend dock's first row.
- Wheel: `interaction.ts` — plain wheel is **not** captured (page scrolls). `ctrlKey && shiftKey`
  → zoom both axes about the pointer; `ctrlKey` only → time; `shiftKey` only → rating; d3-zoom's
  own wheel handler is disabled (`filter` returns false for wheel without modifiers), drag pans
  both axes, touch pinch zooms both. First plain wheel over the canvas shows `.chart-hint`
  ("Ctrl + Shift + scroll to zoom · drag to pan · +/− buttons") for 4 s, remembered in
  `agi:chart-hint`. Zoom range k ∈ [0.25, 60] on each axis; `translateExtent` y is unbounded
  upward, bounded below at rating 0.
- `ChartApi.zoomBy(kx, ky)` honours `ky`; +/− zoom both axes by ×1.25 about the plot centre;
  `fitView` fits both axes to the visible data + fans; `resetZoom` returns to the resting view.
- Unbounded rating axis: `valueTicks` must produce nice ticks for any domain (steps 50/100/200/
  500/1000/2000 chosen from the pixel density); the grid extends over the whole visible range; the
  frontier fan and the forecast fans are drawn to the visible x edge and clipped to the plot.
- **Speculative markers** (`shared/src/stages.ts`, `LevelKind` gains `'speculative'`):
  `speculativeLevels(ceiling: Level): Level[]` returns, above the basket ceiling θ_c:
  `θ_c + ln 10` "Ten times the odds of the whole basket", `θ_c + 2 ln 10` "A hundred times",
  `θ_c + 3 ln 10` "Every benchmark ever written saturated (speculative)", `θ_c + 4 ln 10`
  "Technological singularity — speculative landmark, not derived from data". The ladder draws
  them in a distinct dotted grey style with the word *speculative* in the label and the tooltip;
  they never enter crossings, stages, eras or the paper's results.
- **Legend dock**: replaces the static `.key` paragraph. Rows: labs (chips with colour dot, count
  of models, visibility toggle, hover → `store.setHoverLab`); marks (released / provisional / tier
  / announced / rumored); layers (toggle buttons with the swatch: family ribbon, forecast fan,
  frontier trend fan, release lens, ladder, crossings, backtest hairline, pace). Keyboard
  reachable; 44 px targets on phones; wraps into two rows on narrow screens.

### 12.2 Smart hover (`web/src/chart/hover.ts` new, `interaction.ts`, `layers.ts`, `index.ts`)

- `nearestFamily(pointer, geometry)`: distance from the pointer to every lab's polyline (segment
  distance in pixels, current zoom) and to its points and lens shapes; returns the nearest lab
  and the margin to the second nearest.
- Hysteresis: focus changes only when the new nearest lab is closer by ≥ 14 px than the current
  focus (or the current focus is farther than 60 px) and the pointer has rested ≥ 90 ms there.
  Leaving the plot clears the focus after 250 ms. Click pins (`store.pinLab`), click again or Esc
  unpins.
- Transition: every lab layer group carries `data-lab` and the classes `is-focus` / `is-dim` are
  toggled by the shell instead of recomputing opacity attributes; `chart.css` transitions
  `opacity` and `stroke-width` over 260 ms `cubic-bezier(.2,.7,.2,1)`. Focused family: full
  colour, stroke 2.4 px, its label and ribbon at full strength; the others fall to 0.18 opacity;
  the frontier line, ladder and fans stay untouched. `prefers-reduced-motion` disables the
  transition.
- The same focus drives the legend chips (`aria-current`) and the tooltip's family header.

### 12.3 Real-data family ribbons (`shared/src/lineup.ts`, `web/src/chart/bands.ts`)

`familyRibbon(fit, releases, lab, { asOf, windowDays = 365, tiers = ALL_TIERS }): BandPoint[]` —
for every date t in the lab's release dates ≤ asOf (plus asOf), the *current family* is every
released model of the lab with `t − windowDays ≤ date ≤ t`, or the single latest one when the
window is empty; `hiTheta` = max θ, `loTheta` = min θ over that set (ids in `hiId`/`loId`). Step
path. With mid/small tiers present the ribbon is flagship ↔ smallest tier; with flagships only it
is the spread between the last two flagships (collapsing to the line when one model is current).
`Computed.bands` is filled from `familyRibbon` (the old `lineupBand` stays for the rankings'
family line). Drawn at 14 % opacity, 34 % when the family is focused, fading after `asOf`.

### 12.4 Release lens (`shared/src/prediction.ts`, `web/src/chart/forecast.ts`)

- `releaseDensity(f: LabForecast, pred: PredictedRelease, n = 48): { date: ISODate; p: number }[]`
  — samples the density of the release date between the 2nd and 98th percentile, normalised so
  the mode is 1. For k = 1 the density is the finite-difference derivative of the stretched
  conditional CDF (`stretchedConditionalProb`), for k ≥ 2 the log-normal pdf with
  `σ · s · √k` (matching the chain in `forecastLab`).
- Shape: at the predicted rating, a **lens** whose half-thickness at date t is
  `h · p(t)`, `h` = half the 68 % rating window in pixels (`thetaLow..thetaHigh`), clamped to
  [6, 42] px; filled with a linear gradient along time from 0.10 opacity at the tails to 0.55 at
  the mode; the 68 % window as a stronger inner outline, the 90 % window as the outer edge; a
  1.5 px tick at the median; the shape shrinks as `asOf` advances toward the release exactly like
  the circle did (the conditional law does it). Tooltip and aria-label unchanged in content
  ("median, 68 % window, expected rating"). Whiskers for non-spotlight labs stay.
- The legend calls it "release lens — the denser, the likelier that launch date".

### 12.5 Benchmark lifetimes and comparability (`shared/src/lifetimes.ts` new, `web/src/ui/lifetimes.ts` new, `[data-lifetimes]` in the Method section)

- `benchmarkLifetimes(fit, releases, benchmarks, asOf): BenchmarkLifetime[]` — per benchmark:
  `introduced` (year), `firstScore` (date of the first released model scoring it), `nScores`,
  `saturatedAt` (first release date at which the frontier's best score on it ≥ 95 %, null when
  alive), `state: 'fresh' | 'active' | 'saturated' | 'legacy'`, `generation`, `delta` (δ),
  `weight`, `coverageOfFrontier` (share of the last 12 months' flagships reporting it).
- `comparability(fit, releases): Map<modelId, { shared: number; neighbours: number }>` — how many
  benchmarks a model shares with the frontier models released within ±18 months (the "common
  benchmark set" the user asked about). Rankings show it as the coverage tooltip.
- UI: a Gantt-like strip under the Method copy — one row per benchmark from introduction to
  saturation (or today), coloured by generation, saturated ones ending in a filled cap, with the
  count of scores; a one-paragraph explanation that the Rasch fit *is* the shared-benchmark
  comparison generalised (every model is compared through the benchmarks it shares with its
  neighbours, and a benchmark's death removes nothing because the difficulty it measured is kept
  in δ). Rankings add an **age** column (months since release) and mark a lab's best row as
  *superseded on LMArena* when the arena lists a newer model of that lab that the dataset lacks
  (computed from `lmarena-text` scores' dates vs the lab's latest release — off until the arena
  rows carry dates, so implement as a plain age column now).

### 12.6 Researcher truth (worker + web + contract)

- Contract: `WorkerState.researcher` gains `usage_total: ResearcherBudget | null` (lifetime
  OpenRouter totals across poll, discover and backfill, persisted in the run state) and
  `last_backfill_summary: string | null`; `budget` keeps the last *research* run's delta.
- Web: the Researcher panel shows "Lifetime" (calls, tokens, USD) and "Last research run" side
  by side, the last poll summary under "What changed last", and a green/grey **LLM** status dot:
  green when `usage_total.calls > 0` and `last_success_at` is within 2 h of `last_run_at`.
- Worker (T37 findings):
  1. Extraction names get the lab's family prefix when the model returns a bare family member
     ("Opus 5" → "Claude Opus 5"): `data/labs.json` gains `name_prefixes` (e.g. anthropic:
     `[{ match: /^(opus|sonnet|haiku|fable|mythos)\b/i, prefix: "Claude " }]`), applied in
     `validateExtraction`.
  2. Discovery prefers launch posts: model overview pages (`/models/`, `/models/gemini/`) are
     used only to find links to dated announcements; an extraction without a usable date retries
     once through the lab's news index before being dropped.
  3. Schema issues are logged verbatim (`issues: zod.issues.map(i => i.path.join('.') + ': ' +
     i.message)`), never `[""]`.
  4. Arena commit message `data(bot): arena <n> scores`; backfill/arena/eval summaries land in
     `last_backfill_summary`.
  5. `eval`: extra researched releases whose source is on the lab's official host and that the
     gold set lacks are listed as **unverified extras** in the report (still counted against
     precision) so a human can promote them to gold — the first live run found "Claude Opus 5"
     (system card 24 Jul 2026), which the gold set notes but never recorded.
- Gold: add Claude Opus 5 to `data/gold/anthropic.json` with a primary source and its scores
  (human/Claude research — the gold set is the human answer key, so this is allowed).
- Then: full `backfill` (non-incremental, ≈ 3.3 USD) on the VPS, `eval`, and `promote` when the
  gates pass.

### 12.7 Tasks (file scopes exclusive; Claude subagents — GLM delegation suspended by the user)

| task | owns |
|---|---|
| T40 shared v3: `familyRibbon`, `releaseDensity`, `speculativeLevels`, `lifetimes.ts`, `comparability`, tests, exports | `shared/src/lineup.ts`, `shared/src/prediction.ts`, `shared/src/stages.ts`, `shared/src/lifetimes.ts`, `shared/src/index.ts`, `shared/tests/**` |
| T41 web chart stage: stage layout + axis strip + legend dock, wheel semantics + hint, unbounded y + ticks, speculative ladder, smart hover, ribbons, release lens, zoomBy both axes | `web/src/chart/**`, `web/src/data.ts`, `web/src/state.ts`, `web/src/styles/chart.css`, `web/index.html` (chart section only) |
| T42 web ui: researcher panel truth, rankings age column, lifetimes strip, controls +/− wiring and copy, shortcuts copy, tour step for the hint | `web/src/ui/**`, `web/src/main.ts`, `web/src/styles/panels.css`, `web/src/styles/controls.css` |
| T43 worker: name prefixes, discovery via launch posts, verbatim issues, commit messages, `usage_total`/`last_backfill_summary`, eval unverified extras, tests | `worker/**`, `data/labs.json` (`name_prefixes` only) |
| T44 gold: Claude Opus 5 entry with primary sources | `data/gold/anthropic.json` |
| T45 docs: METHODOLOGY (§ lifetimes, ribbons, lens, speculative markers, wheel), PAPER, README, DATA-GUIDE | `docs/**`, `README.md` |
| T46 ops: deploy, full backfill, eval, promote decision | commander |

Contract edits (types, schema, `index.html` containers `[data-legend-dock]`, `[data-lifetimes]`,
`[data-chart-axis]`) are made by the commander before the tasks start. Verification for every
task: `bun run typecheck && bun run test && bun run validate` from the root, plus
`bun run --filter @agi/web build` for web tasks; T41/T42 also run the Playwright shots
(`C:\Users\lazni\AppData\Local\Temp\agi-shots\chart2.mjs`) and look at the PNGs.
