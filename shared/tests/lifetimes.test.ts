import { describe, expect, test } from 'bun:test';
import {
  benchmarkLifetimes,
  comparability,
  COVERAGE_DAYS,
  FRESH_DAYS,
  SATURATION_SHARE,
} from '../src/lifetimes';
import { fitFrontierIndex } from '../src/frontier-index';
import { benchmark, release, score } from './test-helpers';
import type { Benchmark, ModelRelease } from '../src/types';

const ASOF = '2026-09-01';

/** The fixture builder fixes `introduced: 2024`; override it (and anything else) here. */
function bench(id: string, patch: Partial<Benchmark> = {}, opts: Parameters<typeof benchmark>[1] = {}): Benchmark {
  return { ...benchmark(id, opts), ...patch };
}

function tiered(r: ModelRelease, tier: ModelRelease['tier']): ModelRelease {
  return { ...r, tier };
}

describe('benchmarkLifetimes', () => {
  const benches = [
    bench('old', { introduced: 2022 }, { legacy: true, generation: 1 }),
    bench('sat', { introduced: 2024 }, { generation: 2 }),
    bench('act', { introduced: 2024 }, { generation: 3 }),
    bench('new', { introduced: 2026 }, { generation: 4 }),
    bench('arena', { introduced: 2024, unit: 'elo', max: 4000, elo_reference: 1200 }, { generation: 3, weight: 2 }),
    bench('mnt', { introduced: 2024 }, { inIndex: false }),
  ];
  const releases = [
    release('m1', 'openai', '2024-03-01', [score('sat', 70), score('act', 50), score('old', 90)]),
    release('m2', 'anthropic', '2025-01-01', [
      score('sat', 96),
      score('act', 60),
      score('mnt', 80),
      score('mnt', 97, { reportedBy: 'maintainer' }),
      score('arena', 1400, { reportedBy: 'maintainer' }),
    ]),
    release('m3', 'google', '2026-06-01', [score('sat', 98), score('act', 70), score('new', 40), score('arena', 1450, { reportedBy: 'maintainer' })]),
    tiered(release('s1', 'openai', '2026-07-01', [score('act', 30)]), 'small'),
    // Future and unreleased rows must never count.
    release('m4', 'xai', '2026-10-01', [score('new', 90), score('act', 90)]),
    release('a1', 'meta', '2026-01-01', [score('new', 95)], { status: 'announced' }),
  ];
  const fit = fitFrontierIndex(releases, benches, { asOf: ASOF });
  const rows = benchmarkLifetimes(fit, releases, benches, ASOF);
  const row = (id: string) => rows.find((r) => r.benchmark === id)!;

  test('one row per benchmark, in basket order, carrying generation and weight', () => {
    expect(rows.map((r) => r.benchmark)).toEqual(['old', 'sat', 'act', 'new', 'arena', 'mnt']);
    expect(row('sat').generation).toBe(2);
    expect(row('arena').weight).toBe(2);
    expect(row('new').introduced).toBe(2026);
  });

  test('a 96 % official score saturates the benchmark at that release date', () => {
    expect(SATURATION_SHARE).toBe(0.95);
    expect(row('sat').saturatedAt).toBe('2025-01-01');
    expect(row('sat').state).toBe('saturated');
    expect(row('sat').firstScore).toBe('2024-03-01');
    expect(row('sat').nScores).toBe(3);
  });

  test('maintainer scores do not saturate; Elo never saturates', () => {
    expect(row('mnt').saturatedAt).toBeNull();
    expect(row('mnt').state).toBe('active');
    expect(row('arena').saturatedAt).toBeNull();
    expect(row('arena').state).toBe('active');
  });

  test('introduced this year is fresh; an older unsaturated one is active; the curator flag is legacy', () => {
    expect(row('new').state).toBe('fresh');
    expect(row('new').firstScore).toBe('2026-06-01');
    expect(row('new').nScores).toBe(1); // m4 is in the future, a1 is only announced
    expect(row('act').state).toBe('active');
    expect(row('old').state).toBe('legacy');
    // Fresh is a rolling window from mid-year of `introduced`.
    const early = benchmarkLifetimes(fit, releases, benches, '2025-03-01');
    expect(early.find((r) => r.benchmark === 'act')!.state).toBe('fresh');
    expect(FRESH_DAYS).toBe(365);
  });

  test('a benchmark not yet introduced at asOf is omitted, not reported fresh', () => {
    // Time-travelling behind a 2026 benchmark: its age is −760 days, which used to slip through
    // the `<= FRESH_DAYS` test and produce a scoreless "fresh" row starting in the future.
    const early = benchmarkLifetimes(fit, releases, benches, '2024-06-01');
    expect(early.map((r) => r.benchmark)).not.toContain('new');
    // `old` (2022) is genuinely born; `sat` and `act` are 2024 benchmarks whose nominal mid-year
    // birthday is still a month away but which m1 already scored in March, so they stay. `arena`
    // and `mnt` are 2024 too and nobody has scored them yet, so they are not there at all.
    expect(early.map((r) => r.benchmark)).toEqual(['old', 'sat', 'act']);
    expect(early.find((r) => r.benchmark === 'act')!.state).toBe('active');
    // Exactly on its introduction date the age is 0 and it is fresh.
    const onBirthday = benchmarkLifetimes(fit, releases, benches, '2026-07-01');
    expect(onBirthday.find((r) => r.benchmark === 'new')!.state).toBe('fresh');
    // A day earlier m3 has already scored it, so the row survives — but at an age of −1 day it
    // is not "fresh" either; freshness now needs a birthday that has actually happened.
    const dayBefore = benchmarkLifetimes(fit, releases, benches, '2026-06-30');
    expect(dayBefore.find((r) => r.benchmark === 'new')!.state).toBe('active');
  });

  test('an early score keeps a not-yet-introduced benchmark visible', () => {
    // `introduced` is a year taken at its midpoint, so a January benchmark can be scored before
    // that date. The evidence wins: the row stays, and it is not called fresh on a negative age.
    const bs = [bench('jan', { introduced: 2026 })];
    const rel = [release('e1', 'openai', '2026-02-01', [score('jan', 40)])];
    const rows4 = benchmarkLifetimes(fitFrontierIndex(rel, bs), rel, bs, '2026-03-01');
    expect(rows4).toHaveLength(1);
    expect(rows4[0]!.firstScore).toBe('2026-02-01');
    expect(rows4[0]!.nScores).toBe(1);
    expect(rows4[0]!.state).toBe('active');
  });

  test('a legacy benchmark that also saturated keeps saturatedAt but reports legacy', () => {
    const legacySat = [bench('ls', { introduced: 2020 }, { legacy: true })];
    const rel = [release('x', 'openai', '2024-01-01', [score('ls', 99)])];
    const r = benchmarkLifetimes(fitFrontierIndex(rel, legacySat), rel, legacySat, ASOF)[0]!;
    expect(r.saturatedAt).toBe('2024-01-01');
    expect(r.state).toBe('legacy');
  });

  test('nScores counts every released model once, any reporter', () => {
    expect(row('act').nScores).toBe(4); // m1 m2 m3 s1 — not m4 (future) nor a1 (announced)
    expect(row('mnt').nScores).toBe(1); // two scores on m2 count as one model
    expect(row('arena').nScores).toBe(2);
  });

  test('coverageOfFrontier is the share of the last year\'s flagships reporting it', () => {
    expect(COVERAGE_DAYS).toBe(365);
    // Only m3 (2026-06-01) is a flagship within 365 days of asOf; s1 is small, m2 too old.
    expect(row('sat').coverageOfFrontier).toBe(1);
    expect(row('new').coverageOfFrontier).toBe(1);
    expect(row('old').coverageOfFrontier).toBe(0);
    expect(row('mnt').coverageOfFrontier).toBe(0);
    // Two recent flagships, one reporting → 0.5.
    const two = [...releases, release('m5', 'xai', '2026-08-01', [score('act', 75)])];
    const rows2 = benchmarkLifetimes(fitFrontierIndex(two, benches, { asOf: ASOF }), two, benches, ASOF);
    expect(rows2.find((r) => r.benchmark === 'sat')!.coverageOfFrontier).toBe(0.5);
    expect(rows2.find((r) => r.benchmark === 'act')!.coverageOfFrontier).toBe(1);
  });

  test('delta is the fitted δ for observed index benchmarks and null otherwise', () => {
    expect(row('sat').delta).toBe(fit.difficulties['sat']!);
    expect(typeof row('act').delta).toBe('number');
    expect(row('mnt').delta).toBeNull(); // not in the index
    const unobserved = [...benches, bench('ghost', { introduced: 2025 })];
    const rows3 = benchmarkLifetimes(fitFrontierIndex(releases, unobserved, { asOf: ASOF }), releases, unobserved, ASOF);
    expect(rows3.find((r) => r.benchmark === 'ghost')!.delta).toBeNull();
    expect(rows3.find((r) => r.benchmark === 'ghost')!.nScores).toBe(0);
    expect(rows3.find((r) => r.benchmark === 'ghost')!.firstScore).toBeNull();
  });
});

describe('comparability', () => {
  const benches = [benchmark('a'), benchmark('b'), benchmark('c')];
  const releases = [
    release('A', 'openai', '2024-01-01', [score('a', 50), score('b', 40), score('c', 30)]),
    tiered(release('S', 'openai', '2024-03-01', [score('a', 20)]), 'small'),
    release('B', 'anthropic', '2024-06-01', [score('a', 55), score('b', 45)]),
    release('C', 'google', '2026-06-01', [score('a', 80), score('b', 70), score('c', 60)]),
    release('F', 'xai', '2027-01-01', [score('a', 90), score('b', 90), score('c', 90)]),
  ];
  const fit = fitFrontierIndex(releases, benches);

  test('counts distinct shared benchmarks with flagships within ±18 months', () => {
    const cmp = comparability(fit, releases, { asOf: ASOF });
    expect(cmp.get('A')).toEqual({ shared: 2, neighbours: 1 }); // B shares a, b; S is small
    expect(cmp.get('B')).toEqual({ shared: 2, neighbours: 1 });
    expect(cmp.get('C')).toEqual({ shared: 0, neighbours: 0 }); // B is 24 months away
    // A small model is compared against the flagships of its time.
    expect(cmp.get('S')).toEqual({ shared: 1, neighbours: 2 });
    // Future releases are excluded entirely.
    expect(cmp.has('F')).toBe(false);
  });

  test('a wider window admits farther neighbours', () => {
    const cmp = comparability(fit, releases, { asOf: ASOF, windowMonths: 36 });
    expect(cmp.get('C')).toEqual({ shared: 3, neighbours: 2 }); // A shares a, b, c; B shares a, b
    expect(cmp.get('A')!.neighbours).toBe(2);
  });

  test('unfitted models are absent', () => {
    const bare = [...releases, release('bare', 'meta', '2024-02-01', [])];
    const cmp = comparability(fitFrontierIndex(bare, benches), bare, { asOf: ASOF });
    expect(cmp.has('bare')).toBe(false);
  });
});
