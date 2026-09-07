# Methodology

This page is the public, auditable description of every number on agi.pablogfx.com.
If code and this document disagree, the code is wrong and we fix it in the same commit.
The standard itself — why it is built this way and how to cite it — is in [PAPER.md](PAPER.md).

## 1. What counts as a release

Every release carries a **tier**: `flagship` (the most capable model a lab offers at launch —
GPT-5, Claude Opus/Fable, Gemini Pro/Ultra, Grok N, Llama N largest public weights, DeepSeek-V/R,
Qwen Max, Kimi K, GLM-N, Mistral Large), `mid` (Sonnet, Flash, mini class) or `small` (Haiku,
Flash-Lite, nano class). A release without a tier is a flagship. All tiers enter the fit (§3):
more observations sharpen every difficulty estimate. Only flagships form the frontier line, lead
the rankings and set a lab's release cadence; the other tiers draw the lab's **family band** (§3)
and appear in the rankings under "All tiers".

`status`:

| status | meaning | on chart |
|---|---|---|
| `released` | publicly usable via API or product on `date` | solid point on the lab line, enters the fit |
| `announced` | lab confirmed it exists / is coming, not usable yet | grey hollow marker at the expected date |
| `rumored` | credible press only, no lab confirmation | grey dashed marker |
| `cancelled` | announced then dropped | faded marker, history only |

`date` is the public launch date. `date_precision` (`day` / `month` / `quarter` / `year`) is
shown in the UI; we never invent a day.

`origin` records who found the release: `gold` for the human-curated seed, `researcher` for the
automated pipeline (§7). The site publishes only what the researcher produced once it has been
promoted; until then the seed is shown and labelled as such.

## 2. Benchmark basket

The basket is fixed in `data/benchmarks.json`. Each benchmark has a **unit**, a **weight**, a
**generation** and a `legacy` flag.

| generation | benchmarks | years they discriminated |
|---|---|---|
| 1 (legacy) | LAMBADA, ARC Challenge, HellaSwag, WinoGrande | 2016–2019 |
| 2 (legacy) | MMLU, HumanEval, MATH, GSM8K | 2020–2021 |
| 3 | GPQA Diamond, MMMU, SWE-bench Verified, AIME, MMLU-Pro, LiveCodeBench, OSWorld, LMArena | 2023–2024 |
| 4 | Humanity's Last Exam, ARC-AGI-2, Terminal-Bench 2.0, τ²-bench, SWE-bench Pro, BrowseComp, FrontierMath | 2025– |

Index benchmarks (`in_index: true`) are fitted; the rest are recorded and displayed only.
Generations 1–2 are **legacy**: fitted, but outside the anchor (§3). They exist to reach back in
time. GPT-2 reported LAMBADA; GPT-3 reported LAMBADA, HellaSwag, ARC and WinoGrande; the 2023
generation reported those plus MMLU, GSM8K and HumanEval; the 2024 generation reported MMLU and
GSM8K next to GPQA and MATH. Each generation overlaps the next, so one fit chains the whole
history onto one scale even though no single benchmark spans it. A release with no score on any
index benchmark (GPT-1, the first Kimi) has no rating and is drawn as a tick on the timeline only.

**Units.** Every benchmark but one is a percentage, higher is better. **LMArena (text)** is an
Elo from community preference votes; its unit is `elo` with a fixed reference of 1200 (§3 says
how it enters the fit). It is the one benchmark that is not a test: thousands of real tasks judged
by people. For that reason it carries **weight 2**; every other benchmark has weight 1.

Only numbers the lab itself published (launch post, model card, system card, HF card) are
`official`. A benchmark maintainer's own leaderboard number may be recorded as `maintainer` and
is flagged; LMArena scores are always `maintainer`. Third-party aggregators are never used.

When a lab reports several configurations we prefer the one in `preferred_config` (e.g. no
tools, semi-private set) and always record the configuration actually used.

## 3. Frontier Rating and Frontier Index

Averaging raw percentages is biased: a model that only reports easy benchmarks looks better
than one that also reports hard ones — and once the basket is near its ceiling the average
stops moving although the models do not. We fit a one-parameter logistic (Rasch) model instead:

    y_mb = logit(p_mb) = θ_m − δ_b

θ_m is model ability, δ_b is benchmark difficulty, fitted jointly on all scores.

**From a score to p.** Percent benchmarks: p = clip(value, 0.5, 99.5) / 100. Elo benchmarks:
p = 1 / (1 + 10^((E_ref − E) / 400)), clipped to [0.005, 0.995] — the probability of beating the
reference opponent, treated as one more item. 400 Elo is one order of magnitude of odds, so
100 Elo is 0.576 logits.

**One score per benchmark.** A release may report the same benchmark several times. For each
index benchmark we keep exactly one number, picked deterministically: `official` beats
`maintainer`; among those, a `config` sharing a keyword with the benchmark's
`preferred_config` beats one that does not (both are lower-cased and split on non-letters,
with a fixed list of filler words dropped); any remaining tie goes to the score listed first
in the data file.

**The fit.** Only `released` models enter it, and only those dated on or before the scrub
date. Starting from θ = δ = 0 we alternate the weighted least-squares updates

    θ_m = Σ_b w_b (y_mb + δ_b) / (Σ_b w_b + λ)
    δ_b = Σ_m w_b (θ_m − y_mb) / (Σ_m w_b + λ)

with ridge λ = 0.05 and w_b the benchmark weight. After every sweep δ is re-centred to mean
zero over the **anchor** benchmarks — the non-legacy index benchmarks that carry at least one
observation (every observed benchmark when no anchor is observed) — every δ and θ is shifted
by the same amount, and every prediction θ_m − δ_b stays untouched. Anchoring on the current
basket rather than on everything ever fitted is what keeps the scale meaningful as benchmarks
are retired to `legacy` or old ones are added to link early models: the zero of the scale is
"average difficulty of today's basket". We stop when no parameter moves by more than 1e-6, or
after 200 sweeps. On a complete matrix with λ = 0 and equal weights this reproduces the additive
decomposition exactly. Benchmarks nobody reported keep δ = 0; a model with no index score at
all gets no rating rather than an invented one.

The residual σ is pooled over all observations, weighted, with Σw − (M + B − 1) degrees of
freedom, where M counts fitted models, B counts benchmarks with at least one observation, and
the −1 is the mean(δ) = 0 constraint. Each θ carries a standard error from that residual. We
publish every δ_b and every θ_m with its standard error in `latest.json`, and the UI shows
**coverage** (n reported / n in basket).

**Frontier Rating.**

    R = 1000 + (400 / ln 10) · θ  ≈ 1000 + 173.72 · θ

400 rating points = the odds of solving an arbitrary basket item are ten times higher; 1000 = a
model that scores 50 % on an item of average current difficulty. The rating is unbounded in
both directions, so a saturated benchmark cannot flatten the curve: it becomes an easy item on
which recent models sit at the clip, and their ratings are set by the harder items only they
report. The rating is the primary y axis and the first number in the rankings, with ± 173.72 · se.

**Frontier Index** = 100 · σ(θ_m): the score the model would be expected to get on a benchmark
of *average* difficulty in the basket. It is the same number in bounded units; the chart's axis
toggle relabels the ticks and moves nothing.

**Qualified vs provisional.** A model with fewer than 3 index benchmarks (`MIN_QUALIFIED_SCORES`)
is **provisional**: it is fitted and drawn like any other point, but with a hollow marker and a
"provisional" badge, it is listed after the qualified models in the rankings, it never forms
the frontier line and it does not feed a lab's capability trend unless the lab has fewer than two
qualified releases. The reason is mechanical: a launch post that reports only one hard benchmark
pins θ from a single logit with nothing to contradict it. Three benchmarks are the minimum for
the residual to say anything about that model.

**The axis is linear in θ.** Equal steps are equal odds ratios. Rating ticks every 100 / 200 /
400 points depending on zoom; in index mode the ladder is …10 · 20 · 30 · 50 · 70 · 80 · 90 ·
95 · 98 · 99…, thinned by pixel distance. The axis pans and zooms; nothing is clamped.

**Family bands.** For each lab the chart fills, in the lab colour at 10 %, the area between the
current flagship's θ and the lowest θ in the lab's current lineup (latest released model per
tier as of each date). A lab with one tier has no band. Lower tiers are drawn as small hollow
markers off the flagship line when "All tiers" is on.

**Frontier line and pace.** The **frontier line** is the running maximum of θ over released,
qualified flagships sorted by date; a point is emitted only where the maximum increases.
**Pace** is the ordinary least-squares slope of θ along that step function, sampled once per
day over the trailing 365 days, in logits per year; we also report the implied **odds-doubling
time**, ln 2 divided by the daily slope. Days before the first knot are excluded, and no pace is
reported when fewer than two knots fall inside the window. The strip under the chart shows the
frontier's gain in θ per calendar quarter, shaded by era (§4).

Because δ_b is re-estimated whenever new scores arrive, historical ratings can move by a few
points between updates. Every bundle records the δ vector it used.

## 4. Levels, crossings and eras

**Levels** are θ values derived from the fit, drawn as a ladder in the chart's right gutter:

- **Human**: for a benchmark with a published human baseline h, θ = δ_b + logit(h / 100).
- **Saturation**: θ = δ_b + logit(0.95) — where the benchmark stops discriminating.
- **Generation**: the mean saturation θ of a generation's benchmarks.
- **Ceiling**: the highest saturation level of the current (non-legacy) basket — where the
  standard itself needs new benchmarks.

Elo benchmarks have no saturation level. Only benchmarks with at least one observation get
levels; levels closer than a pixel gap are thinned in the UI.

**Frontier trend.** The same regression as the pace, keeping intercept, slope standard error
se_b and residual σ_res, so that it can be extrapolated: the **frontier fan** is
θ̂(t) ± 1.2816 · √(σ_res² + (se_b · (t − t_ref))²) to the right edge of the chart, whatever the
zoom, with the median drawn as the dotted continuation of the frontier line.

**Crossings.** A **past** crossing is the first knot of the frontier line with θ ≥ level (date and
model recorded). A **predicted** crossing uses the trend: t* = t_ref + (L − θ̂(t_ref)) / b and,
by the delta method, var(t*) = ((L − θ̂) / b²)² · se_b² + (σ_res / b)²; the 5/16/84/95 % dates
are normal quantiles, never earlier than the scrub date. No crossing is predicted when b ≤ 0 or
its median is more than 15 years out. Predicted crossings are the ink circles on the frontier
median (diameter = 68 % window on the time axis) and the rows of the Stages panel.

**Eras.** The pace is evaluated on a monthly grid from one year after the first knot and
classified: **dormant** < 0.5, **climb** 0.5–1.5, **acceleration** 1.5–3, **takeoff** ≥ 3
logits per year. Consecutive months in the same regime form an era; the regime of the current
trend slope is the projected era. The names are the only prose in the maths.

## 5. Release forecast

**Cadence.** For each lab we take the dates of its released **flagships** up to the scrub date,
merge same-day launches into a single event, and use the consecutive gaps in days (gaps
shorter than a day are dropped). Each gap is weighted by recency, w_i = 0.5^(age_i / 730),
with age in days from the later launch of the pair to the scrub date (`halfLifeDays`, default
730; ∞ reproduces the unweighted fit). The cross-lab prior is the weighted mean and the
weighted *population* standard deviation of log(gap) pooled over every lab; with fewer than two
gaps anywhere in the data the prior σ falls back to 0.6. A lab with effective sample size
n_eff = (Σw)² / Σw² is shrunk toward that prior with w = 2 pseudo-observations, so labs with
two releases do not get absurd certainty:

    μ_lab = (n_eff · mean_w(log x) + w · μ_prior) / (n_eff + w)
    σ_lab = √((n_eff · var_w(log x) + w · σ_prior²) / (n_eff + w))

where var_w is the weighted population variance of the lab's own log-gaps (0 when n < 2). A lab
with a single release therefore inherits the prior exactly; a lab with none gets no forecast.

**Drift.** Labs accelerate, so a pooled drift β of log-gaps over time is estimated by
recency-weighted ridge regression of log(gap) on the interval's end date over every lab
(ridge κ = (2 years)², pulling β to 0 when the data are thin), and each lab's μ is evaluated at
the scrub date: μ_lab(asOf) = μ_lab + β · (asOf − t̄_lab), where t̄_lab is the lab's weighted mean
interval end date; the shift is clamped to ±1 in log-days. `drift: false` disables it.

**Conformal stretch.** The windows are then stretched about their median by the scale s from §6:
with m the conditional median, the q-quantile becomes m · (q_raw / m)^s, and P(release within
h days) is read at the pulled-back time m · (t / m)^(1/s). The median — the circle's centre —
never moves with s; only the width does. (Scaling σ instead would drag the conditional median
later: at s = 2.4 it moved the centre 110 days, which is why the stretch is defined this way.)

**Timing — the shrinking circle.** Given elapsed time t₀ since the last release, the next
release date follows the conditional distribution T | T > t₀ of a log-normal(μ_lab, σ_lab):
its q-th quantile is F⁻¹(F(t₀) + q · (1 − F(t₀))), and P(release within h days) is
(F(t₀ + h) − F(t₀)) / (1 − F(t₀)). When less than 1e-9 of the probability mass is left above
t₀ the lab is **overdue** and the conditional law is numerically undefined; we then report the
median as t₀ + 1 day and the probability as 1, rather than an arbitrary large number.

We draw: the conditional **median** as the circle centre; the circle **diameter** as the
16th–84th percentile window mapped on the time axis. As t₀ grows, the mass below t₀ is cut
away and the window narrows — the circle shrinks as the launch nears. This is a property of the
conditional law, not a drawing rule, and a unit test asserts that the 68 % window is
non-increasing in t₀ over the lab's typical cadence. Once the lab is overdue by its own history
the heavy tail takes over and the window opens again: the model is honestly less sure. The Release Watch cards show **P(release within 30 / 90
days)**; circle styling uses **certainty** = 1 / (1 + w / 90), where w is the 68 % window in days.

**Chained releases — no horizon.** Release k ≥ 2 is placed one unconditional median interval,
exp(μ_lab), after release k − 1. Its percentile dates are an approximation rather than an exact
convolution: we keep the median of the chain and widen the log-normal spread around it by
√k, the growth rate of the standard deviation of a sum of k independent log-intervals. There
is no time cap: "Next" draws one release ahead per lab, "Long" the full chain up to 24
releases, and fans are recomputed to whatever the visible time axis needs.

**Capability** of a predicted release: ordinary least squares of the lab's θ on the day
number over its last ≤ 5 fitted flagships, extrapolated to the predicted date, with the band

    θ̂ ± 1.2816 · √(σ_res² + (se_b · Δt)²)

taken in logit space — the 10th–90th percentile, drawn as a yellow fan, with Δt measured from
the last actual release. With one fitted release the slope is 0; with two the regression is
exact, so the slope's standard error is the global residual σ divided by the span between them.
The band is never narrower than the global residual σ, because a θ is never known better than
that. Nothing is clamped: the rating axis is unbounded and the index conversion saturates by
itself.

Announced models with an `expected_window` override the statistical forecast for that
release and are drawn in grey: the window becomes the 16th–84th percentile band, its midpoint
the median, and the 5th/95th dates sit 15 % of the window length outside each end. The
statistical chain then continues from that midpoint as release 2. A window that has already
opened at the scrub date is ignored.

## 6. Backtest and calibration

A forecast that is never scored is an opinion. On a grid of past dates D — every 30 days from
one year after the first flagship to 30 days before today — the fit and the forecast are
recomputed **as of D**, seeing only releases dated ≤ D. For each lab the k = 1 prediction made
at D is compared with the lab's first flagship launched after D:

- `errorDays` = actual − predicted median; `in68` / `in90` = whether the actual date fell
  inside the 16–84 % / 5–95 % windows;
- θ error = predicted θ − the θ that model eventually received in today's fit.

The report gives n (rows with both a prediction and an outcome; rows where the lab had no
history yet as of D are counted apart as `unforecastable`), **coverage** at 68 % and 90 % (a
calibrated forecast hits about 0.68 and 0.90), mean and median absolute error, bias, θ MAE, a
per-lab table and a **calibration curve**: for each nominal quantile q ∈ {0.1, …, 0.9}, the
share of actual launches that fell before the q-quantile date. Perfect calibration is the
diagonal.

**Conformal scale.** The backtest closes the loop: `calibrateForecast` searches the stretch s on
the grid 1.0, 1.1, …, 3.0 for the value that minimises |coverage₆₈ − 0.68| + |coverage₉₀ − 0.90|
over the replay (ties go to the smaller s), and the chosen s stretches every window of §5 about
its median. The worker writes the report (with s, the half-life and the drift) into the bundle;
the site applies s and shows the report under the chart.

**Time-scrubbing** to a past date D shows only releases with `date ≤ D`, re-runs everything as
of D, and overlays what then happened: each predicted circle is joined by a hairline to the
actual launch — green inside the 68 % window, amber inside 90 %, red outside. It is the same
code run on a truncated dataset; nothing is fitted to the future.

## 7. Automation and audit

**Hourly poll.** The worker fetches every URL in `labs.json → sources`, normalises the text and
hashes it. Only when a hash changes does it call an LLM (via OpenRouter, model recorded in
`latest.json`) with a strict JSON schema to extract released models, their tier and basket
scores **with verbatim quotes**. Output is zod-validated, quotes are checked as substrings of
the fetched page, and only then written to `data/models/<lab>.json`, appended to
`data/history/changes.jsonl` and committed to git. Nothing an LLM says reaches the chart
without a matching quote on a primary page.

**Researcher.** The dataset is rebuilt by an automated researcher whose only research tool is
an LLM behind OpenRouter:

1. `backfill` — for each lab, the online-search model lists every model the lab has released
   (tier, date, launch URL); only URLs on the lab's official hosts or an allow-listed press host
   proceed; each launch page is fetched and extracted as above; results go to
   `data/researched/`.
2. `arena` — weekly, the LMArena text leaderboard is fetched and its rows mapped to known
   releases by canonical name; each match becomes one `maintainer` score with the row as quote.
3. `eval` — the researcher's output is graded against `data/gold/`, the frozen human-curated
   seed that is never published: release precision and recall (canonical name and date within
   45 days), score recall (same benchmark, |Δ| ≤ 1 point or ≤ 15 Elo), score MAE, quote
   verification rate, per lab.
4. `promote` — only when recall ≥ 0.85, precision ≥ 0.95 and score recall ≥ 0.8 is the output
   merged into `data/models/`: adding what the researcher found, never overwriting a verified
   score, never deleting. The eval report is published in the bundle.

The OpenRouter client retries 429/5xx with exponential backoff and jitter, honours
`Retry-After`, limits concurrency, and accounts every call (tokens, USD estimate). The worker
publishes `next_run_at`, `run_status` and `run_step`; the header shows a progress bar to the
next research run.
