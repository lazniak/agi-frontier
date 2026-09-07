/**
 * Release-date forecast per lab + capability fan. See docs/METHODOLOGY.md §4.
 * Pure functions, no I/O. API frozen; implementation: shared-math task.
 */
import type { ISODate, LabId, ModelRelease } from './types';
import type { IndexFit, ModelIndex } from './frontier-index';
import { indexFromTheta, thetaFromIndex } from './frontier-index';
import { addDays, dateToDayNumber, dayNumberToDate, daysBetween } from './timeline';
import {
  clamp,
  lognormalCdf,
  lognormalQuantile,
  mean,
  normalInverseCdf,
  populationSd,
  populationVariance,
} from './stats';

export interface ForecastOptions {
  /** Forecast "as of" this date; only releases with date <= asOf are used. */
  asOf: ISODate;
  /** Pseudo-observations pulling a lab's (μ, σ) toward the cross-lab prior (default 2). */
  priorWeight?: number;
  /** Horizon in days for chained predictions (default 1095 = 3 years). */
  horizonDays?: number;
  /** Max chained predicted releases per lab (default 5). */
  maxReleases?: number;
  /** Number of most recent releases used for the capability trend (default 5, min 2). */
  trendPoints?: number;
}

/** Log-normal parameters of inter-release intervals in days. */
export interface CadencePrior {
  mu: number;
  sigma: number;
  /** Total intervals pooled. */
  n: number;
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
  /** Shrunk log-normal parameters. */
  mu: number;
  sigma: number;
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
}

/** z for the 90th percentile — the constant published in METHODOLOGY §4. */
const Z90 = 1.2816;
/** Below this remaining probability mass the lab is "overdue" and the conditional law degenerates. */
const OVERDUE_EPS = 1e-9;
/** Offsets are clamped to a century so a pathological σ can never produce an invalid Date. */
const MAX_OFFSET_DAYS = 36_500;
/** Used only when there is not a single inter-release interval anywhere in the data. */
export const DEFAULT_PRIOR_MU = Math.log(120);
/** Fallback σ of log-intervals when fewer than 2 intervals exist (METHODOLOGY §4). */
export const DEFAULT_PRIOR_SIGMA = 0.6;

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

/** Distinct release dates of a lab, ascending. Same-day launches count as one event. */
function eventDates(releases: ModelRelease[], lab: LabId, asOf: ISODate): ISODate[] {
  const dates = new Set<ISODate>();
  for (const r of releases) {
    if (r.lab === lab && r.status === 'released' && r.date <= asOf) dates.add(r.date);
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

/** Pooled prior over all labs' log-intervals (released flagships, date <= asOf). */
export function cadencePrior(releases: ModelRelease[], asOf: ISODate): CadencePrior {
  const labs = new Set<LabId>();
  for (const r of releases) if (r.status === 'released' && r.date <= asOf) labs.add(r.lab);

  const logs: number[] = [];
  for (const lab of labs) {
    for (const d of intervalsOf(eventDates(releases, lab, asOf))) logs.push(Math.log(d));
  }
  if (logs.length === 0) return { mu: DEFAULT_PRIOR_MU, sigma: DEFAULT_PRIOR_SIGMA, n: 0 };
  return {
    mu: mean(logs),
    sigma: logs.length < 2 ? DEFAULT_PRIOR_SIGMA : populationSd(logs),
    n: logs.length,
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

export function forecastLab(
  lab: LabId,
  releases: ModelRelease[],
  fit: IndexFit,
  prior: CadencePrior,
  opts: ForecastOptions,
): LabForecast {
  const asOf = opts.asOf;
  const priorWeight = opts.priorWeight ?? 2;
  const horizonDays = opts.horizonDays ?? 1095;
  const maxReleases = opts.maxReleases ?? 5;
  const trendPoints = Math.max(2, opts.trendPoints ?? 5);

  const labReleased = releases
    .filter((r) => r.lab === lab && r.status === 'released' && r.date <= asOf)
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
      elapsedDays: 0,
      p30: 0,
      p90: 0,
      next: [],
      trend: null,
    };
  }

  // --- cadence -----------------------------------------------------------------------
  const intervalsDays = intervalsOf(eventDates(releases, lab, asOf));
  const n = intervalsDays.length;
  const logs = intervalsDays.map(Math.log);
  const meanLog = n > 0 ? mean(logs) : 0;
  const varLab = populationVariance(logs); // 0 when n < 2
  const w = Math.max(0, priorWeight);
  const denom = n + w;
  const mu = denom > 0 ? (n * meanLog + w * prior.mu) / denom : prior.mu;
  const sigma =
    denom > 0 ? Math.sqrt(Math.max(0, (n * varLab + w * prior.sigma * prior.sigma) / denom)) : prior.sigma;

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

  const p30 = lognormalConditionalProb(mu, sigma, elapsedDays, 30);
  const p90 = lognormalConditionalProb(mu, sigma, elapsedDays, 90);

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
    if (!trend) return { theta: 0, index: 0, indexLow: 0, indexHigh: 0 };
    const theta = clamp(trend.intercept + trend.slopePerDay * dateToDayNumber(date), thetaFloor, thetaCeiling);
    const dd = Math.max(0, daysBetween(lastRel.date, date));
    const half = Z90 * (trend.residualSigma + trend.slopeSe * dd);
    return {
      theta,
      index: indexFromTheta(theta),
      indexLow: indexFromTheta(theta - half),
      indexHigh: indexFromTheta(theta + half),
    };
  };

  // --- predicted releases ---------------------------------------------------------------
  const next: PredictedRelease[] = [];
  const withinHorizon = (date: ISODate) => daysBetween(asOf, date) <= horizonDays;

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
    const off = clampOffset(lognormalConditionalQuantile(mu, sigma, elapsedDays, Q_LEVELS.p50));
    const medianDate = addDays(lastRel.date, off);
    if (withinHorizon(medianDate)) {
      const cap = capabilityAt(medianDate);
      const p16Date = addDays(lastRel.date, clampOffset(lognormalConditionalQuantile(mu, sigma, elapsedDays, Q_LEVELS.p16)));
      const p84Date = addDays(lastRel.date, clampOffset(lognormalConditionalQuantile(mu, sigma, elapsedDays, Q_LEVELS.p84)));
      next.push({
        k: 1,
        medianDate,
        p05Date: addDays(lastRel.date, clampOffset(lognormalConditionalQuantile(mu, sigma, elapsedDays, Q_LEVELS.p05))),
        p16Date,
        p84Date,
        p95Date: addDays(lastRel.date, clampOffset(lognormalConditionalQuantile(mu, sigma, elapsedDays, Q_LEVELS.p95))),
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
    const sigmaK = sigma * Math.sqrt(k);
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
    elapsedDays,
    p30,
    p90,
    next,
    trend,
  };
}

export function forecastAll(labIds: LabId[], releases: ModelRelease[], fit: IndexFit, opts: ForecastOptions): LabForecast[] {
  const prior = cadencePrior(releases, opts.asOf);
  return labIds.map((lab) => forecastLab(lab, releases, fit, prior, opts));
}

/**
 * Sample the lab's extrapolated capability band from `asOf` to `toDate` every `stepDays`.
 * Band widens with distance: ±(residualSigma + slopeSe·Δt) mapped through σ.
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
    const half = Z90 * (trend.residualSigma + trend.slopeSe * dd);
    out.push({
      date,
      low: indexFromTheta(theta - half),
      mid: indexFromTheta(theta),
      high: indexFromTheta(theta + half),
    });
  }
  return out;
}
