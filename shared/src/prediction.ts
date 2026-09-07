/**
 * Release-date forecast per lab + capability fan. See docs/METHODOLOGY.md §4.
 * Pure functions, no I/O. API frozen; implementation: shared-math task.
 */
import type { ISODate, LabId, ModelRelease } from './types';
import type { IndexFit } from './frontier-index';

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
  /** P(next release within 30 / 90 days | none so far). 0 when fewer than 2 releases. */
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

/** Conditional quantile of a log-normal T given T > t0 (all in days). q in (0,1). */
export function lognormalConditionalQuantile(mu: number, sigma: number, t0: number, q: number): number {
  void mu; void sigma; void t0; void q;
  throw new Error('not implemented: lognormalConditionalQuantile');
}

/** P(T <= t0 + horizon | T > t0) for a log-normal T. */
export function lognormalConditionalProb(mu: number, sigma: number, t0: number, horizon: number): number {
  void mu; void sigma; void t0; void horizon;
  throw new Error('not implemented: lognormalConditionalProb');
}

/** Pooled prior over all labs' log-intervals (released flagships, date <= asOf). */
export function cadencePrior(releases: ModelRelease[], asOf: ISODate): CadencePrior {
  void releases; void asOf;
  throw new Error('not implemented: cadencePrior');
}

export function forecastLab(
  lab: LabId,
  releases: ModelRelease[],
  fit: IndexFit,
  prior: CadencePrior,
  opts: ForecastOptions,
): LabForecast {
  void lab; void releases; void fit; void prior; void opts;
  throw new Error('not implemented: forecastLab');
}

export function forecastAll(labIds: LabId[], releases: ModelRelease[], fit: IndexFit, opts: ForecastOptions): LabForecast[] {
  void labIds; void releases; void fit; void opts;
  throw new Error('not implemented: forecastAll');
}

/**
 * Sample the lab's extrapolated capability band from `asOf` to `toDate` every `stepDays`.
 * Band widens with distance: ±(residualSigma + slopeSe·Δt) mapped through σ.
 */
export function capabilityFan(
  forecast: LabForecast,
  opts: { asOf: ISODate; toDate: ISODate; stepDays?: number },
): FanPoint[] {
  void forecast; void opts;
  throw new Error('not implemented: capabilityFan');
}
