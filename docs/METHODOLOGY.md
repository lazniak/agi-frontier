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

### 2.1 Benchmark lifetimes

A benchmark is born, gets scored, saturates and is eventually retired. That life is a fact about
the ruler, not about the models, and the site draws it as a strip under the Method copy
(`benchmarkLifetimes`, `shared/src/lifetimes.ts`). For every benchmark, as of the viewed date:

| field | meaning |
|---|---|
| `introduced` | the year the benchmark was published |
| `firstScore` | the launch date of the first released model to report it |
| `nScores` | how many released models report it (one per model, any configuration) |
| `saturatedAt` | the first release date at which a released model's best **official** score reached 95 % of the benchmark's range (`SATURATION_SHARE`) |
| `state` | `fresh` · `active` · `saturated` · `legacy` |
| `delta` | the fitted difficulty δ_b |
| `coverageOfFrontier` | the share of the flagships released in the last 365 days that report it |

`state` is decided in that order: `legacy` when the curator retired the benchmark in
`benchmarks.json` — the same flag that keeps it out of the anchor, and the curator's retirement
beats the data; otherwise `saturated` once `saturatedAt` is set; otherwise `fresh` while it is
less than a year old (`FRESH_DAYS`); otherwise `active`. Because `introduced` is only a year, the
introduction date is taken at that year's midpoint, so a 2026 benchmark stays fresh through
mid-2027. Elo has no ceiling, so **LMArena never saturates**. Saturation is read from `official`
scores only: it is a statement about what the labs themselves claim. δ is `null` unless some
fitted model actually reported the benchmark — an unobserved index benchmark sits at exactly 0,
and that proves nothing. A benchmark whose introduction still lies ahead of the scrub date is
left out of the strip entirely, unless it already carries a score at that date, in which case the
observed evidence beats the curator's rounding.

Nothing in the fit depends on this classification; the strip exists so that a reader can see
which part of the basket was still discriminating when a given model was measured.

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

**Shared benchmarks — what the fit actually compares.** The intuitive way to compare two models
is to look at the benchmarks they both reported. The Rasch fit is that comparison generalised: it
never compares two models directly, it compares each of them with the *items* they reported, and
the items are shared with their neighbours. Model A and model C may have no benchmark in common
and still sit on one scale, because both share benchmarks with B. `comparability`
(`shared/src/lifetimes.ts`) reports, per model, the two numbers this rests on: `neighbours`, the
fitted flagships released within ±18 months of it, and `shared`, the number of index benchmarks it
was fitted on that at least one of those neighbours was fitted on too. A model with `shared = 0`
is floating; the rankings show the count as the coverage tooltip.

This is also why the death of a benchmark costs the scale nothing. When a benchmark saturates it
stops discriminating, but it does not leave: it stays in the fit as an easy item, and the
difficulty δ_b it measured — the whole of the information it ever carried — stays with it. The
models that once needed it are still placed by it; the models that came after are separated by
the harder items only they report. Retiring a benchmark to `legacy` removes it from the anchor,
i.e. from the definition of "average current difficulty", and from nothing else.

**How much evidence each rating rests on.** The mechanism above is sound; the data feeding it are
not evenly thick, and the honest place to say so is here. Measured on 2026-09-08 over the
published dataset:

| half-year | fitted released models | mean index benchmarks per model |
|---|---|---|
| 2025-H1 | 15 | 4.5 |
| 2025-H2 | 18 | 5.7 |
| 2026-H1 | 13 | 5.5 |
| **2026-H2** | **8** | **2.6** |

The newest cohort is measured with about a third of the evidence of the one before it. Some of
its rows rest on a single community Elo score and nothing else, and at that point a rating is one
number away from being a guess. The gaps between the top ratings of that cohort are smaller than
their standard errors, which means the data cannot order them however confidently the table
prints them; a row's ± is not decoration. The cause is not the estimator — the ridge pulls a
top-ten θ toward zero by only 2–8 rating points, and every 2026-H2 flagship still shares two to
four benchmarks with the cohort's highest-rated model, so the cohorts are properly linked in the
Rasch sense. The cause is missing research: matching the live LMArena leaderboard against
`data/models` on the same date, **23 of the arena's top 45 models were absent from the dataset
altogether**, so a lab's row can be led by the newest model the dataset happens to know rather
than the newest model that exists.

The remedy is therefore more research, not a different scale (§7), and the reader's rule of
thumb is simple: weigh a row by its benchmark count and its ±, and treat the most recent months
as provisional until the researcher has caught up with them.

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

**Family ribbons.** The chart fills, per lab and in the lab colour, the vertical band between the
best and the weakest member of that lab's **current family** — the real-data counterpart of the
forecast fan, and the shape that answers "what is this lab shipping right now" rather than "what
is its single best number".

`familyRibbon` (`shared/src/lineup.ts`) builds it. At every date on which the lab released
something (same-day launches collapsing into one knot), the current family is every released,
fitted model of that lab launched within the trailing **365 days** (`windowDays`); the ribbon's
upper edge `hiTheta` is the highest θ in that set and its lower edge `loTheta` the lowest, each
carrying the id of the model that set it. The band is a step path, and a final knot is emitted at
the scrub date so it can be drawn up to "now". When only one model is current the two edges
coincide and the ribbon **collapses onto the lab's line** — correctly: a lab with one live model
has no spread. When the window is empty, i.e. the lab has shipped nothing for over a year, the
family degenerates to its single latest model and the ribbon collapses rather than vanishing.

The window is the point of the difference from the older lineup band, which keeps one slot per
tier for ever: a family ribbon *forgets* a model once it is older than a year, so the band shows
the lineup a buyer could actually pick from today. The lineup band survives as the family line in
the rankings ("Family: 3 models · band 1 180 – 1 305"). The ribbon is drawn at 14 % opacity, 34 %
while its family is focused, and fades after the scrub date. Lower tiers are also drawn as small
hollow markers off the flagship line when "All tiers" is on.

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

**Speculative landmarks.** The rating axis is unbounded and the chart lets you scroll up it
without end, which leaves a great deal of empty space above the ceiling and nothing to read it
by. `speculativeLevels` (`shared/src/stages.ts`) puts four labelled landmarks there, at θ_c + k·ln 10
for k = 1…4 above the ceiling θ_c — one order of magnitude in the odds of solving the whole
current basket per rung, 400 rating points each:

| rung | label |
|---|---|
| θ_c + ln 10 | Ten times the odds of the whole basket (speculative) |
| θ_c + 2 ln 10 | A hundred times the odds of the whole basket (speculative) |
| θ_c + 3 ln 10 | Every benchmark ever written saturated (speculative) |
| θ_c + 4 ln 10 | Technological singularity — speculative landmark, not derived from data |

They are signposts on an empty axis and nothing else. They are not fitted, they are not measured,
they are not extrapolated: the arithmetic is four multiples of ln 10 above a level that *is*
fitted, and the last two labels are names, not predictions. They are returned by a separate
function from `benchmarkLevels` precisely so that nothing downstream can mistake them for data,
they are drawn in a distinct dotted grey with the word *speculative* in the label and the tooltip,
and `frontierCrossings` skips every level whose kind is `speculative`, so no crossing date is ever
computed for one. They appear in no crossing, no stage, no era, no ranking and no result in this
document or in the paper.

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

**Timing — the conditional law.** Given elapsed time t₀ since the last release, the next
release date follows the conditional distribution T | T > t₀ of a log-normal(μ_lab, σ_lab):
its q-th quantile is F⁻¹(F(t₀) + q · (1 − F(t₀))), and P(release within h days) is
(F(t₀ + h) − F(t₀)) / (1 − F(t₀)). When less than 1e-9 of the probability mass is left above
t₀ the lab is **overdue** and the conditional law is numerically undefined; we then report the
median as t₀ + 1 day and the probability as 1, rather than an arbitrary large number.

**The release lens.** A circle says only "somewhere around here". The forecast is drawn instead
as a **lens**: a shape centred on the predicted rating whose half-thickness at date t is
proportional to the probability that the launch falls on that day. It is thickest at the mode and
tapers to nothing at the tails, so the reader sees the *shape* of the belief and not just its
extent, and the ink lands where the probability is.

The density comes from `releaseDensity` (`shared/src/prediction.ts`), sampled at 48 points between
the 2nd and 98th percentile dates and normalised so the mode is 1; `releaseDensityRaw` returns the
same samples unnormalised, in probability per day, so the shape can be checked by integration.
The law is the one that placed the prediction in the first place, re-derived from the same
quantities:

- **k = 1, statistical.** The finite-difference derivative of the stretched conditional CDF
  (`stretchedConditionalCdf`, the conformally stretched form of the law above), differenced over
  one day. Each sample is therefore literally P(the launch lands on that day).
- **k ≥ 2, chained.** The log-normal density of the offset from the chain anchor with log-σ
  σ_lab · s · √k — exactly the law whose quantiles the chain publishes.
- **Announced.** A lab that published a window stated a window, not a law. Its lens is a flat
  **trapezoid**: level across the stated 16th–84th window and falling linearly to zero at the 5th
  and 95th dates. Nothing about a press release justifies a peak in the middle, so none is drawn.

Half-thickness at the mode is half the 68 % rating window in pixels, clamped to 6–42 px so a lens
is never a hairline nor a wall; the fill runs from 0.10 opacity at the tails to 0.55 at the mode.
The **68 % window is the inner outline and the 90 % window the outer edge**, with a tick on the
median. Degenerate cases — an overdue lab whose conditional law has collapsed onto tomorrow, a σ
of zero — give a window under a day wide; it is padded to one day and drawn flat, so there is
always a shape rather than an error.

The lens **narrows on its own as the launch approaches**, exactly as the circle did, and for the
same reason: as t₀ grows the mass below t₀ is cut away and the conditional window shrinks. That is
a property of the law, not a drawing rule, and a unit test asserts that the 68 % window is
non-increasing in t₀ over the lab's typical cadence. Once a lab is overdue by its own history the
heavy tail takes over and the lens opens again — the model is honestly less sure. The Release
Watch cards show **P(release within 30 / 90 days)**; lens styling uses **certainty** =
1 / (1 + w / 90), where w is the 68 % window in days. Labs outside the forecast spotlight keep a
plain whisker from the 16th to the 84th percentile date.

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
the median, and the 5th/95th dates sit 15 % of the window length outside each end. Their lens is
the flat trapezoid described above. The statistical chain then continues from that midpoint as
release 2. A window that has already opened at the scrub date is ignored.

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

   **Launch posts, not catalogues.** A model *overview* page — `/models`, `/models/gemini/`, a
   docs or pricing page — lists what exists but not when it shipped, and an extraction with no
   usable date is dropped. Reading those pages as if they were announcements is what made the
   researcher lose real releases. So a URL that looks like a catalogue is now used only as a
   *source of links*: the same-host announcement links on it are harvested, ranked by how well
   they name the model being looked for, and at most three are queued as launch posts for that
   model (a bound on cost as much as on noise). If the extraction still comes back without a
   date, it gets exactly one retry through the lab's own news index, and the date the index
   publishes for the post is passed into that retry as a known date — so a launch post that
   states no date in its body no longer fails on the one thing its index already knew.

   **Family prefixes.** An extraction that returns a bare family member ("Opus 5") would be
   stored under the wrong name and the wrong id. Each lab may declare `name_prefixes` in
   `data/labs.json` — pairs of a regular expression and a prefix, e.g.
   `^(opus|sonnet|haiku|fable|mythos)\b` → `Claude `, `^(k[0-9])\b` → `Kimi ` — applied when the
   extraction is validated. The rule is deliberately unable to
   invent anything: it only prepends, it is skipped when the name already starts with the prefix
   (so it cannot produce "Claude Claude Opus 5"), a prefix that carries a version number is
   rejected outright, and an invalid regular expression is skipped rather than allowed to take
   the extractor down. `labs.json` is data, not code.
2. `arena` — weekly, the LMArena text leaderboard is fetched and its rows mapped to known
   releases by canonical name; each match becomes one `maintainer` score with the row as quote.
3. `eval` — the researcher's output is graded against `data/gold/`, the frozen human-curated
   seed that is never published: release precision and recall (canonical name and date within
   45 days), score recall (same benchmark, |Δ| ≤ 1 point or ≤ 15 Elo), score MAE, quote
   verification rate, per lab.

   **Unverified extras.** Grading against a fixed answer key has one failure mode: a release the
   researcher found *correctly* and the gold set never recorded counts as a false positive, and
   the researcher is punished for being right. Those cases are now surfaced instead of being
   swallowed. Every extra release whose primary source is on one of the lab's own official hosts
   — the same host test discovery applies — is listed in the report as an **unverified extra**
   with its name, date and URL. It is still counted against precision, because the eval must not
   be able to grade itself; but a human can read the list, check the source and promote a genuine
   find into the gold set. The first live run surfaced Claude Opus 5, which the gold set
   mentioned in a note but had never recorded as a release; it has since been added to it.
4. `promote` — only when recall ≥ 0.85, precision ≥ 0.95 and score recall ≥ 0.8 is the output
   merged into `data/models/`: adding what the researcher found, never overwriting a verified
   score, never deleting. The eval report is published in the bundle.

The OpenRouter client retries 429/5xx with exponential backoff and jitter, honours
`Retry-After`, limits concurrency, and accounts every call (tokens, USD estimate). The worker
publishes `next_run_at`, `run_status` and `run_step`; the header shows a progress bar to the
next research run.

**What the run reports say.** Two accounts of the spend are published side by side and mean
different things: `usage_total` is the **lifetime** total across poll, discover and backfill,
while `budget` is the delta of the **last research run** alone. Reading the second as the first
is what made the panel claim the LLM had made zero calls on a day it had made a hundred. Each
step — backfill, arena, eval — writes its own one-line summary into `last_backfill_summary`
(`backfill: 10 labs, 8 candidates, 1 release / 0 scores, 107 calls · 2.03 USD`), so the panel can
say what actually happened rather than what the last poll happened to see. Schema failures are
logged with every zod issue rendered verbatim as `path: message`, root-level issues included.

**How often it runs.** Research costs money per run, so it is scaled to how many people actually
read the result. The bundle publishes `worker.researcher.cadence` — `tier`, `interval_hours`,
`visitors_per_day`, `days_measured`, `capped`, `next_research_at` — and the schedule is:

| visitors / day (7-day mean) | tier | research every |
|---|---|---|
| under 3 | `weekly` | 7 days (the default) |
| 3 – 9 | `often` | 3 days |
| 10 – 29 | `daily` | 24 hours |
| 30 – 99 | `twice-daily` | 12 hours |
| 100 or more | `frequent` | 6 hours |

A tier steps up as soon as the average qualifies and steps down only after two consecutive days
below the band, so a quiet weekend does not flip it. A monthly spend guard
(`RESEARCH_MONTHLY_USD`, default 60 USD) computed from `usage_total` month-to-date forces the
weekly tier and sets `capped`. With no day of traffic measured yet the weekly default applies;
`cadence` is the single place to look for which tier is in force. The hourly poll is unaffected —
it costs an LLM call only when a page's hash has actually changed.

**How a visit is counted, and what is not stored.** There is no analytics script on the site, no
cookie and no third-party request; the page makes exactly one network call, for `/latest.json`.
A visit is one such request in the web server's own access log. Privacy is the constraint the
rest of the design follows from, because the only thing wanted is a count and the only thing an
access log naturally keeps is addresses:

- No raw address is written to the run state, to a log line of ours, or anywhere else. Addresses
  exist as local variables while the log is being folded in, and the log itself is truncated as
  soon as it has been counted.
- The **open** day holds a set of `sha256(salt : address)` truncated to 12 hex characters. The
  salt is 16 random bytes minted when the day opens and destroyed when it closes, so two days'
  hashes are unlinkable even for the same visitor — there is no key that turns one day's set into
  another's, and nobody holding the state file can ask "was this address here on day D".
- A **closed** day keeps `{ date, unique }` and nothing else: one integer. At most 14 closed days
  are retained.
- Obvious bots are dropped by user agent.

Only the cadence summary above is published; the day counts behind it are not.

## 8. Reading the chart

The chart is a **stage**: a control bar, the plot, a time-axis strip pinned to the stage's bottom
edge so the dates never leave the screen while the plot pans vertically, and a legend dock of lab
and layer chips.

**Scrolling and zooming.** A plain wheel scrolls the page — that is what a wheel does everywhere
else, and a chart that swallows it traps the reader on it. Zooming is therefore explicit:

| gesture | effect |
|---|---|
| wheel (no modifier) | scrolls the page — the chart does not capture it |
| Ctrl + Shift + wheel | zoom both axes about the pointer |
| Ctrl + wheel | zoom time only |
| Shift + wheel | zoom rating only |
| drag | pan both axes |
| pinch | zoom both axes |
| `+` / `−` | zoom both axes about the centre of the plot |
| `0` | fit the axes to what is on screen · `Esc` resets the zoom |

Cmd counts as Ctrl on a Mac. The first plain wheel over the plot shows the hint "Ctrl + Shift +
scroll to zoom · drag to pan · + / − buttons" for four seconds, once per browser. The rating axis
is unbounded upwards — keep zooming out and the forecast fans open like scissors, with the
speculative landmarks of §4 far above the data.

**Hovering picks a family.** The pointer does not have to hit a line. The nearest family — its
line, its points, its release lens — is emphasised and the others quieten to 18 %. To stop that
focus flickering between two families running side by side, it moves only when another family is
at least 14 px closer than the current one, or the current one is more than 60 px away, and only
after the pointer has rested for 90 ms; leaving the plot clears it after 250 ms. Nothing beyond
80 px takes the focus at all. **Click pins** a family, clicking again or **Escape** unpins it,
and while a family is pinned the pointer does not move the focus. The same focus drives the
legend chips and the tooltip header. `prefers-reduced-motion` removes the cross-fade.

The **NOW rule** is the time scrubber: drag it into the past and the fit, the frontier, the
forecasts, the rankings and the watch cards are all recomputed as of that date (§6).
