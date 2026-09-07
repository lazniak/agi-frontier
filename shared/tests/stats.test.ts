import { describe, expect, test } from 'bun:test';
import {
  clamp,
  lognormalCdf,
  lognormalQuantile,
  mean,
  normalCdf,
  normalInverseCdf,
  normalPdf,
  populationSd,
  populationVariance,
} from '../src/stats';

describe('normalCdf', () => {
  test('known values to 1e-12', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 15);
    expect(normalCdf(1)).toBeCloseTo(0.8413447460685429, 12);
    expect(normalCdf(-1)).toBeCloseTo(0.15865525393145705, 12);
    expect(normalCdf(1.959963984540054)).toBeCloseTo(0.975, 12);
    expect(normalCdf(-2.5758293035489004)).toBeCloseTo(0.005, 12);
    // The published Z90 = 1.2816 rounds Φ⁻¹(0.9) = 1.28155…, i.e. it is the 90.0008th percentile.
    expect(normalCdf(1.2816)).toBeCloseTo(0.9000085, 7);
  });

  test('tails and infinities', () => {
    expect(normalCdf(Number.POSITIVE_INFINITY)).toBe(1);
    expect(normalCdf(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(normalCdf(-40)).toBe(0);
    expect(normalCdf(-8)).toBeGreaterThan(0);
    expect(normalCdf(-8)).toBeLessThan(1e-14);
  });

  test('symmetry Φ(-x) = 1 - Φ(x)', () => {
    for (let x = 0; x <= 8; x += 0.25) {
      expect(Math.abs(normalCdf(-x) - (1 - normalCdf(x)))).toBeLessThan(1e-15);
    }
  });

  test('monotone increasing', () => {
    let prev = -1;
    for (let x = -6; x <= 6; x += 0.05) {
      const v = normalCdf(x);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('normalInverseCdf', () => {
  test('round-trips Φ to better than 1e-8 across the range', () => {
    let worst = 0;
    for (let p = 1e-6; p < 1; p += 0.0005) {
      const x = normalInverseCdf(p);
      worst = Math.max(worst, Math.abs(normalCdf(x) - p));
    }
    expect(worst).toBeLessThan(1e-8);
  });

  test('inverse round-trip in x-space', () => {
    let worst = 0;
    for (let x = -6; x <= 6; x += 0.05) {
      worst = Math.max(worst, Math.abs(normalInverseCdf(normalCdf(x)) - x));
    }
    expect(worst).toBeLessThan(1e-8);
  });

  test('reference quantiles', () => {
    expect(normalInverseCdf(0.5)).toBeCloseTo(0, 12);
    expect(normalInverseCdf(0.975)).toBeCloseTo(1.959963984540054, 9);
    expect(normalInverseCdf(0.9)).toBeCloseTo(1.2815515655446004, 9);
    expect(normalInverseCdf(0.16)).toBeCloseTo(-0.994457883209753, 9);
    expect(normalInverseCdf(0.05)).toBeCloseTo(-1.6448536269514722, 9);
  });

  test('open ends', () => {
    expect(normalInverseCdf(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(normalInverseCdf(1)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('log-normal helpers', () => {
  test('cdf and quantile are inverses', () => {
    const mu = Math.log(150);
    const sigma = 0.55;
    for (const q of [0.01, 0.05, 0.16, 0.5, 0.84, 0.95, 0.99]) {
      const t = lognormalQuantile(mu, sigma, q);
      expect(lognormalCdf(mu, sigma, t)).toBeCloseTo(q, 9);
    }
  });

  test('median is exp(mu)', () => {
    expect(lognormalQuantile(Math.log(200), 0.4, 0.5)).toBeCloseTo(200, 9);
  });

  test('degenerate sigma behaves as a point mass', () => {
    expect(lognormalQuantile(Math.log(90), 0, 0.9)).toBe(90);
    expect(lognormalCdf(Math.log(90), 0, 89)).toBe(0);
    expect(lognormalCdf(Math.log(90), 0, 91)).toBe(1);
  });

  test('cdf is 0 at or below 0', () => {
    expect(lognormalCdf(0, 1, 0)).toBe(0);
    expect(lognormalCdf(0, 1, -5)).toBe(0);
  });
});

describe('moments and clamp', () => {
  test('mean / population variance / sd', () => {
    const xs = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(mean(xs)).toBe(5);
    expect(populationVariance(xs)).toBe(4);
    expect(populationSd(xs)).toBe(2);
    expect(populationVariance([3])).toBe(0);
    expect(mean([])).toBe(0);
  });

  test('normalPdf integrates to ~1 over [-8, 8]', () => {
    const h = 0.001;
    let s = 0;
    for (let x = -8; x <= 8; x += h) s += normalPdf(x) * h;
    expect(s).toBeCloseTo(1, 5);
  });

  test('clamp', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});
