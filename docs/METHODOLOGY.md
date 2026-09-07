# Methodology

This page is the public, auditable description of every number on agi.pablogfx.com.
If code and this document disagree, the code is wrong and we fix it in the same commit.

## 1. What counts as a flagship release

A **flagship** is the most capable tier a lab offers at launch (GPT-5, Claude Opus/Fable,
Gemini Pro/Ultra, Grok N, Llama N largest public weights, DeepSeek-V/R, Qwen Max, Kimi K,
GLM-N, Mistral Large). Smaller tiers (mini, flash, lite, haiku, scout, air) are excluded.

`status`:

| status | meaning | on chart |
|---|---|---|
| `released` | publicly usable via API or product on `date` | solid point on the lab line, enters the index |
| `announced` | lab confirmed it exists / is coming, not usable yet | grey hollow marker at the expected date |
| `rumored` | credible press only, no lab confirmation | grey dashed marker |
| `cancelled` | announced then dropped | faded marker, history only |

`date` is the public launch date. `date_precision` (`day` / `month` / `quarter` / `year`) is
shown in the UI; we never invent a day.

## 2. Benchmark basket

The basket is fixed in `data/benchmarks.json`. Index benchmarks (in order of introduction):
MMLU, HumanEval, MATH (legacy anchors, saturated), GPQA Diamond, MMMU, SWE-bench Verified,
AIME, MMLU-Pro, LiveCodeBench, Humanity's Last Exam, ARC-AGI-2, Terminal-Bench 2.0, τ²-bench.
All are percentages, higher is better. Non-index benchmarks (SWE-bench Pro, BrowseComp,
OSWorld, FrontierMath) are recorded and displayed but not fitted.

Only numbers the lab itself published (launch post, model card, system card, HF card) are
`official`. A benchmark maintainer's own leaderboard number may be recorded as `maintainer`
and is flagged. Third-party aggregators are never used.

When a lab reports several configurations we prefer the one in `preferred_config`
(e.g. no tools, semi-private set) and always record the configuration actually used.

## 3. Frontier Index

Averaging raw percentages is biased: a model that only reports easy benchmarks looks better
than one that also reports hard ones. We fit a one-parameter logistic (Rasch) model instead:

    logit(score_mb / 100) = θ_m − δ_b

θ_m is model ability, δ_b is benchmark difficulty, fitted jointly on all official scores by
alternating least squares with a small ridge (λ = 0.05) and the constraint mean(δ) = 0 over
index benchmarks. Scores are clipped to [0.5 %, 99.5 %] before the logit.

**One score per benchmark.** A release may report the same benchmark several times. For each
index benchmark we keep exactly one number, picked deterministically: `official` beats
`maintainer`; among those, a `config` sharing a keyword with the benchmark's
`preferred_config` beats one that does not (both are lower-cased and split on non-letters,
with a fixed list of filler words dropped); any remaining tie goes to the score listed first
in the data file.

**The fit.** Only `released` models enter it, and only those dated on or before the scrub
date. Starting from θ = δ = 0 we alternate

    θ_m = Σ_b (y_mb + δ_b) / (n_m + λ)
    δ_b = Σ_m (θ_m − y_mb) / (n_b + λ)

where y_mb is the clipped logit, n_m the number of index benchmarks the model reports and n_b
the number of models reporting the benchmark. After every sweep δ is re-centred to mean zero
over the benchmarks that carry at least one observation and θ is shifted by the same amount,
which leaves every prediction θ_m − δ_b untouched. We stop when no parameter moves by more
than 1e-6, or after 200 sweeps. On a complete matrix with λ = 0 this reproduces the additive
decomposition exactly. Benchmarks nobody reported keep δ = 0; a model with no index score at
all gets no index rather than an invented one, and the UI says "no official scores".

**Frontier Index** = 100 · σ(θ_m): the score the model would be expected to get on a benchmark
of *average* difficulty in the basket. It is comparable across models regardless of which
subset of benchmarks they reported. We publish δ_b and per-model standard error
(residual σ / √n) in `latest.json`, and the UI shows **coverage** (n reported / n in basket).
The residual σ is pooled over all observations with N − (M + B − 1) degrees of freedom, where
M counts fitted models, B counts benchmarks with at least one observation, and the −1 is the
mean(δ) = 0 constraint. Coverage divides by the whole index basket, so a 2023 model scores
low on it because most of the basket did not exist yet — which is exactly what the reader
should see.

The **frontier line** is the running maximum of the index over released models sorted by
date; a point is emitted only where the maximum increases. **Velocity** is the ordinary
least-squares slope of that step function sampled once per day over the trailing 365 days,
expressed in index points per 30 days. Days before the first knot are excluded, and we
report no velocity at all when fewer than two knots fall inside the window.

Because δ_b is re-estimated whenever new scores arrive, historical index values can move by
a fraction of a point between updates. Every bundle records the δ vector it used.

## 4. Release forecast

**Cadence.** For each lab we take the dates of its released flagships up to the scrub date,
merge same-day launches into a single event, and use the consecutive gaps in days (gaps
shorter than a day are dropped). The cross-lab prior is the mean and the *population*
standard deviation of log(gap) pooled over every lab; with fewer than two gaps anywhere in
the data the prior σ falls back to 0.6. A lab with n gaps of its own is shrunk toward that
prior with w = 2 pseudo-observations, so labs with two releases do not get absurd certainty:

    μ_lab = (n · mean(log x) + w · μ_prior) / (n + w)
    σ_lab = √((n · var(log x) + w · σ_prior²) / (n + w))

where var is the population variance of the lab's own log-gaps (0 when n < 2). A lab with a
single release therefore inherits the prior exactly; a lab with none gets no forecast at all.

**Timing.** Given elapsed time t₀ since the last release, the next release date follows the
conditional distribution T | T > t₀ of a log-normal(μ_lab, σ_lab): its q-th quantile is
F⁻¹(F(t₀) + q · (1 − F(t₀))), and P(release within h days) is
(F(t₀ + h) − F(t₀)) / (1 − F(t₀)). When less than 1e-9 of the probability mass is left above
t₀ the lab is **overdue** and the conditional law is numerically undefined; we then report the
median as t₀ + 1 day and the probability as 1, rather than an arbitrary large number.

We draw: the conditional **median** as the circle centre; the circle **diameter** as the
16th–84th percentile window mapped on the time axis (a tight circle = confident timing);
and **P(release within 30 / 90 days)** in the Release Watch cards. Circle styling uses
**certainty** = 1 / (1 + w / 90), where w is that 16th–84th window in days — three months of
timing uncertainty halves it.

**Chained releases.** Release k ≥ 2 is placed one unconditional median interval, exp(μ_lab),
after release k − 1. Its percentile dates are an approximation rather than an exact
convolution: we keep the median of the chain and widen the log-normal spread around it by
√k, the growth rate of the standard deviation of a sum of k independent log-intervals. We
stop after 5 releases or when a median date passes 3 years from the scrub date.

**Capability** of a predicted release: ordinary least squares of the lab's θ on the day
number over its last ≤ 5 fitted releases, extrapolated to the predicted date, with the band
±1.2816 · (residual σ + slope σ · Δt) taken in logit space and mapped through σ(·) — the
10th–90th percentile, drawn as a yellow fan, with Δt measured from the last actual release.
With one fitted release the slope is 0; with two the regression is exact, so the slope's
standard error is the global residual σ divided by the span between them. The band is never
narrower than the global residual σ, because a θ is never known better than that. The central
prediction is then clamped: never above an index of 99.5, and never more than 5 index points
below the lab's last release — labs rarely regress, and a young trend line extrapolated
freely goes absurd within a year. The band around the clamped centre is left free.

Announced models with an `expected_window` override the statistical forecast for that
release and are drawn in grey: the window becomes the 16th–84th percentile band, its midpoint
the median, and the 5th/95th dates sit 15 % of the window length outside each end. The
statistical chain then continues from that midpoint as release 2. A window that has already
opened at the scrub date is ignored.

## 5. Automation and audit

An hourly worker fetches every URL in `labs.json → sources`, normalises the text and hashes
it. Only when a hash changes does it call an LLM (via OpenRouter, model recorded in
`latest.json`) with a strict JSON schema to extract released flagship models and basket
scores **with verbatim quotes**. Output is zod-validated, quotes are checked as substrings of
the fetched page, and only then written to `data/models/<lab>.json`, appended to
`data/history/changes.jsonl` and committed to git. Nothing an LLM says reaches the chart
without a matching quote on a primary page.

Time-scrubbing to a past date D shows only releases with `date ≤ D`, re-runs the forecast
as of D, and thereby lets you check how the model would have predicted what actually
happened.
