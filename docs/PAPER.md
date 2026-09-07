# The Frontier Rating

## An open, auditable standard for measuring general AI capability over time — and for forecasting it

**Paweł Łaźniak** · pablogfx.com · hexart.pl
Version 2.0 · September 2026 · Living document, revised with the code at
[github.com/lazniak/agi-frontier](https://github.com/lazniak/agi-frontier)

---

### Abstract

Benchmarks saturate. Every few years the tests that used to separate the best language models
from the rest are solved to the ceiling, and the curve of "average benchmark score" goes flat —
not because progress stopped, but because the ruler ran out. This paper describes a measurement
standard that does not run out. Every published score of every model is treated as one
observation of a latent ability θ on a single logit scale, fitted jointly across all benchmarks
and all generations of benchmarks with a Rasch model. The **Frontier Rating**
R = 1000 + 173.72·θ is an unbounded number: 400 points is a tenfold increase in the odds of
solving an arbitrary item of the basket. Older, saturated benchmarks chain the history back to
2018; new, harder benchmarks extend the scale forward without moving the past. On top of the
scale the standard defines a **frontier line** (the running maximum), a **pace** (logits per
year, expressed as the time for the odds to double), **levels** (human baselines, saturation
points, generation ceilings) with **crossing dates**, and a **release forecast** per laboratory
whose uncertainty circle shrinks as a launch approaches. The forecast is scored against what
actually happened with a rolling **backtest** and a calibration curve that is published next to
the predictions. Every number on the chart links to a primary source and a verbatim quote; the
dataset is rebuilt by an automated **researcher** through OpenRouter and is only published when
it passes a precision/recall evaluation against a frozen, human-curated gold set. The site
[agi.pablogfx.com](https://agi.pablogfx.com) is the reference implementation.

---

### 1. Why another number

Three things go wrong with the usual "average of benchmarks" chart.

1. **Compression.** A benchmark near 95 % has almost no room left. When most of the basket is
   near its ceiling the average moves a fraction of a point per generation, and the visual
   impression is that intelligence stopped growing. In odds terms the step from 90 % to 99 % is
   the same size as the step from 50 % to 91 %: it is a tenfold increase. Percentages hide it.
2. **Selection.** Labs report the benchmarks that flatter them. A model that only reports easy
   tests looks better than one that also reports hard ones. An average cannot tell the two apart.
3. **Discontinuity.** The basket changes. MMLU did not exist when GPT-2 shipped; Humanity's Last
   Exam did not exist when GPT-4 shipped. A chart that fixes one basket cannot reach back to 2018
   and cannot survive the next generation of tests.

The remedy for all three is the same one psychometrics adopted for standardised testing fifty
years ago: stop averaging scores and instead estimate a **latent ability** that explains them,
with each benchmark's **difficulty** estimated at the same time. Once every benchmark is placed on
the same logit scale, a saturated benchmark simply becomes an easy item, a new benchmark a hard
item, and a model's ability is read from whichever items it reported. The scale is unbounded, so
progress never disappears into a ceiling; it is anchored, so adding items later does not rewrite
history.

---

### 2. The data standard

The measurement is only as good as the numbers under it. The standard fixes the following rules;
the reference implementation enforces them with a schema and a validator that every change must
pass.

**Provenance.** A score is a triple (model, benchmark, value) with a `source.url` pointing at a
primary page — a launch post, a model card, a system card — and a `source.quote`: at most 300
characters copied verbatim from that page, containing the number. The quote is re-checked
against the fetched page; a score whose quote no longer matches is flagged, never silently kept.

**Who reported it.** `official` means the lab published it. `maintainer` means the benchmark's
own leaderboard published it (used for LMArena and for benchmarks that labs do not self-report).
Third-party aggregators are never a source.

**Configuration.** Labs report several configurations (with and without tools, with extended
thinking, best-of-n). Each benchmark declares a `preferred_config`; the configuration actually
used is always recorded, and exactly one score per (model, benchmark) enters the fit:
`official` beats `maintainer`, then the preferred configuration, then the earlier retrieval.

**Status.** `released` means publicly usable through an API or a product on the stated date.
Only released models enter the scale. `announced` and `rumored` models are drawn in grey and
never scored. Dates carry a precision (`day`, `month`, `quarter`, `year`); a day is never guessed.

**Tier.** Every release carries a tier: `flagship` (the lab's most capable model of that
generation), `mid` (Sonnet, Flash, mini class) or `small` (Haiku, Flash-Lite, nano class). All
tiers enter the fit — more observations sharpen every difficulty estimate — but only flagships
form the frontier line, the rankings lead and the release cadence.

**History is append-only.** Corrections are new commits and a row in a public change log.
Nothing is deleted.

**Publication rule.** The public dataset is what the automated researcher (§8) produced. Human
research is kept in a frozen gold set that is never published; its only purpose is to grade the
researcher. This is what makes the pipeline reproducible by anyone with the same tools.

---

### 3. One scale for every benchmark

#### 3.1 From a score to a probability

Each benchmark declares a unit.

- Percent benchmarks: p = clip(value, 0.5, 99.5) / 100. The clip keeps the logit finite; 99.5 %
  is treated as "solved".
- Elo benchmarks (LMArena): p = 1 / (1 + 10^((E_ref − E) / 400)), then clipped to [0.005, 0.995].
  E_ref is a fixed reference (1200 for LMArena text). The model then treats "beats the reference
  opponent" as one more item of the basket. Because 400 Elo is one order of magnitude of odds,
  100 Elo equals 0.576 logits, which is exactly the scale of §3.3.

#### 3.2 The Rasch model

    y_mb = logit(p_mb) = θ_m − δ_b

θ_m is the ability of model m, δ_b the difficulty of benchmark b. Both are fitted jointly on
every score in the dataset by weighted alternating least squares with a small ridge λ = 0.05:

    θ_m = Σ_b w_b (y_mb + δ_b) / (Σ_b w_b + λ)
    δ_b = Σ_m w_b (θ_m − y_mb) / (Σ_m w_b + λ)

w_b is the benchmark's weight (1 for everything, 2 for LMArena, whose community preference
votes summarise thousands of real tasks rather than one test). The residual standard deviation
σ_res uses weighted squared residuals and Σw − (M + B − 1) degrees of freedom; each θ carries a
standard error from the same residual.

**Anchor.** The scale is fixed by requiring mean(δ) = 0 over the observed benchmarks of the
current, non-legacy basket. θ = 0 therefore means "50 % expected on an item of average current
difficulty". Legacy benchmarks (generations 1–2, §4) are fitted but do not enter the anchor, so
their saturation does not drag the origin.

**Qualification.** A model with fewer than three benchmarks on the basket is drawn but marked
provisional; it does not form the frontier line.

#### 3.3 The Frontier Rating

    R = 1000 + (400 / ln 10) · θ  ≈ 1000 + 173.72 · θ

- 400 points = the odds of solving an arbitrary basket item are ten times higher.
- 1000 = a model that scores 50 % on an item of average current difficulty.
- The rating is unbounded in both directions. It is the primary axis of the chart and the first
  number in the rankings; ± 173.72·se is its uncertainty.

The bounded companion, the **Frontier Index** 100·σ(θ), remains available as "expected score on
an average item". The two are one number in two units; the chart toggles the label, never the
geometry.

**Why it does not compress.** σ(θ) saturates; θ does not. A saturated benchmark still enters the
fit — as an easy item on which every recent model is near the clip — but it no longer
discriminates, and the models' abilities are then determined by the harder items only they
report. The scale keeps moving as long as some benchmark has room.

---

### 4. Generations, levels and stages

#### 4.1 Benchmark generations

Benchmarks are grouped by the era in which they discriminated:

| generation | benchmarks | years |
|---|---|---|
| 1 | LAMBADA, ARC Challenge, HellaSwag, WinoGrande | 2016–2019 |
| 2 | MMLU, HumanEval, MATH, GSM8K | 2020–2021 |
| 3 | GPQA Diamond, MMMU, SWE-bench Verified, AIME, MMLU-Pro, LiveCodeBench, OSWorld, LMArena | 2023–2024 |
| 4 | Humanity's Last Exam, ARC-AGI-2, Terminal-Bench 2, τ²-bench, SWE-bench Pro, BrowseComp, FrontierMath | 2025– |

Each generation overlaps the next by two or three benchmarks (GPT-3 reported LAMBADA and
HellaSwag; the 2023 models reported those and MMLU; the 2024 models reported MMLU next to GPQA).
That overlap is what lets one fit chain 2018 to today on a single scale, although no benchmark
spans it. Generations 1–2 are legacy: fitted, not anchored.

#### 4.2 Levels — the ladder on the y axis

Every level is a θ derived from the fit, never hand-placed:

- **Human**: for a benchmark with a published human baseline h, θ = δ_b + logit(h/100)
  ("Human experts · GPQA 69.7 %").
- **Saturation**: θ = δ_b + logit(0.95) — the ability at which a benchmark is expected to be
  solved to 95 % and stops discriminating.
- **Generation**: the mean saturation θ of a generation's benchmarks ("Generation 3 basket
  saturated").
- **Ceiling**: the highest saturation level in the current basket — the point at which the
  standard itself needs new benchmarks.

#### 4.3 Crossings

A **past crossing** is the first point of the frontier line at or above a level; it carries the
model and the date. A **predicted crossing** comes from the frontier trend (§5.2): with trend
θ̂(t) = a + b·t, the crossing time of level L is t* = t_ref + (L − θ̂(t_ref)) / b, and its
uncertainty follows from the delta method,

    var(t*) = ((L − θ̂) / b²)² · se_b² + (σ_res / b)²

with normal quantiles for the 5/16/84/95 % dates. No crossing is predicted when b ≤ 0. Predicted
crossings are the circles on the dotted continuation of the frontier line and the rows of the
Stages panel ("Generation 4 basket saturated — median Mar 2028, 68 %: Oct 2027 – Nov 2028").

---

### 5. The frontier and its pace

#### 5.1 Frontier line

The frontier is the running maximum of θ over released, qualified flagships, ordered by date —
a step function with one knot per model that raised the maximum.

#### 5.2 Pace and trend

- **Pace** over a trailing window (default 365 days) is the slope of a least-squares line through
  the daily-sampled frontier, in logits per year. It is reported together with the **doubling
  time** of the odds, 365·ln 2 / pace days: "the odds double every 7.3 months".
- **Trend** is the same regression with its intercept, slope standard error and residual σ kept,
  so that it can be extrapolated with a widening band (§6.4) and used for crossings (§4.3).

#### 5.3 Eras

The pace is evaluated on a monthly grid and classified:

| regime | logits / year |
|---|---|
| dormant | < 0.5 |
| climb | 0.5 – 1.5 |
| acceleration | 1.5 – 3 |
| takeoff | ≥ 3 |

Consecutive months with the same regime form an **era**; the current trend slope gives the
projected era. The regime names are the only prose in the mathematics; the thresholds are
constants in the code.

---

### 6. Forecasting the next release

#### 6.1 Cadence

For each lab, the gaps in days between consecutive flagship launches (same-day launches merged)
are modelled as log-normal. A cross-lab prior (mean and population standard deviation of the
log-gaps pooled over every lab) is shrunk into each lab with w = 2 pseudo-observations:

    μ_lab = (n · mean(log x) + w · μ_prior) / (n + w)
    σ_lab = √((n · var(log x) + w · σ_prior²) / (n + w))

A lab with one release inherits the prior; a lab with none gets no forecast.

#### 6.2 The shrinking circle

Given the time t₀ elapsed since the last launch, the next launch date follows the conditional
law T | T > t₀. Its q-th quantile is F⁻¹(F(t₀) + q·(1 − F(t₀))). On the chart the circle is centred
on the conditional **median** and its diameter is the **16th–84th percentile window** on the time
axis. As t₀ grows the mass below t₀ is cut away, so the window narrows: the closer a launch, the
smaller the circle. This is not a drawing convention; it is a property of the conditional law, and
a unit test asserts that the window is non-increasing in t₀ for fixed (μ, σ). When a lab announces
a launch window, that window replaces the statistical band (the circle collapses to it, drawn in
grey) and the chain continues from its midpoint.

#### 6.3 Chained releases — the curve does not end

Release k ≥ 2 sits one unconditional median interval exp(μ_lab) after release k − 1, with the
log-normal spread widened by √k (the standard deviation of a sum of k independent log-intervals).
There is no horizon: the chart requests as many releases as its visible time axis needs, up to
24, and the fan keeps opening. Ability of a predicted release comes from a least-squares trend of
the lab's last five fitted θ, extrapolated to the predicted date; its band is

    θ̂ ± 1.2816 · √(σ_res² + (se_b · Δt)²)

taken in logit space (the 10th–90th percentile), never clamped — the rating axis is unbounded and
the index conversion saturates by itself.

#### 6.4 Frontier fan

Independently of any lab, the frontier trend of §5.2 is extrapolated to the right edge of the
chart with the same band. It is the grey-yellow "infinity" fan the running maximum continues into,
and the reference against which the lab forecasts are read.

---

### 7. Backtest and calibration

A forecast that is never scored is an opinion. The standard requires a rolling backtest,
published next to the predictions:

- On a grid of past dates D (every 30 days from one year after the first flagship to 30 days
  before today) the fit and the forecast are recomputed **as of D** — only releases dated ≤ D
  are visible.
- For each lab the k = 1 prediction made at D is compared with the lab's first flagship launched
  after D: error in days (actual − median), whether the actual fell inside the 68 % and the
  90 % windows, and the error in θ between the predicted and the eventually fitted ability.
- The report gives n, coverage at 68 % and 90 % (a calibrated forecast hits about 0.68 and
  0.90), mean and median absolute error, bias, θ error, a per-lab table, and a **calibration
  curve**: for each nominal quantile q ∈ {0.1, …, 0.9}, the share of actual launches that fell
  before the q-quantile date. Perfect calibration is the diagonal.

On the chart, dragging the NOW rule into the past replays exactly this: the forecast as it would
have been made on that day, and the launches that then happened, joined by a hairline coloured
green (inside 68 %), amber (inside 90 %) or red (outside). Nothing is fitted to the future; the
scrubbed view is the same code run on a truncated dataset.

---

### 8. The researcher

The dataset is rebuilt by an automated researcher whose only research tool is an LLM behind
OpenRouter, so that the whole pipeline can be re-run by anyone with the same key.

1. **Discovery.** For each lab the online-search model is asked, under a strict JSON schema, for
   every model the lab has released, with tier, launch date and launch-page URL. Only URLs on the
   lab's official hosts (or an allow-listed press host) proceed.
2. **Extraction.** Each launch page or model card is fetched and the extraction model returns
   releases and basket scores **with verbatim quotes**. A score is written only if its quote is a
   substring of the fetched page. Nothing an LLM says reaches the chart without a matching quote.
3. **Arena.** Weekly, the LMArena text leaderboard is fetched and its rows mapped to known
   releases by canonical name; each match becomes one `maintainer` score with the row as quote.
4. **Evaluation.** The researcher's output is graded against the frozen gold set: release
   precision and recall (canonical name and date within 45 days), score recall (same benchmark,
   |Δ| ≤ 1 point or ≤ 15 Elo), score mean absolute error, quote-verification rate, per lab.
5. **Promotion.** Only when recall ≥ 0.85, precision ≥ 0.95 and score recall ≥ 0.8 is the output
   merged into the published dataset — adding what the researcher found, never overwriting a
   verified score. The evaluation report itself is published.

The client retries rate limits with exponential backoff, limits concurrency, and accounts every
call; the site shows the last run, the current step and a progress bar to the next run.

---

### 9. Reading the chart

- **Y axis**: Frontier Rating, ladder of levels on the right. Toggle to Index for the bounded
  reading. Zoom and pan on both axes; the time axis is infinite to the right.
- **Lines**: one per lab, flagship θ over time, with the family band (flagship to smallest current
  tier) filled at 10 %. Lower tiers are hollow markers off the line.
- **Frontier**: the running maximum, with its pace in the strip below and its dotted, fanning
  continuation to the right.
- **Circles**: the next predicted launches per lab; centre = median date, diameter = 68 % window,
  height = ability band. Grey circles are announced windows. Smaller circle = nearer, more certain
  launch.
- **Level circles** on the frontier continuation: predicted crossings of human baselines,
  saturation points and generation ceilings.
- **NOW rule**: drag it into the past to replay the forecast against what happened; the Backtest
  card summarises the score.
- Every point, band and number opens its source and quote.

---

### 10. Limitations

- The Rasch model assumes one latent dimension. Coding, vision and agentic benchmarks are not
  perfectly one-dimensional; the residual σ measures how far that assumption is stretched and is
  published with every fit.
- Official numbers are selected by the labs. The model corrects for *which* benchmarks are
  reported, not for tuning to them. Community Elo (LMArena) is weighted 2 partly for that reason.
- The cadence model is log-normal with a pooled prior; it does not know about product cycles,
  compute availability or regulation. The backtest is the honest measure of what it does know.
- The frontier trend is linear in θ over a trailing year. Take-off or stall beyond the window
  is exactly what the eras are designed to reveal, not what the trend can anticipate.
- The researcher only sees what labs publish on their own pages. Unpublished models, and models
  whose pages resist fetching, are missing until they surface.

---

### 11. Reproducibility

Everything above is code with unit tests in a public repository: the data contract and validator,
the Rasch fit, rating, levels, crossings, eras, forecast, backtest and the researcher. The
published bundle contains every δ, every θ with its standard error, the trend, the backtest
report and the researcher's evaluation, so that any chart can be recomputed from the JSON alone.
The methodology page on the site is the operational description of the same code; where the two
disagree, the code is wrong and is fixed in the same commit.

Cite as: Łaźniak, P. (2026). *The Frontier Rating: an open, auditable standard for measuring
general AI capability over time.* agi.pablogfx.com, version 2.0.

---

### References

- Rasch, G. (1960). *Probabilistic Models for Some Intelligence and Attainment Tests.*
- Elo, A. (1978). *The Rating of Chessplayers, Past and Present.*
- Chiang, W.-L. et al. (2024). Chatbot Arena: An Open Platform for Evaluating LLMs by Human
  Preference. arXiv:2403.04132.
- Hendrycks, D. et al. (2021). Measuring Massive Multitask Language Understanding. ICLR.
- Rein, D. et al. (2023). GPQA: A Graduate-Level Google-Proof Q&A Benchmark. arXiv:2311.12022.
- Phan, L. et al. (2025). Humanity's Last Exam. arXiv:2501.14249.
- Gneiting, T. & Raftery, A. E. (2007). Strictly Proper Scoring Rules, Prediction, and
  Estimation. *JASA* 102(477).
