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

**Frontier Index** = 100 · σ(θ_m): the score the model would be expected to get on a benchmark
of *average* difficulty in the basket. It is comparable across models regardless of which
subset of benchmarks they reported. We publish δ_b and per-model standard error
(residual σ / √n) in `latest.json`, and the UI shows **coverage** (n reported / n in basket).

The **frontier line** is the running maximum of the index over released models. **Velocity**
is the least-squares slope of the frontier line over the trailing 365 days, in index points
per month.

Because δ_b is re-estimated whenever new scores arrive, historical index values can move by
a fraction of a point between updates. Every bundle records the δ vector it used.

## 4. Release forecast

For each lab, take the inter-release intervals of released flagships (days). Fit a
log-normal (μ, σ) with shrinkage toward the cross-lab prior (weight 2 pseudo-observations)
so labs with two releases do not get absurd certainty. Given elapsed time t₀ since the last
release, the next release date follows the conditional distribution T | T > t₀.

We draw: the conditional **median** as the circle centre; the circle **diameter** as the
16th–84th percentile window mapped on the time axis (a tight circle = confident timing);
and **P(release within 30 / 90 days)** in the Release Watch cards.

Capability of the next release: linear trend of the lab's θ over its last ≤5 releases,
extrapolated to the predicted date, ± (residual σ + slope uncertainty · Δt). Drawn as a
yellow min–max fan (10th–90th percentile). Subsequent releases are chained from the previous
predicted date with widening uncertainty; we stop after 5 releases or 3 years.

Announced models with an `expected_window` override the statistical forecast for that
release and are drawn in grey.

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
