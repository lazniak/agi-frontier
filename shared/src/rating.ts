/**
 * Frontier Rating — the unbounded primary score of the site (REDESIGN §1.2).
 *
 *   R = RATING_BASE + RATING_PER_LOGIT · θ
 *
 * 400 rating points = one order of magnitude in the odds of solving an average basket item;
 * 1000 = a model that would score 50 % on an item of average difficulty in the anchor basket.
 * Pure functions, no I/O.
 */
import type { Benchmark } from './types';
import { DEFAULT_CLIP, indexFromTheta, thetaFromIndex } from './frontier-index';

/** Rating of θ = 0 (50 % on an average anchor item). */
export const RATING_BASE = 1000;

/** Rating points per logit: 400 / ln 10 ≈ 173.7178. */
export const RATING_PER_LOGIT = 400 / Math.LN10;

/** R = 1000 + (400 / ln 10)·θ (REDESIGN §1.2). */
export function ratingFromTheta(theta: number): number {
  return RATING_BASE + RATING_PER_LOGIT * theta;
}

/** Inverse of `ratingFromTheta`. */
export function thetaFromRating(rating: number): number {
  return (rating - RATING_BASE) / RATING_PER_LOGIT;
}

/** The same rating, read off the bounded Frontier Index (100·σ(θ)). */
export function ratingFromIndex(index: number): number {
  return ratingFromTheta(thetaFromIndex(index));
}

/**
 * Probability that a model solving the benchmark with probability `p` also solves an "average"
 * basket item — the Rasch observation y = logit(p) (REDESIGN §1.1).
 *
 * - unit `%`: `clipPercent(value, clip) / 100` — same clip as before the redesign ([0.5, 99.5]).
 * - unit `elo`: `p = 1 / (1 + 10^((elo_reference − value) / 400))`, then clipped to
 *   `[clip[0]/100, clip[1]/100]`. A 400-Elo gap is 10× the odds. Missing `elo_reference` throws.
 */
export function scoreToProbability(b: Benchmark, value: number, clip: [number, number] = DEFAULT_CLIP): number {
  if (b.unit === 'elo') {
    if (b.elo_reference === undefined) {
      throw new Error(`Benchmark ${b.id} has unit 'elo' but no elo_reference (REDESIGN §1.1)`);
    }
    const lo = Math.min(clip[0], clip[1]) / 100;
    const hi = Math.max(clip[0], clip[1]) / 100;
    const p = 1 / (1 + 10 ** ((b.elo_reference - value) / 400));
    return p < lo ? lo : p > hi ? hi : p;
  }
  const lo = Math.min(clip[0], clip[1]);
  const hi = Math.max(clip[0], clip[1]);
  const v = value < lo ? lo : value > hi ? hi : value;
  return v / 100;
}
