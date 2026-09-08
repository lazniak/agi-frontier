/**
 * Release-date forecast per lab + capability fan. See docs/METHODOLOGY.md §4.
 * Pure functions, no I/O. API frozen; implementation: shared-math task.
 */
import type { ISODate, LabId, ModelRelease, ModelTier } from './types';
import type { IndexFit, ModelIndex } from './frontier-index';
import { indexFromTheta, thetaFromIndex } from './frontier-index';
import { addDays, dateToDayNumber, dayNumberToDate, daysBetween } from './timeline';

import {
  clamp,
  lognormalCdf,
  lognormalQuantile,
  mean,
  normalInverseCdf,
  normalPdf,
  populationSd,
  populationVariance,
} from './stats';

export interface ForecastOptions {
  /** Forecast "as of" this date; only releases with date <= asOf are used. */
  asOf: ISODate;
  /** Pseudo-observations pulling a lab's (μ, σ) toward the cross-lab prior (default 2). */
  priorWeight?: number;
  /**
   * Horizon in days for chained predictions. Default: unbounded — the chain runs until
   * `maxReleases` predictions exist (REDESIGN §4). When given, it caps the chain as before.
   */
  horizonDays?: number | undefined;
  /** Max chained predicted releases per lab (default 5, hard cap 24). */
  maxReleases?: number | undefined;
  /** Number of most recent releases used for the capability trend (default 5, min 2). */
  trendPoints?: number | undefined;
  /**
   * Which lineup tiers drive the cadence, the anchor release and the capability trend
   * (REDESIGN §3/§4: flagship only by default — the forecast cadence is a flagship cadence).
   */
  tierFilter?: ModelTier[] | undefined;
  /**
   * Recency half-life in days for the cadence (default 730): interval i is weighted
   * `w_i = 0.5^(age_i / halfLifeDays)` where `age_i` = days from the END of the interval
   * (the later release) to `asOf`. `Infinity` = unweighted (REDESIGN §4, iteration 2).
   */
  halfLifeDays?: number | undefined;
  /** Multiplier on the lab's σ after shrinkage, before any quantile (default 1). */
  sigmaScale?: number | undefined;
  /**
   * Apply the pooled cadence drift to the lab's μ (default true; REDESIGN §4, iteration 3).
   * `false` reproduces the iteration-2 stationary forecast exactly.
   */
  drift?: boolean | undefined;
}

/**
 * Pooled cadence prior over all labs' log-intervals: the shrinkage target (μ, σ) plus the
 * pooled drift of the cadence (REDESIGN §4, iteration 3).
 */
export interface CadencePrior {
  mu: number;
  sigma: number;
  /** Kish effective number of intervals pooled. */
  n: number;
  /**
   * Pooled recency-weighted ridge slope of log-gap on end-day, in log-days per day:
   * `β = Σw(t−t̄)(y−ȳ) / (Σw(t−t̄)² + κ)` with `κ = (365·2)²`, `t` = the interval's END day
   * number, `y = ln(interval)` and `w = 0.5^(age/halfLifeDays)`. Exactly 0 with a single
   * interval (the ridge keeps the slope identified and shrunk toward 0).
   */
  driftPerDay: number;
  /** Recency-weighted mean END day number of the pooled intervals (the drift's time origin). */
  tBar: number;
}

export interface PredictedRelease {
  /** 1 = next release, 2 = the one after, ... */
  k: number;
  medianDate: ISODate;
  p05Date: ISODate;
  p16Date: ISODate;
  p84Date: ISODate;
  p95Date: ISODate;
  /** Expected ability (logit) and index at medianDate. */
  theta: number;
  index: number;
  /** θ behind `indexLow` / `indexHigh` — the un-clamped capability band (REDESIGN §4). */
  thetaLow: number;
  thetaHigh: number;
  /** 10th / 90th percentile of index at medianDate. */
  indexLow: number;
  indexHigh: number;
  /**
   * Timing certainty 0–1 used for circle styling: 1 / (1 + windowDays / 90),
   * where windowDays = p84 − p16. Documented in METHODOLOGY §4.
   */
  certainty: number;
  /** `announced` when an announced model with expected_window overrides the statistics. */
  source: 'statistical' | 'announced';
  /** For `announced`: the release id it refers to. */
  release_id?: string;
}

export interface CapabilityTrend {
  /** θ per day. */
  slopePerDay: number;
  /** θ at day number 0 (see timeline.dateToDayNumber). */
  intercept: number;
  residualSigma: number;
  /** Standard error of the slope. */
  slopeSe: number;
  n: number;
}

export interface LabForecast {
  lab: LabId;
  asOf: ISODate;
  lastRelease: { release_id: string; date: ISODate; index: number } | null;
  /** Inter-release intervals used (days), oldest first. */
  intervalsDays: number[];
  /** Shrunk log-normal parameters (σ unstretched; see `sigmaScale`). */
  mu: number;
  sigma: number;
  /** Conformal stretch of every window about its median (REDESIGN §5); 1 = the raw law. */
  sigmaScale: number;
  elapsedDays: number;
  /** P(next release within 30 / 90 days | none so far). 0 when the lab has no released flagship yet. */
  p30: number;
  p90: number;
  next: PredictedRelease[];
  trend: CapabilityTrend | null;
}

export interface FanPoint {
  date: ISODate;
  /** 10th / 50th / 90th percentile of index along the extrapolated trend. */
  low: number;
  mid: number;
  high: number;
  /** The θ values behind `low` / `mid` / `high` (un-clamped, REDESIGN §4). */
  theta: number;
  thetaLow: number;
  thetaHigh: number;
}

/** z for the 90th percentile — the constant published in METHODOLOGY §4. */
export const Z90 = 1.2816;

/** Below this remaining probability mass the lab is "overdue" and the conditional law degenerates. */
const OVERDUE_EPS = 1e-9;
/** Offsets are clamped to a century so a pathological σ can never produce an invalid Date. */
const MAX_OFFSET_DAYS = 36_500;
/** Used only when there is not a single inter-release interval anywhere in the data. */
export const DEFAULT_PRIOR_MU = Math.log(120);
/** Fallback σ of log-intervals when fewer than 2 intervals exist (METHODOLOGY §4). */
export const DEFAULT_PRIOR_SIGMA = 0.6;

/** Ridge constant of the pooled drift: two years of end-day variance in log-day units. */
export const DRIFT_KAPPA = (365 * 2) ** 2;

const Q_LEVELS = { p05: 0.05, p16: 0.16, p50: 0.5, p84: 0.84, p95: 0.95 } as const;

function clampOffset(days: number): number {
  if (!Number.isFinite(days)) return MAX_OFFSET_DAYS;
  return clamp(days, 0, MAX_OFFSET_DAYS);
}

function certaintyFor(p16: ISODate, p84: ISODate): number {
  const windowDays = Math.max(0, daysBetween(p16, p84));
  return 1 / (1 + windowDays / 90);
}

/** Conditional quantile of a log-normal T given T > t0 (all in days). q in (0,1). */
export function lognormalConditionalQuantile(mu: number, sigma: number, t0: number, q: number): number {
  const qq = clamp(q, 1e-12, 1 - 1e-12);
  if (!(t0 > 0)) return lognormalQuantile(mu, sigma, qq); // t0 <= 0 → unconditional
  const f0 = lognormalCdf(mu, sigma, t0);
  // Overdue lab: essentially all of the mass is already behind us and the conditional law is
  // numerically undefined. We report "tomorrow" rather than an arbitrarily large number.
  if (1 - f0 < OVERDUE_EPS) return t0 + 1;
  const target = clamp(f0 + qq * (1 - f0), 1e-12, 1 - 1e-12);
  return lognormalQuantile(mu, sigma, target);
}

/** P(T <= t0 + horizon | T > t0) for a log-normal T. */
export function lognormalConditionalProb(mu: number, sigma: number, t0: number, horizon: number): number {
  if (!(horizon > 0)) return 0;
  if (!(t0 > 0)) return clamp(lognormalCdf(mu, sigma, horizon), 0, 1);
  const f0 = lognormalCdf(mu, sigma, t0);
  if (1 - f0 < OVERDUE_EPS) return 1; // overdue → treat as certain within any horizon
  return clamp((lognormalCdf(mu, sigma, t0 + horizon) - f0) / (1 - f0), 0, 1);
}

/**
 * Conformal stretch of the conditional waiting law about its median (REDESIGN §5): with
 * m = the conditional median, the q-quantile becomes m · (q_raw / m)^s. s > 1 widens every
 * window in log-time while the median — the circle's centre — stays exactly where the
 * unstretched law puts it (scaling σ instead would drag the conditional median later).
 */
export function stretchedConditionalQuantile(mu: number, sigma: number, t0: number, q: number, s: number): number {
  const raw = lognormalConditionalQuantile(mu, sigma, t0, q);
  if (!(s > 0) || s === 1) return raw;
  const m = lognormalConditionalQuantile(mu, sigma, t0, 0.5);
  if (!(m > 0) || !(raw > 0)) return raw;
  return m * Math.pow(raw / m, s);
}

/**
 * CDF of the stretched conditional law at the absolute time `t` (days since the anchor release):
 * P(T' ≤ t) with T' = m · (T / m)^s — the unstretched conditional probability at the pulled-back
 * time m · (t / m)^(1/s). This is the exact inverse of {@link stretchedConditionalQuantile}:
 * `stretchedConditionalCdf(…, stretchedConditionalQuantile(…, q, s), s) === q`.
 *
 * It is deliberately **not** truncated at `t0`. For s > 1 and a lab still inside its cycle
 * (t0 < the conditional median m) the stretch maps the left tail to times before `t0`: the
 * support of T' begins at m · (t0/m)^s, which is earlier than `t0`. That is the same mass the
 * stretched quantiles already report — `forecastLab` writes p05/p16 dates before asOf in exactly
 * this situation — so a density that refuses to show it has to dump it somewhere. Truncating at
 * `t0` (what {@link stretchedConditionalProb} does, correctly for its own question) turns it
 * into a jump of the CDF at asOf, i.e. a point mass on whichever lens sample straddles today.
 */
export function stretchedConditionalCdf(mu: number, sigma: number, t0: number, t: number, s: number): number {
  if (!(s > 0) || s === 1) return lognormalConditionalProb(mu, sigma, t0, t - t0);
  if (!(t > 0)) return 0;
  const m = lognormalConditionalQuantile(mu, sigma, t0, 0.5);
  if (!(m > 0)) return lognormalConditionalProb(mu, sigma, t0, t - t0);
  return lognormalConditionalProb(mu, sigma, t0, m * Math.pow(t / m, 1 / s) - t0);
}

/**
 * P(T' <= t0 + horizon) under the stretched law T' = m · (T / m)^s, floored at 0 for a horizon
 * that has already passed — the "will it land within the next `horizon` days" number (p30, p90).
 * Equal to {@link stretchedConditionalCdf} for every horizon > 0; the two differ only on the
 * stretched law's left tail, which lies before asOf and is not part of that question.
 */
export function stretchedConditionalProb(mu: number, sigma: number, t0: number, horizon: number, s: number): number {
  if (!(s > 0) || s === 1) return lognormalConditionalProb(mu, sigma, t0, horizon);
  if (!(horizon > 0)) return 0;
  return stretchedConditionalCdf(mu, sigma, t0, t0 + horizon, s);
}

/** Distinct release dates of a lab, ascending, restricted to tiers. Same-day launches count as one event. */
function eventDates(releases: ModelRelease[], lab: LabId, asOf: ISODate, tiers: Set<ModelTier>): ISODate[] {
  const dates = new Set<ISODate>();
  for (const r of releases) {
    if (r.lab === lab && r.status === 'released' && r.date <= asOf && tiers.has(r.tier ?? 'flagship')) {
      dates.add(r.date);
    }
  }
  return [...dates].sort();
}

/** Consecutive gaps in days, dropping anything under a day. */
function intervalsOf(dates: ISODate[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    const d = daysBetween(dates[i - 1]!, dates[i]!);
    if (d >= 1) out.push(d);
  }
  return out;
}

/**
 * Recency weight of one cadence observation (REDESIGN §4, iteration 2):
 * `w = 0.5^(age / halfLifeDays)`, age = days from the END of the interval to `asOf`.
 * `halfLifeDays = Infinity` (or ≤ 0 half-life degeneracy) gives the unweighted w = 1.
 */
export function recencyWeight(ageDays: number, halfLifeDays: number): number {
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 1;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** Weighted mean (Σw·x / Σw). */
function weightedMean(xs: number[], ws: number[]): number {
  let sw = 0;
  let swx = 0;
  for (let i = 0; i < xs.length; i++) {
    sw += ws[i]!;
    swx += ws[i]! * xs[i]!;
  }
  return sw > 0 ? swx / sw : 0;
}

/** Weighted population variance (Σw·(x − mean)² / Σw). */
function weightedPopulationVariance(xs: number[], ws: number[], meanW: number): number {
  let sw = 0;
  let acc = 0;
  for (let i = 0; i < xs.length; i++) {
    sw += ws[i]!;
    acc += ws[i]! * (xs[i]! - meanW) ** 2;
  }
  return sw > 0 ? acc / sw : 0;
}

/** Kish effective sample size (Σw)² / Σw². */
function kishN(ws: number[]): number {
  let sw = 0;
  let sw2 = 0;
  for (const w of ws) {
    sw += w;
    sw2 += w * w;
  }
  return sw2 > 0 ? (sw * sw) / sw2 : 0;
}

/**
 * Pooled prior over all labs' log-intervals (released flagships by default, date <= asOf).
 * `tiers` restricts which lineup tiers feed the prior (default `['flagship']`, REDESIGN §3).
 * `halfLifeDays` (default 730) recency-weights every interval across labs, exactly like
 * `forecastLab` does (w = 0.5^(age/HL), age from the interval's later release; the Kish
 * `n_eff` is reported as `n`); `Infinity` reproduces the unweighted prior.
 *
 * The drift (REDESIGN §4, iteration 3) is a recency-weighted *ridge* OLS of `y = ln(interval)`
 * on `t` = the interval's END day number over all pooled intervals:
 *
 *   β = Σw(t−t̄)(y−ȳ) / (Σw(t−t̄)² + κ),   κ = (365·2)²  (DRIFT_KAPPA)
 *
 * `μ` stays the weighted mean of `y`; β and the weighted mean end-day `tBar` only shift μ in
 * `forecastLab`. With a single interval the numerator is exactly 0, so the ridge keeps the
 * slope identified (β = 0) instead of any observed gap.
 */
export function cadencePrior(
  releases: ModelRelease[],
  asOf: ISODate,
  tiers: ModelTier[] = ['flagship'],
  halfLifeDays: number = 730,
): CadencePrior {
  const tierSet = new Set<ModelTier>(tiers);
  const labs = new Set<LabId>();
  for (const r of releases) {
    if (r.status === 'released' && r.date <= asOf && tierSet.has(r.tier ?? 'flagship')) labs.add(r.lab);
  }

  const logs: number[] = [];
  const weights: number[] = [];
  const endDays: number[] = [];
  for (const lab of labs) {
    const dates = eventDates(releases, lab, asOf, tierSet);
    const intervals = intervalsOf(dates);
    for (let i = 0; i < intervals.length; i++) {
      logs.push(Math.log(intervals[i]!));
      // age of interval i = days from its end (dates[i + 1]) to asOf
      weights.push(recencyWeight(Math.max(0, daysBetween(dates[i + 1]!, asOf)), halfLifeDays));
      endDays.push(dateToDayNumber(dates[i + 1]!));
    }
  }
  if (logs.length === 0) {
    return { mu: DEFAULT_PRIOR_MU, sigma: DEFAULT_PRIOR_SIGMA, n: 0, driftPerDay: 0, tBar: 0 };
  }
  const mu = weightedMean(logs, weights);
  const tBar = weightedMean(endDays, weights);
  let swtt = 0;
  let swty = 0;
  for (let i = 0; i < logs.length; i++) {
    const dt = endDays[i]! - tBar;
    const dy = logs[i]! - mu;
    swtt += weights[i]! * dt * dt;
    swty += weights[i]! * dt * dy;
  }
  const driftPerDay = swty / (swtt + DRIFT_KAPPA);
  return {
    mu,
    sigma:
      logs.length < 2
        ? DEFAULT_PRIOR_SIGMA
        : Math.sqrt(weightedPopulationVariance(logs, weights, mu)),
    n: kishN(weights),
    driftPerDay,
    tBar,
  };
}

/**
 * Ordinary least squares of θ on day number over the lab's most recent fitted releases.
 * `globalSigma` is the fit-wide residual σ; the trend band is never narrower than it.
 */
function buildTrend(points: ModelIndex[], globalSigma: number): CapabilityTrend | null {
  const n = points.length;
  if (n === 0) return null;
  const xs = points.map((p) => dateToDayNumber(p.date));
  const ys = points.map((p) => p.theta);

  if (n === 1) {
    // No slope information at all: flat trend, band = the index's own residual σ.
    return { slopePerDay: 0, intercept: ys[0]!, residualSigma: globalSigma, slopeSe: 0, n };
  }

  const xbar = mean(xs);
  const ybar = mean(ys);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - xbar;
    sxx += dx * dx;
    sxy += dx * (ys[i]! - ybar);
  }
  if (!(sxx > 0)) {
    // Every release on the same day — a slope is not identified.
    return {
      slopePerDay: 0,
      intercept: ybar,
      residualSigma: Math.max(globalSigma, populationSd(ys)),
      slopeSe: 0,
      n,
    };
  }

  const slopePerDay = sxy / sxx;
  const intercept = ybar - slopePerDay * xbar;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i]! - (intercept + slopePerDay * xs[i]!);
    ss += r * r;
  }
  const ownSigma = Math.sqrt(ss / Math.max(1, n - 2));
  const residualSigma = Math.max(ownSigma, globalSigma);
  const span = Math.abs(xs[n - 1]! - xs[0]!);
  // Two points fit exactly, so their own residual σ is 0 and carries no information:
  // METHODOLOGY §4 uses the global residual σ spread over the span instead.
  const slopeSe = n === 2 ? (span > 0 ? globalSigma / span : 0) : residualSigma / Math.sqrt(sxx);
  return { slopePerDay, intercept, residualSigma, slopeSe, n };
}

/** Default cap on chained predicted releases (REDESIGN §4). */
export const MAX_RELEASES_CAP = 24;

/**
 * Timing-window width of a prediction in days: `p84 − p16` of the conditional log-normal
 * (REDESIGN §4 — the circle drawn on the chart shrinks as this shrinks).
 */
export function windowDaysOf(pred: PredictedRelease): number {
  return Math.max(0, daysBetween(pred.p16Date, pred.p84Date));
}

export function forecastLab(
  lab: LabId,
  releases: ModelRelease[],
  fit: IndexFit,
  prior: CadencePrior,
  opts: ForecastOptions,
): LabForecast {
  const asOf = opts.asOf;
  const priorWeight = opts.priorWeight ?? 2;
  const maxReleases = Math.min(Math.max(1, opts.maxReleases ?? 5), MAX_RELEASES_CAP);
  const trendPoints = Math.max(2, opts.trendPoints ?? 5);
  const tiers = new Set<ModelTier>(opts.tierFilter ?? ['flagship']);

  const tierOfRelease = (r: ModelRelease): ModelTier => r.tier ?? 'flagship';
  const labReleased = releases
    .filter(
      (r) => r.lab === lab && r.status === 'released' && r.date <= asOf && tiers.has(tierOfRelease(r)),
    )
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id.localeCompare(b.id)));

  if (labReleased.length === 0) {
    return {
      lab,
      asOf,
      lastRelease: null,
      intervalsDays: [],
      mu: prior.mu,
      sigma: prior.sigma,
      sigmaScale: opts.sigmaScale ?? 1,
      elapsedDays: 0,
      p30: 0,
      p90: 0,
      next: [],
      trend: null,
    };
  }

  // --- cadence -----------------------------------------------------------------------
  // Recency-weighted cadence (REDESIGN §4, iteration 2): each interval is weighted by
  // w_i = 0.5^(age_i / halfLifeDays), age from the interval's END (its later release) to
  // asOf. The lab's (μ, σ²) shrink toward the prior with the Kish effective sample size
  // n_eff = (Σw)² / Σw² in place of the raw count:
  //   μ_lab = (n_eff·mean_w + w·μ_prior) / (n_eff + w)
  //   σ²_lab = (n_eff·var_w + w·σ²_prior) / (n_eff + w)
  // halfLifeDays = Infinity gives w = 1 for every interval and reproduces the unweighted
  // numbers exactly. On top of the stationary mean, the pooled cadence drift (iteration 3)
  // shifts μ to *asOf*: μ_lab(asOf) = μ_lab + β·(dayNumber(asOf) − t̄_lab), where t̄_lab is
  // the lab's own weighted mean END day number (the pooled prior.tBar when the lab has no
  // intervals of its own). The shift is clamped to ±1.0 log-days (~×e ±) so a wild pooled β
  // can never run away; σ is left untouched. drift = false reproduces iteration 2 exactly.
  const halfLifeDays = opts.halfLifeDays ?? 730;
  const sigmaScale = opts.sigmaScale ?? 1;
  const applyDrift = opts.drift ?? true;
  const dates = eventDates(releases, lab, asOf, tiers);
  const intervalsDays = intervalsOf(dates);
  const logs = intervalsDays.map(Math.log);
  const weights = intervalsDays.map((_, i) =>
    recencyWeight(Math.max(0, daysBetween(dates[i + 1]!, asOf)), halfLifeDays),
  );
  const endDays = intervalsDays.map((_, i) => dateToDayNumber(dates[i + 1]!));
  const meanLog = logs.length > 0 ? weightedMean(logs, weights) : 0;
  // 0 when fewer than two gaps carry weight
  const varLab = weightedPopulationVariance(logs, weights, meanLog);
  const n = kishN(weights);
  const w = Math.max(0, priorWeight);
  const denom = n + w;
  const muShrunk = denom > 0 ? (n * meanLog + w * prior.mu) / denom : prior.mu;
  const sigmaRaw =
    denom > 0 ? Math.sqrt(Math.max(0, (n * varLab + w * prior.sigma * prior.sigma) / denom)) : prior.sigma;
  const tBarLab =
    intervalsDays.length > 0 ? weightedMean(endDays, weights) : prior.tBar;
  const driftShift = applyDrift
    ? clamp(prior.driftPerDay * (dateToDayNumber(asOf) - tBarLab), -1, 1)
    : 0;
  const mu = muShrunk + driftShift;
  // The conformal scale is NOT applied to σ: it stretches the windows about the conditional
  // median (stretchedConditionalQuantile), so the circle's centre never moves with it.
  const sigma = sigmaRaw;

  // --- anchor release ------------------------------------------------------------------
  const lastDate = labReleased[labReleased.length - 1]!.date;
  let lastRel = labReleased[labReleased.length - 1]!;
  let lastIndex = fit.models[lastRel.id]?.index ?? 0;
  for (const r of labReleased) {
    if (r.date !== lastDate) continue;
    const mi = fit.models[r.id];
    if (mi && mi.index > lastIndex) {
      lastRel = r;
      lastIndex = mi.index;
    }
  }
  const elapsedDays = Math.max(0, daysBetween(lastRel.date, asOf));

  const p30 = stretchedConditionalProb(mu, sigma, elapsedDays, 30, sigmaScale);
  const p90 = stretchedConditionalProb(mu, sigma, elapsedDays, 90, sigmaScale);

  // --- capability trend ----------------------------------------------------------------
  const fittedAll: ModelIndex[] = [];
  for (const r of labReleased) {
    const mi = fit.models[r.id];
    if (mi) fittedAll.push(mi);
  }
  // Qualified models only, unless the lab has fewer than two of them (METHODOLOGY §4).
  const fittedQualified = fittedAll.filter((m) => m.qualified);
  const fitted = fittedQualified.length >= 2 ? fittedQualified : fittedAll;
  const trend = buildTrend(fitted.slice(-trendPoints), fit.residualSigma);

  // Labs rarely regress and no model is expected above 99.5: clamp the *central* prediction
  // (the uncertainty band around it is left free). METHODOLOGY §4.
  const thetaCeiling = thetaFromIndex(99.5);
  const thetaFloor = thetaFromIndex(Math.max(0.5, lastIndex - 5));

  const capabilityAt = (date: ISODate) => {
    if (!trend) return { theta: 0, thetaLow: 0, thetaHigh: 0, index: 0, indexLow: 0, indexHigh: 0 };
    const theta = clamp(trend.intercept + trend.slopePerDay * dateToDayNumber(date), thetaFloor, thetaCeiling);
    const dd = Math.max(0, daysBetween(lastRel.date, date));
    // Variance adds in quadrature (REDESIGN §4): σ²_res + (se_b·Δt)².
    const half = Z90 * Math.sqrt(trend.residualSigma ** 2 + (trend.slopeSe * dd) ** 2);
    return {
      theta,
      index: indexFromTheta(theta),
      thetaLow: theta - half,
      thetaHigh: theta + half,
      indexLow: indexFromTheta(theta - half),
      indexHigh: indexFromTheta(theta + half),
    };
  };

  // --- predicted releases ---------------------------------------------------------------
  const next: PredictedRelease[] = [];
  const horizonDays = opts.horizonDays;
  const withinHorizon = (date: ISODate) =>
    horizonDays === undefined || daysBetween(asOf, date) <= horizonDays;

  // An announced model with a future expected_window replaces the statistical k = 1.
  let announced: ModelRelease | undefined;
  for (const r of releases) {
    if (r.lab !== lab || r.status !== 'announced') continue;
    const win = r.expected_window;
    if (!win || win.start <= asOf) continue;
    if (!announced || win.start < announced.expected_window!.start) announced = r;
  }

  let chainAnchor: ISODate = lastRel.date;
  let chainOffset = 0;
  let stopped = false;

  if (announced && announced.expected_window) {
    // An announced window is a fact the lab published, so it is always shown; only the
    // statistical chain that follows it is subject to the horizon.
    const win = announced.expected_window;
    const len = Math.max(0, daysBetween(win.start, win.end));
    const medianDate = addDays(win.start, len / 2);
    const cap = capabilityAt(medianDate);
    next.push({
      k: 1,
      medianDate,
      p05Date: addDays(win.start, -0.15 * len),
      p16Date: win.start,
      p84Date: win.end,
      p95Date: addDays(win.end, 0.15 * len),
      ...cap,
      certainty: certaintyFor(win.start, win.end),
      source: 'announced',
      release_id: announced.id,
    });
    chainAnchor = medianDate;
    chainOffset = 0;
  } else {
    const off = clampOffset(stretchedConditionalQuantile(mu, sigma, elapsedDays, Q_LEVELS.p50, sigmaScale));
    const medianDate = addDays(lastRel.date, off);
    if (withinHorizon(medianDate)) {
      const cap = capabilityAt(medianDate);
      const p16Date = addDays(lastRel.date, clampOffset(stretchedConditionalQuantile(mu, sigma, elapsedDays, Q_LEVELS.p16, sigmaScale)));
      const p84Date = addDays(lastRel.date, clampOffset(stretchedConditionalQuantile(mu, sigma, elapsedDays, Q_LEVELS.p84, sigmaScale)));
      next.push({
        k: 1,
        medianDate,
        p05Date: addDays(lastRel.date, clampOffset(stretchedConditionalQuantile(mu, sigma, elapsedDays, Q_LEVELS.p05, sigmaScale))),
        p16Date,
        p84Date,
        p95Date: addDays(lastRel.date, clampOffset(stretchedConditionalQuantile(mu, sigma, elapsedDays, Q_LEVELS.p95, sigmaScale))),
        ...cap,
        certainty: certaintyFor(p16Date, p84Date),
        source: 'statistical',
      });
    } else {
      stopped = true; // the very next release is already past the horizon
    }
    chainAnchor = lastRel.date;
    chainOffset = off;
  }

  // Chained releases: unconditional median steps from the previous predicted date; the spread of
  // the *sum* of k intervals is approximated by scaling σ with √k in log space (METHODOLOGY §4).
  const medianStep = Math.exp(mu);
  for (let k = 2; k <= maxReleases && !stopped; k++) {
    chainOffset = clampOffset(chainOffset + medianStep);
    const medianDate = addDays(chainAnchor, chainOffset);
    if (!withinHorizon(medianDate)) break;
    // For an unconditional log-normal the stretch about the median is exactly a σ scale.
    const sigmaK = sigma * sigmaScale * Math.sqrt(k);
    const at = (q: number) => addDays(chainAnchor, clampOffset(chainOffset * Math.exp(sigmaK * normalInverseCdf(q))));
    const p16Date = at(Q_LEVELS.p16);
    const p84Date = at(Q_LEVELS.p84);
    const cap = capabilityAt(medianDate);
    next.push({
      k,
      medianDate,
      p05Date: at(Q_LEVELS.p05),
      p16Date,
      p84Date,
      p95Date: at(Q_LEVELS.p95),
      ...cap,
      certainty: certaintyFor(p16Date, p84Date),
      source: 'statistical',
    });
  }

  return {
    lab,
    asOf,
    lastRelease: { release_id: lastRel.id, date: lastRel.date, index: lastIndex },
    intervalsDays,
    mu,
    sigma,
    sigmaScale,
    elapsedDays,
    p30,
    p90,
    next,
    trend,
  };
}

export function forecastAll(labIds: LabId[], releases: ModelRelease[], fit: IndexFit, opts: ForecastOptions): LabForecast[] {
  const tiers = opts.tierFilter ?? ['flagship'];
  const prior = cadencePrior(releases, opts.asOf, tiers, opts.halfLifeDays ?? 730);
  return labIds.map((lab) => forecastLab(lab, releases, fit, prior, opts));
}

/**
 * Sample the lab's extrapolated capability band from `asOf` to `toDate` every `stepDays`.
 * The central θ keeps the forecast ceiling/floor clamps; the band is un-clamped (the index
 * conversion saturates by itself) and widens in quadrature (REDESIGN §4):
 * `half = Z90 · √(σ²_res + (se_b·Δt)²)`.
 */
export function capabilityFan(
  forecast: LabForecast,
  opts: { asOf: ISODate; toDate: ISODate; stepDays?: number },
): FanPoint[] {
  const trend = forecast.trend;
  const last = forecast.lastRelease;
  if (!trend || !last) return [];

  const step = Math.max(1, Math.round(opts.stepDays ?? 7));
  const startDay = dateToDayNumber(opts.asOf);
  const endDay = dateToDayNumber(opts.toDate);
  if (endDay < startDay) return [];

  const thetaCeiling = thetaFromIndex(99.5);
  const thetaFloor = thetaFromIndex(Math.max(0.5, last.index - 5));

  const out: FanPoint[] = [];
  for (let d = startDay; d <= endDay; d += step) {
    const date = dayNumberToDate(d);
    const theta = clamp(trend.intercept + trend.slopePerDay * d, thetaFloor, thetaCeiling);
    const dd = Math.max(0, daysBetween(last.date, date));
    const half = Z90 * Math.sqrt(trend.residualSigma ** 2 + (trend.slopeSe * dd) ** 2);
    out.push({
      date,
      low: indexFromTheta(theta - half),
      mid: indexFromTheta(theta),
      high: indexFromTheta(theta + half),
      theta,
      thetaLow: theta - half,
      thetaHigh: theta + half,
    });
  }
  return out;
}

/* ------------------------------------------------------------- release lens */

/** One sample of the release-date density (REDESIGN §12.4). */
export interface DensitySample {
  /** Calendar day of the sample (rounded from `day`). */
  date: ISODate;
  /**
   * Fractional day number of the sample (same origin as `timeline.dateToDayNumber`), so a lens
   * over a window of a few days can still be drawn smoothly — `date` alone would repeat.
   */
  day: number;
  /** Density: mode = 1 in `releaseDensity`; probability per day in `releaseDensityRaw`. */
  p: number;
}

/** Fewest samples a lens ever gets, so even a days-wide window is a shape and not a line. */
export const MIN_DENSITY_SAMPLES = 8;

/** Quantile levels bounding the sampled window of the lens (REDESIGN §12.4: 2nd–98th). */
const LENS_Q_LOW = 0.02;
const LENS_Q_HIGH = 0.98;

/**
 * The unnormalised release-date density of one prediction, in probability **per day**, sampled
 * on `n` (≥ {@link MIN_DENSITY_SAMPLES}) equally spaced days between the prediction's 2nd and
 * 98th percentile dates. Integrating `p` over the window (Riemann sum × step) therefore gives
 * ≈ 0.96 for a statistical prediction. `releaseDensity` is this divided by its maximum.
 *
 * The law is the one `forecastLab` used to place the prediction, re-derived from the same
 * quantities (REDESIGN §12.4):
 *
 * - k = 1, statistical: the finite-difference derivative of the stretched conditional CDF
 *   `stretchedConditionalCdf(f.mu, f.sigma, f.elapsedDays, T, f.sigmaScale)` with `T` = days
 *   since `f.lastRelease.date`, differenced over one day — so `p` is literally P(the launch
 *   lands on that day). With `sigmaScale > 1` the stretch reaches back before `asOf`, exactly
 *   as the p05/p16 dates `forecastLab` publishes do, so the leading samples of the window carry
 *   real mass; taking the derivative of `stretchedConditionalProb` instead would floor that
 *   tail at `asOf` and pile it onto one sample as a needle.
 * - k ≥ 2: the log-normal pdf of the offset `X` from the chain anchor with median
 *   `m = daysBetween(anchor, pred.medianDate)` and log-σ `f.sigma · f.sigmaScale · √k` — exactly
 *   the law whose quantiles `forecastLab` writes (`anchor + m·exp(σ_k·z_q)`). The anchor is not
 *   stored on `PredictedRelease`, so it is recovered the way the chain was built: the announced
 *   k = 1 median when `f.next[0].source === 'announced'`, else the last release date.
 * - k = 1, `announced`: the lab published a window, not a law. The lens is a trapezoid — flat
 *   over `[p16, p84]` (the window itself) falling linearly to 0 at `p05` / `p95`, and sampled
 *   over `[p05, p95]` because there are no 2nd/98th percentiles to speak of.
 *
 * Degenerate cases (an overdue lab whose conditional law has collapsed to "tomorrow", a σ of
 * 0) give a window under a day wide; it is padded to one day and the density made flat, so the
 * caller always gets a drawable shape. Empty only when the lab has no release at all.
 */
export function releaseDensityRaw(
  f: LabForecast,
  pred: PredictedRelease,
  n: number = 48,
): { samples: DensitySample[]; stepDays: number } {
  const last = f.lastRelease;
  if (!last) return { samples: [], stepDays: 0 };
  const count = Math.max(MIN_DENSITY_SAMPLES, Math.round(n));

  let lowDay: number;
  let highDay: number;
  let pdf: (day: number) => number;

  if (pred.source === 'announced') {
    const d05 = dateToDayNumber(pred.p05Date);
    const d16 = dateToDayNumber(pred.p16Date);
    const d84 = dateToDayNumber(pred.p84Date);
    const d95 = dateToDayNumber(pred.p95Date);
    lowDay = d05;
    highDay = d95;
    // Trapezoid with unit plateau, then scaled to integrate to 1 over [p05, p95].
    const area = (d84 - d16) + 0.5 * (d16 - d05) + 0.5 * (d95 - d84);
    const scale = area > 0 ? 1 / area : 1;
    pdf = (day) => {
      if (day <= d05 || day >= d95) return 0;
      if (day < d16) return scale * ((day - d05) / Math.max(1e-9, d16 - d05));
      if (day > d84) return scale * ((d95 - day) / Math.max(1e-9, d95 - d84));
      return scale;
    };
  } else if (pred.k <= 1) {
    const anchorDay = dateToDayNumber(last.date);
    const t0 = f.elapsedDays;
    const s = f.sigmaScale;
    // stretchedConditionalCdf, not stretchedConditionalProb: the latter is floored at t0, which
    // would gather everything the stretch pushed before asOf onto the single sample straddling
    // today (a needle where the lens should have a shoulder). See its doc comment.
    const cdf = (T: number) => stretchedConditionalCdf(f.mu, f.sigma, t0, T, s);
    lowDay = anchorDay + clampOffset(stretchedConditionalQuantile(f.mu, f.sigma, t0, LENS_Q_LOW, s));
    highDay = anchorDay + clampOffset(stretchedConditionalQuantile(f.mu, f.sigma, t0, LENS_Q_HIGH, s));
    // Central difference over one day: P(T ∈ [T − ½, T + ½]).
    pdf = (day) => Math.max(0, cdf(day - anchorDay + 0.5) - cdf(day - anchorDay - 0.5));
  } else {
    const first = f.next[0];
    const anchorDate = first !== undefined && first.source === 'announced' ? first.medianDate : last.date;
    const anchorDay = dateToDayNumber(anchorDate);
    const m = Math.max(1, daysBetween(anchorDate, pred.medianDate));
    const sigmaK = f.sigma * f.sigmaScale * Math.sqrt(pred.k);
    lowDay = anchorDay + clampOffset(m * Math.exp(sigmaK * normalInverseCdf(LENS_Q_LOW)));
    highDay = anchorDay + clampOffset(m * Math.exp(sigmaK * normalInverseCdf(LENS_Q_HIGH)));
    const lnM = Math.log(m);
    pdf = (day) => {
      const x = day - anchorDay;
      if (!(x > 0) || !(sigmaK > 0)) return 0;
      return normalPdf((Math.log(x) - lnM) / sigmaK) / (x * sigmaK);
    };
  }

  // A window under a day wide cannot be sampled meaningfully: pad it and draw it flat.
  let flat = false;
  if (!(highDay - lowDay >= 1)) {
    const centre = (lowDay + highDay) / 2;
    lowDay = centre - 0.5;
    highDay = centre + 0.5;
    flat = true;
  }

  const stepDays = (highDay - lowDay) / (count - 1);
  const samples: DensitySample[] = [];
  let anyMass = false;
  for (let i = 0; i < count; i++) {
    const day = lowDay + i * stepDays;
    const p = flat ? 1 : pdf(day);
    if (p > 0 && Number.isFinite(p)) anyMass = true;
    samples.push({ date: dayNumberToDate(day), day, p: Number.isFinite(p) ? Math.max(0, p) : 0 });
  }
  // A numerically dead law (all zeros) is drawn flat rather than not at all.
  if (!anyMass) for (const smp of samples) smp.p = 1;
  return { samples, stepDays };
}

/**
 * Release-date density of one prediction, normalised so its mode is 1 (REDESIGN §12.4) — the
 * shape of the "release lens": `n` samples between the 2nd and 98th percentile dates, `p ≥ 0`
 * everywhere, at least {@link MIN_DENSITY_SAMPLES} samples. See {@link releaseDensityRaw} for
 * the law behind each `k` and the unnormalised probability-per-day form.
 */
export function releaseDensity(f: LabForecast, pred: PredictedRelease, n: number = 48): DensitySample[] {
  const { samples } = releaseDensityRaw(f, pred, n);
  let max = 0;
  for (const s of samples) if (s.p > max) max = s.p;
  if (!(max > 0)) return samples;
  return samples.map((s) => ({ ...s, p: s.p / max }));
}
