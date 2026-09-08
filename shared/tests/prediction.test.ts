import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PRIOR_MU,
  DEFAULT_PRIOR_SIGMA,
  MIN_DENSITY_SAMPLES,
  cadencePrior,
  capabilityFan,
  forecastAll,
  forecastLab,
  lognormalConditionalProb,
  lognormalConditionalQuantile,
  releaseDensity,
  releaseDensityRaw,
  stretchedConditionalCdf,
  stretchedConditionalProb,
  stretchedConditionalQuantile,
} from '../src/prediction';
import { fitFrontierIndex, logit } from '../src/frontier-index';
import { addDays, dateToDayNumber, daysBetween } from '../src/timeline';
import { benchmark, release, score } from './test-helpers';
import { clamp, lognormalQuantile, mean, populationSd } from '../src/stats';
import type { LabId, ModelRelease } from '../src/types';

const BMS = [benchmark('a'), benchmark('b')];
const ASOF = '2025-01-01';

/** openai: 4 releases 100 days apart; anthropic: 3 releases 150 days apart; google: a single one. */
function fixture(extra: ModelRelease[] = []): ModelRelease[] {
  const out: ModelRelease[] = [];
  for (let i = 0; i < 4; i++) {
    out.push(
      release(`openai-m${i}`, 'openai', addDays('2024-01-01', i * 100), [
        score('a', 45 + 7 * i),
        score('b', 38 + 7 * i),
      ]),
    );
  }
  for (let i = 0; i < 3; i++) {
    out.push(
      release(`anthropic-m${i}`, 'anthropic', addDays('2024-02-01', i * 150), [
        score('a', 50 + 6 * i),
        score('b', 41 + 6 * i),
      ]),
    );
  }
  out.push(release('google-m0', 'google', '2024-03-01', [score('a', 55), score('b', 44)]));
  return [...out, ...extra];
}

function fitOf(releases: ModelRelease[]) {
  return fitFrontierIndex(releases, BMS, { asOf: ASOF });
}

describe('lognormalConditionalQuantile / Prob', () => {
  const mu = Math.log(120);
  const sigma = 0.5;

  test('t0 <= 0 reduces to the unconditional quantile', () => {
    for (const q of [0.05, 0.16, 0.5, 0.84, 0.95]) {
      expect(lognormalConditionalQuantile(mu, sigma, 0, q)).toBeCloseTo(lognormalQuantile(mu, sigma, q), 9);
      expect(lognormalConditionalQuantile(mu, sigma, -10, q)).toBeCloseTo(lognormalQuantile(mu, sigma, q), 9);
    }
    expect(lognormalConditionalQuantile(mu, sigma, 0, 0.5)).toBeCloseTo(120, 9);
  });

  test('monotone in q and always beyond t0', () => {
    for (const t0 of [0, 30, 120, 400]) {
      let prev = -Infinity;
      for (const q of [0.05, 0.16, 0.5, 0.84, 0.95]) {
        const v = lognormalConditionalQuantile(mu, sigma, t0, q);
        expect(v).toBeGreaterThan(prev);
        expect(v).toBeGreaterThanOrEqual(t0);
        prev = v;
      }
    }
  });

  test('conditioning pushes the median later', () => {
    const unconditional = lognormalConditionalQuantile(mu, sigma, 0, 0.5);
    const waited = lognormalConditionalQuantile(mu, sigma, 200, 0.5);
    expect(waited).toBeGreaterThan(unconditional);
    expect(waited).toBeGreaterThan(200);
  });

  test('probabilities stay in [0,1] and grow with the horizon', () => {
    for (const t0 of [0, 45, 300]) {
      let prev = -1;
      for (const h of [1, 7, 30, 90, 365, 3650]) {
        const p = lognormalConditionalProb(mu, sigma, t0, h);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
        expect(p).toBeGreaterThanOrEqual(prev);
        prev = p;
      }
    }
    expect(lognormalConditionalProb(mu, sigma, 10, 0)).toBe(0);
    expect(lognormalConditionalProb(mu, sigma, 10, -5)).toBe(0);
  });

  test('t0 = 0 probability equals the unconditional CDF', () => {
    expect(lognormalConditionalProb(mu, sigma, 0, 120)).toBeCloseTo(0.5, 9);
  });

  test('overdue guard', () => {
    const t0 = 100_000;
    expect(lognormalConditionalQuantile(mu, sigma, t0, 0.5)).toBe(t0 + 1);
    expect(lognormalConditionalQuantile(mu, sigma, t0, 0.95)).toBe(t0 + 1);
    expect(lognormalConditionalProb(mu, sigma, t0, 30)).toBe(1);
  });
});

describe('cadencePrior', () => {
  test('pools log-intervals across labs and merges same-day launches', () => {
    const releases = fixture([
      // A same-day sibling must not create a zero-length interval.
      release('openai-twin', 'openai', addDays('2024-01-01', 300), [score('a', 66)]),
    ]);
    // Infinity = the unweighted estimator this test asserts (T31 iteration 2 adds recency).
    const prior = cadencePrior(releases, ASOF, ['flagship'], Infinity);
    const logs = [Math.log(100), Math.log(100), Math.log(100), Math.log(150), Math.log(150)];
    expect(prior.n).toBe(5);
    expect(prior.mu).toBeCloseTo(mean(logs), 12);
    expect(prior.sigma).toBeCloseTo(populationSd(logs), 12);
  });

  test('fallback sigma with fewer than two intervals', () => {
    const two = [
      release('openai-a', 'openai', '2024-01-01', [score('a', 50)]),
      release('openai-b', 'openai', '2024-04-10', [score('a', 60)]),
    ];
    const prior = cadencePrior(two, ASOF);
    expect(prior.n).toBe(1);
    expect(prior.mu).toBeCloseTo(Math.log(100), 12);
    expect(prior.sigma).toBe(DEFAULT_PRIOR_SIGMA);
  });

  test('no data at all falls back to the documented defaults', () => {
    const prior = cadencePrior([], ASOF);
    expect(prior).toEqual({
      mu: DEFAULT_PRIOR_MU,
      sigma: DEFAULT_PRIOR_SIGMA,
      n: 0,
      driftPerDay: 0,
      tBar: 0,
    });
  });

  test('respects asOf', () => {
    // By 2024-05-01 only openai has two releases (2024-01-01 and 2024-04-10).
    expect(cadencePrior(fixture(), '2024-05-01').n).toBe(1);
    expect(cadencePrior(fixture(), '2024-02-01').n).toBe(0);
  });
});

describe('forecastLab — cadence and shrinkage', () => {
  const releases = fixture();
  const fit = fitOf(releases);
  const prior = cadencePrior(releases, ASOF, ['flagship'], Infinity);
  // drift: false — this block unit-tests the shrinkage formula in isolation (T31 it. 3).
  const opts: ForecastOptions = { asOf: ASOF, halfLifeDays: Infinity, drift: false };

  test('shrinkage formula for a lab with three intervals', () => {
    const f = forecastLab('openai', releases, fit, prior, opts);
    expect(f.intervalsDays).toEqual([100, 100, 100]);
    const n = 3;
    const w = 2;
    expect(f.mu).toBeCloseTo((n * Math.log(100) + w * prior.mu) / (n + w), 12);
    expect(f.sigma).toBeCloseTo(Math.sqrt((n * 0 + w * prior.sigma ** 2) / (n + w)), 12);
    expect(f.elapsedDays).toBe(daysBetween(addDays('2024-01-01', 300), ASOF));
  });

  test('a lab with a single release uses the prior exactly', () => {
    const f = forecastLab('google', releases, fit, prior, opts);
    expect(f.intervalsDays).toEqual([]);
    expect(f.mu).toBe(prior.mu);
    expect(f.sigma).toBe(prior.sigma);
    expect(f.lastRelease!.release_id).toBe('google-m0');
    expect(f.next.length).toBeGreaterThan(0);
    expect(f.trend).not.toBeNull();
    expect(f.trend!.n).toBe(1);
    expect(f.trend!.slopePerDay).toBe(0);
    expect(f.trend!.residualSigma).toBe(fit.residualSigma);
  });

  test('a lab with no releases yields nothing', () => {
    const f = forecastLab('mistral', releases, fit, prior, opts);
    expect(f.lastRelease).toBeNull();
    expect(f.next).toEqual([]);
    expect(f.p30).toBe(0);
    expect(f.p90).toBe(0);
    expect(f.trend).toBeNull();
    expect(f.intervalsDays).toEqual([]);
    expect(capabilityFan(f, { asOf: ASOF, toDate: '2026-01-01' })).toEqual([]);
  });

  test('p30 <= p90 and both are probabilities', () => {
    for (const lab of ['openai', 'anthropic', 'google'] as LabId[]) {
      const f = forecastLab(lab, releases, fit, prior, opts);
      expect(f.p30).toBeGreaterThanOrEqual(0);
      expect(f.p90).toBeLessThanOrEqual(1);
      expect(f.p30).toBeLessThanOrEqual(f.p90);
    }
  });

  test('priorWeight 0 leaves a lab entirely on its own data', () => {
    const f = forecastLab('openai', releases, fit, prior, { asOf: ASOF, priorWeight: 0, drift: false });
    expect(f.mu).toBeCloseTo(Math.log(100), 12);
    expect(f.sigma).toBeCloseTo(0, 12);
  });
});

describe('forecastLab — predicted releases', () => {
  const releases = fixture();
  const fit = fitOf(releases);
  const prior = cadencePrior(releases, ASOF);

  test('k = 1 sits between the percentile dates and quantiles are ordered', () => {
    const f = forecastLab('openai', releases, fit, prior, { asOf: ASOF });
    const p = f.next[0]!;
    expect(p.k).toBe(1);
    expect(p.source).toBe('statistical');
    expect(p.p05Date <= p.p16Date).toBe(true);
    expect(p.p16Date <= p.medianDate).toBe(true);
    expect(p.medianDate <= p.p84Date).toBe(true);
    expect(p.p84Date <= p.p95Date).toBe(true);
    expect(p.medianDate > f.lastRelease!.date).toBe(true);
  });

  test('medians are ordered and certainty stays in (0,1]', () => {
    const f = forecastLab('openai', releases, fit, prior, { asOf: ASOF });
    expect(f.next.length).toBeGreaterThan(1);
    for (let i = 0; i < f.next.length; i++) {
      const p = f.next[i]!;
      expect(p.k).toBe(i + 1);
      expect(p.certainty).toBeGreaterThan(0);
      expect(p.certainty).toBeLessThanOrEqual(1);
      if (i > 0) expect(p.medianDate > f.next[i - 1]!.medianDate).toBe(true);
    }
  });

  test('uncertainty widens along the chain', () => {
    const f = forecastLab('openai', releases, fit, prior, { asOf: ASOF });
    let prevWindow = -1;
    for (const p of f.next) {
      const windowDays = daysBetween(p.p16Date, p.p84Date);
      expect(windowDays).toBeGreaterThanOrEqual(prevWindow);
      prevWindow = windowDays;
    }
  });

  test('the chain stops at the horizon', () => {
    const horizonDays = 250;
    const f = forecastLab('openai', releases, fit, prior, { asOf: ASOF, horizonDays });
    expect(f.next.length).toBeGreaterThan(0);
    expect(f.next.length).toBeLessThan(5);
    for (const p of f.next) {
      expect(daysBetween(ASOF, p.medianDate)).toBeLessThanOrEqual(horizonDays);
    }
    const long = forecastLab('openai', releases, fit, prior, { asOf: ASOF, horizonDays: 3650 });
    expect(long.next).toHaveLength(5);
    expect(forecastLab('openai', releases, fit, prior, { asOf: ASOF, maxReleases: 2 }).next).toHaveLength(2);
  });

  test('capability of each predicted release is a valid index', () => {
    const f = forecastLab('openai', releases, fit, prior, { asOf: ASOF });
    for (const p of f.next) {
      expect(p.indexLow).toBeLessThanOrEqual(p.index);
      expect(p.index).toBeLessThanOrEqual(p.indexHigh);
      expect(p.index).toBeGreaterThan(0);
      expect(p.index).toBeLessThanOrEqual(99.5 + 1e-9);
      // Labs are not expected to regress by more than 5 index points.
      expect(p.index).toBeGreaterThanOrEqual(Math.max(0.5, f.lastRelease!.index - 5) - 1e-9);
    }
  });
});

describe('forecastLab — announced override', () => {
  const announced = release('anthropic-next', 'anthropic', '2025-09-01', [], {
    status: 'announced',
    window: { start: '2025-09-01', end: '2025-11-01' },
  });
  const releases = fixture([announced]);
  const fit = fitOf(releases);
  const prior = cadencePrior(releases, ASOF);

  test('replaces the statistical k = 1 and anchors the rest of the chain', () => {
    const f = forecastLab('anthropic', releases, fit, prior, { asOf: ASOF });
    const first = f.next[0]!;
    expect(first.k).toBe(1);
    expect(first.source).toBe('announced');
    expect(first.release_id).toBe('anthropic-next');
    expect(first.p16Date).toBe('2025-09-01');
    expect(first.p84Date).toBe('2025-11-01');
    expect(first.medianDate > first.p16Date).toBe(true);
    expect(first.medianDate < first.p84Date).toBe(true);
    expect(first.p05Date < first.p16Date).toBe(true);
    expect(first.p95Date > first.p84Date).toBe(true);
    expect(first.certainty).toBeCloseTo(1 / (1 + daysBetween('2025-09-01', '2025-11-01') / 90), 12);

    const second = f.next[1]!;
    expect(second.k).toBe(2);
    expect(second.source).toBe('statistical');
    expect(second.medianDate > first.medianDate).toBe(true);
    expect(second.release_id).toBeUndefined();
  });

  test('an announced window that already started does not override', () => {
    const past = release('anthropic-old', 'anthropic', '2024-12-01', [], {
      status: 'announced',
      window: { start: '2024-12-01', end: '2024-12-20' },
    });
    const f = forecastLab('anthropic', fixture([past]), fit, prior, { asOf: ASOF });
    expect(f.next[0]!.source).toBe('statistical');
  });

  test('the earliest future window wins', () => {
    const later = release('anthropic-later', 'anthropic', '2026-01-01', [], {
      status: 'announced',
      window: { start: '2026-01-01', end: '2026-03-01' },
    });
    const f = forecastLab('anthropic', [...releases, later], fit, prior, { asOf: ASOF });
    expect(f.next[0]!.release_id).toBe('anthropic-next');
  });
});

describe('capabilityFan', () => {
  const releases = fixture();
  const fit = fitOf(releases);
  const prior = cadencePrior(releases, ASOF);
  const f = forecastLab('openai', releases, fit, prior, { asOf: ASOF });

  test('samples from asOf to toDate on the requested step', () => {
    const fan = capabilityFan(f, { asOf: ASOF, toDate: '2026-01-01', stepDays: 7 });
    expect(fan.length).toBeGreaterThan(50);
    expect(fan[0]!.date).toBe(ASOF);
    expect(daysBetween(fan[0]!.date, fan[1]!.date)).toBe(7);
    expect(fan[fan.length - 1]!.date <= '2026-01-01').toBe(true);
    for (const p of fan) {
      expect(p.low).toBeLessThanOrEqual(p.mid);
      expect(p.mid).toBeLessThanOrEqual(p.high);
      expect(p.mid).toBeGreaterThan(0);
      expect(p.high).toBeLessThan(100);
    }
  });

  test('the band never narrows in logit space', () => {
    const fan = capabilityFan(f, { asOf: ASOF, toDate: '2027-01-01' });
    let prev = -1;
    for (const p of fan) {
      // Index space can compress near saturation; the underlying θ band is the honest one.
      const halfWidth = logit(p.high / 100) - logit(p.mid / 100);
      expect(halfWidth).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = halfWidth;
    }
  });

  test('index-space width also grows while the trend stays mid-range', () => {
    // A lab parked around 50 index points: no sigmoid compression to fight.
    const flat: ModelRelease[] = [0, 1, 2, 3].map((i) =>
      release(`xai-m${i}`, 'xai', addDays('2024-01-01', i * 90), [score('a', 50 + i * 0.2), score('b', 49 + i * 0.2)]),
    );
    const all = [...releases, ...flat];
    const flatFit = fitOf(all);
    const g = forecastLab('xai', all, flatFit, cadencePrior(all, ASOF), { asOf: ASOF });
    const fan = capabilityFan(g, { asOf: ASOF, toDate: '2026-06-01', stepDays: 14 });
    let prev = -1;
    for (const p of fan) {
      const width = p.high - p.low;
      expect(width).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = width;
    }
    expect(fan[fan.length - 1]!.high - fan[fan.length - 1]!.low).toBeGreaterThan(fan[0]!.high - fan[0]!.low);
  });

  test('empty when toDate precedes asOf', () => {
    expect(capabilityFan(f, { asOf: ASOF, toDate: '2024-01-01' })).toEqual([]);
  });
});

describe('forecastAll', () => {
  test('computes the shared prior once and returns one forecast per lab', () => {
    const releases = fixture();
    const fit = fitOf(releases);
    const labs: LabId[] = ['openai', 'anthropic', 'google', 'mistral'];
    const all = forecastAll(labs, releases, fit, { asOf: ASOF });
    expect(all.map((f) => f.lab)).toEqual(labs);

    const prior = cadencePrior(releases, ASOF);
    const single = forecastLab('openai', releases, fit, prior, { asOf: ASOF });
    expect(all[0]!.mu).toBe(single.mu);
    expect(all[0]!.next.map((p) => p.medianDate)).toEqual(single.next.map((p) => p.medianDate));
  });
});

/* ------------------------------------------------------------------ T31 additions */

import { MAX_RELEASES_CAP, windowDaysOf, Z90 } from '../src/prediction';
import type { ForecastOptions } from '../src/prediction';

/** A release with an explicit tier (the fixture builder has no tier option). */
function tiered(id: string, tier: 'mid' | 'small', day: number): ModelRelease {
  return {
    ...release(id, 'openai', addDays('2024-01-01', day), [score('a', 68), score('b', 60)]),
    tier,
  };
}

describe('forecastLab — tier filter', () => {
  test('mid/small releases are excluded from cadence, anchor and trend by default', () => {
    const releases = fixture([tiered('openai-s', 'small', 280), tiered('openai-m', 'mid', 290)]);
    const fit = fitOf(releases);
    const prior = cadencePrior(releases, ASOF);

    const f = forecastLab('openai', releases, fit, prior, { asOf: ASOF });
    expect(f.intervalsDays).toEqual([100, 100, 100]);
    expect(f.lastRelease!.release_id).toBe('openai-m3');

    // The tier models are later than m3 but must not move the anchor or the trend.
    const g = forecastLab('openai', fixture(), fit, prior, { asOf: ASOF });
    expect(g.mu).toBe(f.mu);
    expect(g.elapsedDays).toBe(f.elapsedDays);
    expect(f.trend!.n).toBe(g.trend!.n);

    // An explicit tier filter including mid/small brings them back in. Chronology:
    // m0(0) m1(100) m2(200) small(280) mid(290) m3(300) — hence [100,100,80,10,10],
    // and the anchor is still m3, the latest release of the widest filter.
    const wide = forecastLab('openai', releases, fit, prior, {
      asOf: ASOF,
      tierFilter: ['flagship', 'mid', 'small'],
    });
    expect(wide.intervalsDays).toEqual([100, 100, 80, 10, 10]);
    expect(wide.lastRelease!.release_id).toBe('openai-m3');
  });

  test('cadencePrior gains the same tier default', () => {
    const releases = fixture([tiered('openai-s', 'small', 280)]);
    const flagshipOnly = cadencePrior(releases, ASOF, ['flagship'], Infinity);
    const allTiers = cadencePrior(releases, ASOF, ['flagship', 'small'], Infinity);
    expect(allTiers.n).toBe(flagshipOnly.n + 1);
    expect(flagshipOnly.n).toBe(5);
  });
});

describe('forecastLab — unbounded horizon', () => {
  const releases = fixture();
  const fit = fitOf(releases);
  const prior = cadencePrior(releases, ASOF);

  test('no horizonDays gives exactly maxReleases predictions', () => {
    expect(forecastLab('openai', releases, fit, prior, { asOf: ASOF }).next).toHaveLength(5);
    expect(
      forecastLab('openai', releases, fit, prior, { asOf: ASOF, maxReleases: 9 }).next,
    ).toHaveLength(9);
  });

  test('maxReleases above the hard cap is clamped to 24', () => {
    expect(
      forecastLab('openai', releases, fit, prior, { asOf: ASOF, maxReleases: 100 }).next,
    ).toHaveLength(MAX_RELEASES_CAP);
    expect(MAX_RELEASES_CAP).toBe(24);
  });

  test('a given horizonDays still stops the chain early', () => {
    const f = forecastLab('openai', releases, fit, prior, { asOf: ASOF, horizonDays: 250 });
    expect(f.next.length).toBeGreaterThan(0);
    for (const p of f.next) expect(daysBetween(ASOF, p.medianDate)).toBeLessThanOrEqual(250);
  });
});

describe('conditional window shrink (REDESIGN §4 unit test)', () => {
  test('p84 - p16 of T | T > t0 is non-increasing over a grid of elapsed days', () => {
    // mu = ln 90, sigma = 0.3: verified shrinking range (the extreme log-normal tail
    // eventually re-widens the law, which is outside the grid the chart can reach).
    const mu = Math.log(90);
    const sigma = 0.3;
    let prev = Number.POSITIVE_INFINITY;
    for (let t0 = 0; t0 <= 180; t0 += 15) {
      const p16 = lognormalConditionalQuantile(mu, sigma, t0, 0.16);
      const p84 = lognormalConditionalQuantile(mu, sigma, t0, 0.84);
      const w = p84 - p16;
      expect(w).toBeLessThanOrEqual(prev + 1e-12);
      prev = w;
    }
  });

  test('windowDaysOf reads p84 - p16 off a prediction', () => {
    const releases = fixture();
    const fit = fitOf(releases);
    const prior = cadencePrior(releases, ASOF);
    const f = forecastLab('openai', releases, fit, prior, { asOf: ASOF });
    for (const p of f.next) {
      expect(windowDaysOf(p)).toBe(daysBetween(p.p16Date, p.p84Date));
    }
  });
});

describe('capabilityFan — quadrature width and theta fields', () => {
  test('fan half-width is Z90 * sqrt(sigma_res^2 + (slopeSe*dd)^2) at one point', () => {
    const releases = fixture();
    const fit = fitOf(releases);
    const prior = cadencePrior(releases, ASOF);
    const f = forecastLab('openai', releases, fit, prior, { asOf: ASOF });
    const trend = f.trend!;
    const toDate = addDays(ASOF, 300);
    const fan = capabilityFan(f, { asOf: ASOF, toDate, stepDays: 300 });
    const point = fan[fan.length - 1]!;

    const dd = daysBetween(f.lastRelease!.date, toDate);
    const expectedHalf = Z90 * Math.sqrt(trend.residualSigma ** 2 + (trend.slopeSe * dd) ** 2);
    expect(point.thetaHigh! - point.theta!).toBeCloseTo(expectedHalf, 12);
    expect(point.theta! - point.thetaLow!).toBeCloseTo(expectedHalf, 12);
    expect(point.thetaHigh!).toBeGreaterThan(point.theta!);
    expect(point.thetaLow!).toBeLessThan(point.theta!);
  });

  test('predicted releases carry thetaLow/thetaHigh consistent with the index band', () => {
    const releases = fixture();
    const fit = fitOf(releases);
    const prior = cadencePrior(releases, ASOF);
    const f = forecastLab('openai', releases, fit, prior, { asOf: ASOF, maxReleases: 3 });
    for (const p of f.next) {
      expect(typeof p.thetaLow).toBe('number');
      expect(typeof p.thetaHigh).toBe('number');
      expect(p.thetaLow!).toBeLessThan(p.theta);
      expect(p.thetaHigh!).toBeGreaterThan(p.theta);
      expect(p.indexLow).toBeLessThanOrEqual(p.index);
      expect(p.indexHigh).toBeGreaterThanOrEqual(p.index);
    }
  });
});

describe('forecastLab — recency-weighted cadence (T31 it. 2)', () => {
  test('drift: false + halfLifeDays: Infinity reproduces the it.-2 unweighted numbers exactly', () => {
    const releases = fixture();
    const fit = fitOf(releases);
    const oldPrior = cadencePrior(releases, ASOF, ['flagship'], Infinity);
    const oldF = forecastLab('openai', releases, fit, oldPrior, {
      asOf: ASOF,
      halfLifeDays: Infinity,
      drift: false,
    });
    // reference: the literal unweighted formulas on [100, 100, 100]
    expect(oldF.mu).toBeCloseTo((3 * Math.log(100) + 2 * oldPrior.mu) / 5, 12);
    const pooledLogs = [Math.log(100), Math.log(100), Math.log(100), Math.log(150), Math.log(150)];
    expect(oldPrior.mu).toBeCloseTo(mean(pooledLogs), 12);
    expect(oldPrior.n).toBe(5);
  });

  test('recent intervals dominate: equal halves beat a stale long gap', () => {
    // anthropic: [150, 150] then a 400-day gap ending 30 days before asOf.
    const stale = [
      release('anthropic-a', 'anthropic', '2023-06-01', [score('a', 55), score('b', 45)]),
      release('anthropic-b', 'anthropic', '2023-11-28', [score('a', 60), score('b', 50)]),
      release('anthropic-c', 'anthropic', '2024-04-25', [score('a', 65), score('b', 55)]),
      release('anthropic-d', 'anthropic', '2025-05-29', [score('a', 70), score('b', 60)]),
    ];
    const fit = fitOf(stale);
    const weighted = cadencePrior(stale, ASOF, ['flagship'], 730);
    const unweighted = cadencePrior(stale, ASOF, ['flagship'], Infinity);
    // 400-day gap is old → weighted mu below the unweighted one
    expect(weighted.mu).toBeLessThan(unweighted.mu);
    const f = forecastLab('anthropic', stale, fit, weighted, { asOf: ASOF });
    const g = forecastLab('anthropic', stale, fit, unweighted, { asOf: ASOF });
    expect(f.mu).toBeLessThan(g.mu);
  });

  test('weighted shrinkage matches the documented n_eff formula', () => {
    // Two intervals: 100 d ending 365 d before asOf, 50 d ending 315 d before asOf.
    // weights w1 = 0.5^(365/730) = sqrt(0.5), w2 = 0.5^(315/730); n_eff = (Σw)² / Σw².
    const rels = [
      release('openai-a', 'openai', addDays(ASOF, -465), [score('a', 50), score('b', 40)]),
      release('openai-b', 'openai', addDays(ASOF, -365), [score('a', 55), score('b', 45)]),
      release('openai-c', 'openai', addDays(ASOF, -315), [score('a', 60), score('b', 50)]),
    ];
    const fit = fitOf(rels);
    const prior = cadencePrior(rels, ASOF, ['flagship'], 730);
    const w1 = Math.sqrt(0.5);
    const w2 = Math.pow(0.5, 315 / 730);
    const neff = (w1 + w2) ** 2 / (w1 * w1 + w2 * w2);
    expect(prior.n).toBeCloseTo(neff, 12);
    const f = forecastLab('openai', rels, fit, prior, { asOf: ASOF, drift: false });
    const meanW = (w1 * Math.log(100) + w2 * Math.log(50)) / (w1 + w2);
    const mu = (neff * meanW + 2 * prior.mu) / (neff + 2);
    expect(f.mu).toBeCloseTo(mu, 9);
  });
});

describe('forecastLab — sigmaScale (T31 it. 2)', () => {
  test('sigmaScale: 2 doubles the log-space window for a fresh lab (t0 = 0)', () => {
    // The lab's only release is ON asOf, so elapsed = 0 and the quantiles are unconditional:
    // offset(q) = exp(mu + sigma·z_q); the log window ln(p84off) − ln(p16off) = sigma·(z84−z16)
    // must double when sigma doubles, and the median must not move.
    const releases = [release('google-now', 'google', ASOF, [score('a', 55), score('b', 44)])];
    const fit = fitOf(releases);
    const prior = cadencePrior(releases, ASOF);
    const base = forecastLab('google', releases, fit, prior, { asOf: ASOF });
    const p1 = base.next[0]!;
    const wide = forecastLab('google', releases, fit, prior, { asOf: ASOF, sigmaScale: 2 });
    const p2 = wide.next[0]!;
    const off = (p: { p16Date: string; p84Date: string }, q: 'p16Date' | 'p84Date') =>
      daysBetween(ASOF, p[q]);
    const logWindow1 = Math.log(off(p1, 'p84Date')) - Math.log(off(p1, 'p16Date'));
    const logWindow2 = Math.log(off(p2, 'p84Date')) - Math.log(off(p2, 'p16Date'));
    // Quantile dates are whole days, so the doubling holds only up to rounding (~0.5/66 per bound).
    expect(Math.abs(logWindow2 - 2 * logWindow1)).toBeLessThan(0.03);
    expect(p2.medianDate).toBe(p1.medianDate);
    // In day space the window grows too (convexity makes it slightly more than 2x, not exactly).
    const w1 = off(p1, 'p84Date') - off(p1, 'p16Date');
    const w2 = off(p2, 'p84Date') - off(p2, 'p16Date');
    expect(w2).toBeGreaterThan(w1);
  });

  test('the stretch keeps the conditional median of an elapsed lab exactly (t0 > 0)', () => {
    const releases = fixture();
    const fit = fitOf(releases);
    const prior = cadencePrior(releases, ASOF);
    const a = forecastLab('openai', releases, fit, prior, { asOf: ASOF });
    const b = forecastLab('openai', releases, fit, prior, { asOf: ASOF, sigmaScale: 2.5 });
    expect(a.elapsedDays).toBeGreaterThan(0);
    expect(b.next[0]!.medianDate).toBe(a.next[0]!.medianDate);
    expect(b.sigma).toBe(a.sigma);
    expect(b.sigmaScale).toBe(2.5);
    // Windows open on both sides of the fixed centre.
    expect(b.next[0]!.p16Date <= a.next[0]!.p16Date).toBe(true);
    expect(b.next[0]!.p84Date >= a.next[0]!.p84Date).toBe(true);
    // P(within 90 d) moves toward 1/2 as the law flattens about its median: never past it from either side.
    const side = (p: number) => Math.sign(p - 0.5);
    expect(side(b.p90) === side(a.p90) || b.p90 === 0.5).toBe(true);
  });

  test('p84 − p16 in days grows with the scale', () => {
    const releases = fixture();
    const fit = fitOf(releases);
    const prior = cadencePrior(releases, ASOF);
    const a = forecastLab('openai', releases, fit, prior, { asOf: ASOF });
    const b = forecastLab('openai', releases, fit, prior, { asOf: ASOF, sigmaScale: 1.5 });
    const wa = daysBetween(a.next[0]!.p16Date, a.next[0]!.p84Date);
    const wb = daysBetween(b.next[0]!.p16Date, b.next[0]!.p84Date);
    expect(wb).toBeGreaterThan(wa);
  });
});

/* ------------------------------------------- T31 iteration 3 additions: cadence drift */

describe('cadencePrior — pooled drift (T31 it. 3)', () => {
  test('ridge pulls β to exactly 0 when the pool holds a single interval', () => {
    // One interval in the whole pool: Σw(t−t̄)(y−ȳ) = 0 identically, so the ridge keeps the
    // slope identified (β = 0) instead of learning the one observed gap.
    const rels = [
      release('openai-a', 'openai', '2024-01-01', [score('a', 50), score('b', 40)]),
      release('openai-b', 'openai', '2024-06-01', [score('a', 55), score('b', 45)]),
    ];
    const prior = cadencePrior(rels, ASOF, ['flagship'], Infinity);
    expect(prior.n).toBe(1);
    expect(prior.driftPerDay).toBe(0);
    expect(prior.tBar).toBe(dateToDayNumber('2024-06-01'));
  });

  test('negative drift for accelerating intervals; positive for decelerating', () => {
    // openai gaps 200, 160, 120, 80 (accelerating → β < 0); anthropic mirrored 80..200.
    const acc: ModelRelease[] = [];
    const dec: ModelRelease[] = [];
    const gapsAcc = [200, 160, 120, 80];
    const gapsDec = [80, 120, 160, 200];
    let d = '2023-01-01';
    gapsAcc.forEach((g, i) => {
      acc.push(release(`acc-m${i}`, 'openai', d, [score('a', 50 + 5 * i), score('b', 40 + 5 * i)]));
      d = addDays(d, g);
    });
    acc.push(release('acc-m4', 'openai', d, [score('a', 70), score('b', 60)]));
    d = '2023-01-01';
    gapsDec.forEach((g, i) => {
      dec.push(release(`dec-m${i}`, 'anthropic', d, [score('a', 50 + 5 * i), score('b', 40 + 5 * i)]));
      d = addDays(d, g);
    });
    dec.push(release('dec-m4', 'anthropic', d, [score('a', 70), score('b', 60)]));
    const decOnly = cadencePrior(dec, ASOF, ['flagship'], Infinity).driftPerDay;
    const accOnly = cadencePrior(acc, ASOF, ['flagship'], Infinity).driftPerDay;
    expect(accOnly).toBeLessThan(0);
    expect(decOnly).toBeGreaterThan(0);
    // The pooled β of the two opposite trends must land strictly between them.
    const pooled = cadencePrior([...acc, ...dec], ASOF, ['flagship'], Infinity).driftPerDay;
    expect(pooled).toBeGreaterThan(accOnly);
    expect(pooled).toBeLessThan(decOnly);
  });

  test('recency weights apply to the drift too: old acceleration counts less', () => {
    // Same accelerating gaps, but shifted a decade back from asOf — the recent weight mass
    // sits on near-zero weights, so |β| must shrink toward 0 relative to the fresh fixture.
    const mk = (offsetDays: number): ModelRelease[] => {
      const gaps = [200, 160, 120, 80];
      const out: ModelRelease[] = [];
      let d = addDays(ASOF, -offsetDays);
      gaps.forEach((g, i) => {
        out.push(release(`sh-m${i}`, 'openai', d, [score('a', 50 + 5 * i), score('b', 40 + 5 * i)]));
        d = addDays(d, g);
      });
      out.push(release('sh-m4', 'openai', d, [score('a', 70), score('b', 60)]));
      return out;
    };
    const fresh = cadencePrior(mk(560), ASOF, ['flagship'], 730);
    const stale = cadencePrior(mk(560 + 3650), ASOF, ['flagship'], 730);
    expect(fresh.driftPerDay).toBeLessThan(0);
    expect(stale.driftPerDay).toBeGreaterThan(fresh.driftPerDay); // pulled toward 0
    expect(Math.abs(stale.driftPerDay)).toBeLessThan(Math.abs(fresh.driftPerDay));
  });
});

describe('forecastLab — drift shift (T31 it. 3)', () => {
  /**
   * Gaps 360, 300, 240, 180, 150 d with the LAST release 30 days before asOf: a clearly
   * accelerating lab whose every interval is visible to the prior. Returns the releases and
   * the interval END day numbers (the t̄_lab the unweighted drift uses).
   */
  function acceleratingLab(): { releases: ModelRelease[]; endDays: number[] } {
    const gaps = [360, 300, 240, 180, 150];
    const dates = [addDays(ASOF, -30)];
    for (let i = gaps.length - 1; i >= 0; i--) {
      dates.unshift(addDays(dates[0]!, -gaps[i]!));
    }
    const releases = dates.map((date, i) =>
      release(`dlab-m${i}`, 'openai', date, [score('a', 40 + 5 * i), score('b', 32 + 4 * i)]),
    );
    return { releases, endDays: dates.slice(1).map(dateToDayNumber) };
  }

  const lab = acceleratingLab();
  const releases = lab.releases;
  const fit = fitOf(releases);
  const prior = cadencePrior(releases, ASOF);

  test('drift on gives an earlier median than drift off for an accelerating lab', () => {
    const off = forecastLab('openai', releases, fit, prior, { asOf: ASOF, drift: false });
    const on = forecastLab('openai', releases, fit, prior, { asOf: ASOF, drift: true });
    expect(prior.driftPerDay).toBeLessThan(0);
    expect(on.next[0]!.medianDate < off.next[0]!.medianDate).toBe(true);
    // μ is the only thing that moved; σ must be identical.
    expect(on.sigma).toBe(off.sigma);
    expect(on.mu).toBeLessThan(off.mu);
  });

  test('the shift equals the clamped β·(dayNumber(asOf) − t̄_lab) and σ stays untouched', () => {
    // halfLifeDays: Infinity → every weight is 1, so t̄_lab is the plain mean of the five
    // interval END day numbers and the expected shift is a hand-checkable formula.
    const infPrior = cadencePrior(releases, ASOF, ['flagship'], Infinity);
    const off = forecastLab('openai', releases, fit, infPrior, {
      asOf: ASOF, halfLifeDays: Infinity, drift: false,
    });
    const on = forecastLab('openai', releases, fit, infPrior, {
      asOf: ASOF, halfLifeDays: Infinity, drift: true,
    });
    const expected = clamp(infPrior.driftPerDay * (dateToDayNumber(ASOF) - mean(lab.endDays)), -1, 1);
    expect(on.mu - off.mu).toBeCloseTo(expected, 9);
    expect(off.mu).toBeCloseTo(on.mu - expected, 9);
    expect(on.sigma).toBe(off.sigma);
  });

  test('the clamp holds the shift at −1.0 for an extreme fixture', () => {
    // Monstrous negative β: gaps halving over 20 releases, the last ones ending near asOf,
    // so β·(asOf − t̄) is far below −1 and the clamp must bite.
    const gaps: number[] = [];
    let g = 720;
    for (let i = 0; i < 20; i++) {
      gaps.push(g);
      g = Math.max(2, g * 0.5);
    }
    const out: ModelRelease[] = [];
    const dates = [addDays(ASOF, -4000)];
    gaps.forEach((gg, i) => {
      out.push(
        release(`clamp-m${i}`, 'openai', dates[dates.length - 1]!, [score('a', 40 + i), score('b', 32 + i)]),
      );
      dates.push(addDays(dates[dates.length - 1]!, gg));
    });
    out.push(release('clamp-m20', 'openai', dates[dates.length - 1]!, [score('a', 70), score('b', 60)]));
    const p = cadencePrior(out, ASOF, ['flagship'], Infinity);
    const fitClamp = fitOf(out);
    const off = forecastLab('openai', out, fitClamp, p, { asOf: ASOF, halfLifeDays: Infinity, drift: false });
    const on = forecastLab('openai', out, fitClamp, p, { asOf: ASOF, halfLifeDays: Infinity, drift: true });
    const raw = p.driftPerDay * (dateToDayNumber(ASOF) - mean(dates.slice(1).map(dateToDayNumber)));
    expect(raw).toBeLessThan(-1); // the clamp is genuinely exercised
    expect(on.mu - off.mu).toBeCloseTo(-1, 9);
  });

  test('a lab with no intervals falls back to the pooled tBar', () => {
    // google has a single release: no intervals of its own → the shift uses prior.tBar.
    const releases2 = fixture();
    const fit2 = fitOf(releases2);
    const prior2 = cadencePrior(releases2, ASOF);
    const off = forecastLab('google', releases2, fit2, prior2, { asOf: ASOF, drift: false });
    const on = forecastLab('google', releases2, fit2, prior2, { asOf: ASOF, drift: true });
    expect(on.mu - off.mu).toBeCloseTo(
      clamp(prior2.driftPerDay * (dateToDayNumber(ASOF) - prior2.tBar), -1, 1),
      9,
    );
  });
});

/* ------------------------------------------- the release lens (REDESIGN §12.4) */

describe('stretchedConditionalCdf', () => {
  const mu = Math.log(120);
  const sigma = 0.5;
  const t0 = 90;

  test('inverts stretchedConditionalQuantile exactly, for every scale', () => {
    for (const s of [1, 1.4, 2.5]) {
      for (const q of [0.02, 0.05, 0.16, 0.5, 0.84, 0.95, 0.98]) {
        const t = stretchedConditionalQuantile(mu, sigma, t0, q, s);
        expect(stretchedConditionalCdf(mu, sigma, t0, t, s)).toBeCloseTo(q, 9);
      }
    }
  });

  test('agrees with stretchedConditionalProb everywhere after t0, and is continuous across it', () => {
    const s = 1.4;
    for (const h of [0.5, 1, 10, 100, 400]) {
      expect(stretchedConditionalCdf(mu, sigma, t0, t0 + h, s)).toBeCloseTo(
        stretchedConditionalProb(mu, sigma, t0, h, s),
        12,
      );
    }
    // The stretch pushes the left tail before t0, so the CDF is already positive there and
    // rises smoothly through today; stretchedConditionalProb floors that whole tail onto t0.
    const justBefore = stretchedConditionalCdf(mu, sigma, t0, t0 - 0.5, s);
    const justAfter = stretchedConditionalCdf(mu, sigma, t0, t0 + 0.5, s);
    expect(justBefore).toBeGreaterThan(0);
    expect(justAfter - justBefore).toBeLessThan(0.02); // no jump — the old atom was ≈ 0.17
    expect(stretchedConditionalProb(mu, sigma, t0, -0.5, s)).toBe(0);
  });

  test('monotone, and 0 below the support of the stretched law', () => {
    const s = 2;
    let prev = -1;
    for (let t = 1; t <= 600; t += 1) {
      const p = stretchedConditionalCdf(mu, sigma, t0, t, s);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
    // Support floor m·(t0/m)^s: everything below it is genuinely impossible under the stretch.
    const m = stretchedConditionalQuantile(mu, sigma, t0, 0.5, s);
    const floor = m * Math.pow(t0 / m, s);
    expect(floor).toBeLessThan(t0); // the stretch really does reach before asOf here
    expect(stretchedConditionalCdf(mu, sigma, t0, floor - 1, s)).toBe(0);
    expect(stretchedConditionalCdf(mu, sigma, t0, floor + 1, s)).toBeGreaterThan(0);
  });
});

describe('releaseDensity — the k = 1 lens under a production sigmaScale', () => {
  /**
   * Irregular gaps (80/150/95/165 d) so the fitted σ is genuinely positive — a lab on a perfect
   * metronome fits σ = 0 and every lens collapses to a flat day. asOf is 90 days after the last
   * release, i.e. mid-cycle, which is where the stretch reaches back before today.
   */
  const OFFSETS = [0, 80, 230, 325, 490];
  const lensReleases = OFFSETS.map((off, i) =>
    release(`lens-m${i}`, 'openai', addDays('2023-06-01', off), [score('a', 45 + 6 * i), score('b', 38 + 6 * i)]),
  );
  const lensFit = fitOf(lensReleases);
  const forecastAt = (sigmaScale: number) =>
    forecastAll(['openai'], lensReleases, lensFit, { asOf: ASOF, sigmaScale })[0]!;

  /** Riemann sum of the unnormalised density: the mass between the 2nd and 98th percentiles. */
  const massOf = (sigmaScale: number, n: number): number => {
    const f = forecastAt(sigmaScale);
    const { samples, stepDays } = releaseDensityRaw(f, f.next[0]!, n);
    return samples.reduce((acc, s) => acc + s.p * stepDays, 0);
  };

  const modeIndex = (samples: { p: number }[]): number => {
    let best = 0;
    for (let i = 0; i < samples.length; i++) if (samples[i]!.p > samples[best]!.p) best = i;
    return best;
  };

  test('the lab is mid-cycle, so the stretch really does reach behind asOf', () => {
    const f = forecastAt(1.4);
    expect(f.elapsedDays).toBeGreaterThan(0);
    expect(f.sigma).toBeGreaterThan(0);
    // With s > 1 forecastLab itself publishes a p05 before today; the lens must tell the same story.
    expect(f.next[0]!.p05Date < ASOF).toBe(true);
  });

  test('integrates to the sampled 96 % at every scale and sample count', () => {
    // Before the atom was removed these were 0.86 (s = 1.4, n = 48), 1.43 (n = 44 — a grid whose
    // samples straddle asOf) and 10.67 (s = 2.5, n = 15): mass either vanished between samples
    // or was counted as a needle several times its true height.
    for (const s of [1, 1.4, 2.5]) {
      for (const n of [15, 44, 48, 96]) {
        expect(massOf(s, n)).toBeGreaterThan(0.9);
        expect(massOf(s, n)).toBeLessThan(1.1);
      }
    }
  });

  test('no needle at asOf: the shape is a smooth bump at sigmaScale 1.4', () => {
    const f = forecastAt(1.4);
    const pred = f.next[0]!;
    for (const n of [44, 48]) {
      const samples = releaseDensity(f, pred, n);
      const mode = modeIndex(samples);
      let nearest = 0;
      for (let i = 0; i < samples.length; i++) {
        if (Math.abs(daysBetween(ASOF, samples[i]!.date)) < Math.abs(daysBetween(ASOF, samples[nearest]!.date))) {
          nearest = i;
        }
      }
      // The old code put the whole pre-asOf tail on this one sample and made it the mode.
      expect(mode).not.toBe(nearest);
      expect(samples[mode]!.date >= pred.p16Date && samples[mode]!.date <= pred.p84Date).toBe(true);
      // Every sample carries mass (the truncated CDF left the leading samples at exactly 0) …
      for (const smp of samples) expect(smp.p).toBeGreaterThan(0);
      // … and the shape rises to the mode and falls after it, with no cliff between neighbours.
      for (let i = 1; i < samples.length; i++) {
        expect(Math.abs(samples[i]!.p - samples[i - 1]!.p)).toBeLessThan(0.2);
        if (i <= mode) expect(samples[i]!.p).toBeGreaterThanOrEqual(samples[i - 1]!.p);
        else expect(samples[i]!.p).toBeLessThanOrEqual(samples[i - 1]!.p);
      }
    }
  });

  test('an extreme scale still gives one bump inside the published window', () => {
    const f = forecastAt(2.5);
    const pred = f.next[0]!;
    const samples = releaseDensity(f, pred, 48);
    const mode = modeIndex(samples);
    // A wide stretch moves the mode of the law itself earlier — it may sit before p16 — but it
    // stays inside the window forecastLab published, and the lens stays continuous.
    expect(samples[mode]!.date >= pred.p05Date && samples[mode]!.date <= pred.p95Date).toBe(true);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!.p).toBeGreaterThan(0);
      expect(Math.abs(samples[i]!.p - samples[i - 1]!.p)).toBeLessThan(0.2);
    }
  });

  test('shape invariants: mode 1, never negative, never fewer than MIN_DENSITY_SAMPLES', () => {
    const f = forecastAt(1.4);
    const samples = releaseDensity(f, f.next[0]!, 2);
    expect(samples.length).toBe(MIN_DENSITY_SAMPLES);
    expect(Math.max(...samples.map((s) => s.p))).toBeCloseTo(1, 12);
    for (const s of samples) {
      expect(s.p).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(s.day)).toBe(true);
    }
    // A chained (k ≥ 2) prediction uses the log-normal branch and must stay drawable too.
    const chained = releaseDensity(f, f.next[2]!, 32);
    expect(chained.length).toBe(32);
    expect(Math.max(...chained.map((s) => s.p))).toBeCloseTo(1, 12);
    // A lab with no release at all has no lens.
    const empty = forecastAll(['meta'], lensReleases, lensFit, { asOf: ASOF })[0]!;
    expect(releaseDensity(empty, { ...f.next[0]! }, 16)).toEqual([]);
  });
});
