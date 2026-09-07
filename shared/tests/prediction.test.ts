import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PRIOR_MU,
  DEFAULT_PRIOR_SIGMA,
  cadencePrior,
  capabilityFan,
  forecastAll,
  forecastLab,
  lognormalConditionalProb,
  lognormalConditionalQuantile,
} from '../src/prediction';
import { fitFrontierIndex, logit } from '../src/frontier-index';
import { addDays, daysBetween } from '../src/timeline';
import { benchmark, release, score } from './test-helpers';
import { lognormalQuantile, mean, populationSd } from '../src/stats';
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
    const prior = cadencePrior(releases, ASOF);
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
    expect(prior).toEqual({ mu: DEFAULT_PRIOR_MU, sigma: DEFAULT_PRIOR_SIGMA, n: 0 });
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
  const prior = cadencePrior(releases, ASOF);
  const opts = { asOf: ASOF };

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
    const f = forecastLab('openai', releases, fit, prior, { asOf: ASOF, priorWeight: 0 });
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
    const flagshipOnly = cadencePrior(releases, ASOF);
    const allTiers = cadencePrior(releases, ASOF, ['flagship', 'small']);
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
