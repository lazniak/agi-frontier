import { describe, expect, test } from 'bun:test';
import {
  RATING_BASE,
  RATING_PER_LOGIT,
  ratingFromIndex,
  ratingFromTheta,
  scoreToProbability,
  thetaFromRating,
} from '../src/rating';
import { DEFAULT_CLIP, thetaFromIndex } from '../src/frontier-index';
import { benchmark } from './test-helpers';

describe('rating conversions', () => {
  test('θ ↔ rating round-trip and base constant', () => {
    expect(RATING_PER_LOGIT).toBeCloseTo(173.7178, 3);
    for (const theta of [-3, -0.5, 0, 1.2, 5]) {
      expect(thetaFromRating(ratingFromTheta(theta))).toBeCloseTo(theta, 10);
    }
    expect(ratingFromTheta(0)).toBe(RATING_BASE);
  });

  test('400 rating points = one order of magnitude of odds', () => {
    expect(ratingFromTheta(Math.LN10) - RATING_BASE).toBeCloseTo(400, 6);
    expect(ratingFromTheta(-Math.LN10) - RATING_BASE).toBeCloseTo(-400, 6);
  });

  test('ratingFromIndex agrees with the θ route', () => {
    for (const idx of [1, 20, 50, 80, 99]) {
      expect(ratingFromIndex(idx)).toBeCloseTo(ratingFromTheta(thetaFromIndex(idx)), 10);
    }
  });
});

describe('scoreToProbability', () => {
  test('percent unit: clip at 0.5/99.5 then divide by 100', () => {
    const b = benchmark('p');
    expect(scoreToProbability(b, 50)).toBe(0.5);
    expect(scoreToProbability(b, 80.9)).toBeCloseTo(0.809, 12);
    expect(scoreToProbability(b, 100)).toBe(0.995);
    expect(scoreToProbability(b, 0)).toBe(0.005);
    expect(scoreToProbability(b, -5, [1, 99])).toBe(0.01);
  });

  test('elo unit: reference ⇒ 0.5, +400 ⇒ 10/11', () => {
    const arena = { ...benchmark('arena'), unit: 'elo' as const, min: 0, max: 4000, elo_reference: 1200 };
    expect(scoreToProbability(arena, 1200)).toBe(0.5);
    expect(scoreToProbability(arena, 1600)).toBeCloseTo(10 / 11, 12);
    expect(scoreToProbability(arena, 800)).toBeCloseTo(1 / 11, 12);
  });

  test('elo unit: clipped to [0.005, 0.995]', () => {
    const arena = { ...benchmark('arena'), unit: 'elo' as const, elo_reference: 1200 };
    expect(scoreToProbability(arena, 1200 + 1200)).toBe(0.995); // 1200 Elo above the reference
    expect(scoreToProbability(arena, 1200 - 1200)).toBe(0.005);
  });

  test('elo unit without elo_reference throws', () => {
    const broken = { ...benchmark('broken'), unit: 'elo' as const };
    expect(() => scoreToProbability(broken, 1200)).toThrow(/elo_reference/);
  });
});
