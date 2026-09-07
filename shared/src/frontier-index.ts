/**
 * Frontier Index — Rasch-style ability/difficulty fit over official benchmark scores.
 * See docs/METHODOLOGY.md §3. Pure functions, no I/O.
 *
 * API is frozen (web and worker code against it). Implementation: shared-math task.
 */
import type { Benchmark, ISODate, LabId, ModelRelease, Score } from './types';

export interface IndexFitOptions {
  /** Ridge penalty λ applied to θ and δ (default 0.05). */
  ridge?: number;
  /** Max alternating-least-squares iterations (default 200). */
  maxIter?: number;
  /** Convergence tolerance on max |Δθ|,|Δδ| (default 1e-6). */
  tolerance?: number;
  /** Percent clip before logit (default [0.5, 99.5]). */
  clip?: [number, number];
  /** Fit only `released` models with `date <= asOf`. Default: all released. */
  asOf?: ISODate;
}

export interface UsedScore {
  benchmark: string;
  value: number;
  /** Model-predicted percent for this benchmark: 100·σ(θ − δ). */
  predicted: number;
  /** Logit-space residual. */
  residual: number;
  reported_by: 'official' | 'maintainer';
  config?: string;
}

export interface ModelIndex {
  release_id: string;
  lab: LabId;
  date: ISODate;
  /** Ability on the logit scale. */
  theta: number;
  /** Frontier Index = 100·σ(θ). */
  index: number;
  /** Standard error of θ (residualSigma / √n). */
  se: number;
  /** 100·σ(θ ∓ se). */
  indexLow: number;
  indexHigh: number;
  /** Number of index benchmarks used. */
  n: number;
  /** n / number of index benchmarks (0–1). */
  coverage: number;
  used: UsedScore[];
}

export interface IndexFit {
  asOf: ISODate | null;
  /** Benchmark ids with in_index = true, in basket order. */
  benchmarksInIndex: string[];
  /** δ_b per benchmark id; mean over index benchmarks = 0. */
  difficulties: Record<string, number>;
  models: Record<string, ModelIndex>;
  /** Pooled logit-space residual σ. */
  residualSigma: number;
  iterations: number;
  converged: boolean;
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
export function logit(p: number): number {
  return Math.log(p / (1 - p));
}
/** 100·σ(θ). */
export function indexFromTheta(theta: number): number {
  return 100 * sigmoid(theta);
}
export function thetaFromIndex(index: number): number {
  return logit(Math.min(99.5, Math.max(0.5, index)) / 100);
}

/**
 * Pick at most one score per index benchmark for a release:
 * official beats maintainer; a config containing a keyword of `preferred_config` beats one that does not;
 * otherwise the first listed. Deterministic. Implemented by the shared-math task.
 */
export function selectIndexScores(release: ModelRelease, benchmarks: Benchmark[]): Score[] {
  void release; void benchmarks;
  throw new Error('not implemented: selectIndexScores');
}

/** Fit θ (per release) and δ (per benchmark). Implemented by the shared-math task. */
export function fitFrontierIndex(
  releases: ModelRelease[],
  benchmarks: Benchmark[],
  opts: IndexFitOptions = {},
): IndexFit {
  void releases; void benchmarks; void opts;
  throw new Error('not implemented: fitFrontierIndex');
}

export interface FrontierPoint {
  date: ISODate;
  index: number;
  release_id: string;
  lab: LabId;
}

/**
 * Running maximum of the index over released models, sorted by date.
 * Returns only the points where the maximum increases (step function knots).
 * Implemented by the shared-math task.
 */
export function frontierLine(fit: IndexFit): FrontierPoint[] {
  void fit;
  throw new Error('not implemented: frontierLine');
}

/**
 * Least-squares slope of the frontier step function sampled daily over the trailing `windowDays`
 * ending at `asOf`, expressed in index points per 30 days. null if fewer than 2 knots in window.
 * Implemented by the shared-math task.
 */
export function frontierVelocity(line: FrontierPoint[], asOf: ISODate, windowDays = 365): number | null {
  void line; void asOf; void windowDays;
  throw new Error('not implemented: frontierVelocity');
}
