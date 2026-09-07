import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_CLIP,
  fitFrontierIndex,
  frontierGains,
  frontierLine,
  frontierPace,
  frontierVelocity,
  indexFromTheta,
  logit,
  selectIndexScores,
  sigmoid,
  thetaFromIndex,
  type FrontierPoint,
  MIN_QUALIFIED_SCORES,
} from '../src/frontier-index';
import { addDays } from '../src/timeline';
import { benchmark, gaussian, linspace, raschFixture, release, rng, score } from './test-helpers';

describe('scale helpers', () => {
  test('sigmoid / logit round-trip', () => {
    for (const p of [0.01, 0.2, 0.5, 0.9, 0.995]) {
      expect(sigmoid(logit(p))).toBeCloseTo(p, 12);
    }
  });

  test('index <-> theta round-trip inside the clip', () => {
    for (const idx of [0.5, 12, 50, 80, 99.5]) {
      expect(indexFromTheta(thetaFromIndex(idx))).toBeCloseTo(idx, 10);
    }
    // Outside the clip thetaFromIndex saturates instead of returning ±Infinity.
    expect(Number.isFinite(thetaFromIndex(0))).toBe(true);
    expect(Number.isFinite(thetaFromIndex(100))).toBe(true);
  });
});

describe('selectIndexScores', () => {
  const bms = [
    benchmark('arc-agi-2', { preferredConfig: 'semi-private evaluation set (ARC Prize verified); public eval if that is all a lab reports' }),
    benchmark('aime', { preferredConfig: 'AIME 2025 without tools; fall back to AIME 2024 for models from 2024' }),
    benchmark('offindex', { inIndex: false }),
  ];

  test('prefers official over maintainer', () => {
    const r = release('r1', 'openai', '2025-01-01', [
      score('aime', 50, { reportedBy: 'maintainer', config: 'AIME 2025' }),
      score('aime', 60, { reportedBy: 'official' }),
    ]);
    const picked = selectIndexScores(r, bms);
    expect(picked).toHaveLength(1);
    expect(picked[0]!.value).toBe(60);
    expect(picked[0]!.reported_by).toBe('official');
  });

  test('prefers a config sharing a keyword with preferred_config', () => {
    const r = release('r2', 'openai', '2025-01-01', [
      score('arc-agi-2', 10, { config: 'public eval' }),
      score('arc-agi-2', 20, { config: 'semi-private, ARC Prize verified' }),
    ]);
    // Both share keywords ("public"/"eval" vs "semi"/"private"); the first listed wins the tie.
    expect(selectIndexScores(r, bms)[0]!.value).toBe(10);

    const r3 = release('r3', 'openai', '2025-01-01', [
      score('arc-agi-2', 10, { config: 'with extended thinking budget' }),
      score('arc-agi-2', 20, { config: 'semi-private set' }),
    ]);
    expect(selectIndexScores(r3, bms)[0]!.value).toBe(20);
  });

  test('config match never beats official', () => {
    const r = release('r4', 'openai', '2025-01-01', [
      score('arc-agi-2', 10, { reportedBy: 'maintainer', config: 'semi-private set' }),
      score('arc-agi-2', 20, { reportedBy: 'official', config: 'unspecified' }),
    ]);
    expect(selectIndexScores(r, bms)[0]!.value).toBe(20);
  });

  test('falls back to the first listed', () => {
    const r = release('r5', 'openai', '2025-01-01', [
      score('aime', 11),
      score('aime', 22),
    ]);
    expect(selectIndexScores(r, bms)[0]!.value).toBe(11);
  });

  test('ignores benchmarks outside the index and returns basket order', () => {
    const r = release('r6', 'openai', '2025-01-01', [
      score('offindex', 99),
      score('aime', 50),
      score('arc-agi-2', 20, { config: 'semi-private set' }),
    ]);
    const picked = selectIndexScores(r, bms);
    expect(picked.map((s) => s.benchmark)).toEqual(['arc-agi-2', 'aime']);
  });

  test('deterministic across repeated calls', () => {
    const r = release('r7', 'openai', '2025-01-01', [
      score('aime', 1, { reportedBy: 'maintainer' }),
      score('aime', 2, { config: 'AIME 2025 without tools' }),
      score('aime', 3),
    ]);
    const a = selectIndexScores(r, bms);
    const b = selectIndexScores(r, bms);
    expect(a.map((s) => s.value)).toEqual(b.map((s) => s.value));
    expect(a[0]!.value).toBe(2);
  });
});

describe('fitFrontierIndex — exact recovery', () => {
  test('complete matrix, no ridge, no noise → exact additive decomposition', () => {
    const thetas = linspace(-1.8, 2.2, 12);
    const deltas = linspace(-1.4, 1.4, 7);
    const fx = raschFixture({ thetas, deltas });

    const fit = fitFrontierIndex(fx.releases, fx.benchmarks, { ridge: 0, tolerance: 1e-14, maxIter: 500 });
    expect(fit.converged).toBe(true);

    // mean(deltas) = 0 by construction, so θ and δ must come back untouched.
    for (let m = 0; m < thetas.length; m++) {
      expect(fit.models[fx.ids[m]!]!.theta).toBeCloseTo(thetas[m]!, 9);
    }
    for (let b = 0; b < deltas.length; b++) {
      expect(fit.difficulties[`b${b}`]!).toBeCloseTo(deltas[b]!, 9);
    }
    expect(fit.residualSigma).toBeLessThan(1e-9);
  });

  test('predictions are invariant to a shift of the δ vector', () => {
    const thetas = linspace(-1, 2, 6);
    const deltas = linspace(-1, 1, 5).map((d) => d + 0.75); // deliberately off-centre
    const fx = raschFixture({ thetas, deltas });
    const fit = fitFrontierIndex(fx.releases, fx.benchmarks, { ridge: 0, tolerance: 1e-14, maxIter: 500 });

    const meanDelta = fit.benchmarksInIndex.reduce((s, id) => s + fit.difficulties[id]!, 0) / fit.benchmarksInIndex.length;
    expect(meanDelta).toBeCloseTo(0, 12);

    // θ − δ must still reproduce every observed percentage exactly.
    for (const m of Object.values(fit.models)) {
      for (const u of m.used) {
        expect(u.predicted).toBeCloseTo(u.value, 8);
        expect(Math.abs(u.residual)).toBeLessThan(1e-9);
      }
    }
  });

  test('20 x 13 synthetic with λ = 0.05 stays within 0.01 logit', () => {
    const thetas = linspace(-1.8, 1.8, 20);
    const deltas = linspace(-1.5, 1.5, 13);
    const fx = raschFixture({ thetas, deltas });
    const fit = fitFrontierIndex(fx.releases, fx.benchmarks, { ridge: 0.05, tolerance: 1e-12, maxIter: 500 });

    let worstTheta = 0;
    for (let m = 0; m < thetas.length; m++) {
      worstTheta = Math.max(worstTheta, Math.abs(fit.models[fx.ids[m]!]!.theta - thetas[m]!));
    }
    let worstDelta = 0;
    for (let b = 0; b < deltas.length; b++) {
      worstDelta = Math.max(worstDelta, Math.abs(fit.difficulties[`b${b}`]! - deltas[b]!));
    }
    expect(worstTheta).toBeLessThan(0.01);
    expect(worstDelta).toBeLessThan(0.01);
  });
});

describe('fitFrontierIndex — bookkeeping', () => {
  const bms = [benchmark('a'), benchmark('b'), benchmark('c'), benchmark('z', { inIndex: false })];

  test('coverage counts all index benchmarks; a model with no index score is dropped', () => {
    const releases = [
      release('m-full', 'openai', '2025-01-01', [score('a', 80), score('b', 70), score('c', 60)]),
      release('m-part', 'anthropic', '2025-02-01', [score('a', 82)]),
      release('m-none', 'google', '2025-03-01', [score('z', 90)]),
      release('m-empty', 'meta', '2025-04-01', []),
    ];
    const fit = fitFrontierIndex(releases, bms);
    expect(fit.benchmarksInIndex).toEqual(['a', 'b', 'c']);
    expect(fit.models['m-full']!.coverage).toBeCloseTo(1, 12);
    expect(fit.models['m-part']!.coverage).toBeCloseTo(1 / 3, 12);
    expect(fit.models['m-none']).toBeUndefined();
    expect(fit.models['m-empty']).toBeUndefined();
  });

  test('benchmarks with no observation keep δ = 0 but stay in the basket', () => {
    const releases = [release('m1', 'openai', '2025-01-01', [score('a', 80), score('b', 40)])];
    const fit = fitFrontierIndex(releases, bms);
    expect(fit.benchmarksInIndex).toContain('c');
    expect(fit.difficulties['c']).toBe(0);
  });

  test('only released models within asOf are fitted', () => {
    const releases = [
      release('r-old', 'openai', '2024-01-01', [score('a', 50), score('b', 40)]),
      release('r-new', 'openai', '2025-06-01', [score('a', 90), score('b', 80)]),
      release('r-ann', 'openai', '2025-02-01', [score('a', 95), score('b', 95)], { status: 'announced' }),
      release('r-rum', 'openai', '2025-03-01', [score('a', 99), score('b', 99)], { status: 'rumored' }),
    ];
    const all = fitFrontierIndex(releases, bms);
    expect(Object.keys(all.models).sort()).toEqual(['r-new', 'r-old']);

    const cut = fitFrontierIndex(releases, bms, { asOf: '2025-01-01' });
    expect(Object.keys(cut.models)).toEqual(['r-old']);
    expect(cut.asOf).toBe('2025-01-01');
  });

  test('scores are clipped before the logit', () => {
    const releases = [
      release('m1', 'openai', '2025-01-01', [score('a', 100), score('b', 0)]),
      release('m2', 'anthropic', '2025-01-02', [score('a', 99.5), score('b', 0.5)]),
    ];
    const fit = fitFrontierIndex(releases, bms, { clip: DEFAULT_CLIP, ridge: 0, tolerance: 1e-14 });
    // 100 % clips to 99.5 % and 0 % to 0.5 %, so the two models must land on the same θ.
    expect(fit.models['m1']!.theta).toBeCloseTo(fit.models['m2']!.theta, 10);
  });

  test('empty input is a well-formed empty fit', () => {
    const fit = fitFrontierIndex([], bms);
    expect(fit.models).toEqual({});
    expect(fit.residualSigma).toBe(0);
    expect(fit.converged).toBe(true);
    expect(fit.benchmarksInIndex).toEqual(['a', 'b', 'c']);
  });

  test('se, indexLow and indexHigh are consistent', () => {
    const next = rng(7);
    const fx = raschFixture({
      thetas: linspace(-1, 2, 10),
      deltas: linspace(-1.2, 1.2, 8),
      noise: () => 0.12 * gaussian(next),
    });
    const fit = fitFrontierIndex(fx.releases, fx.benchmarks);
    expect(fit.residualSigma).toBeGreaterThan(0);
    for (const m of Object.values(fit.models)) {
      expect(m.se).toBeCloseTo(fit.residualSigma / Math.sqrt(m.n), 12);
      expect(m.indexLow).toBeCloseTo(indexFromTheta(m.theta - m.se), 12);
      expect(m.indexHigh).toBeCloseTo(indexFromTheta(m.theta + m.se), 12);
      expect(m.indexLow).toBeLessThanOrEqual(m.index);
      expect(m.index).toBeLessThanOrEqual(m.indexHigh);
    }
  });
});

describe('fitFrontierIndex — missing-data invariance', () => {
  test('dropping an easy benchmark from a strong model moves it by less than its se', () => {
    const next = rng(1234);
    const thetas = linspace(-1, 2.2, 9);
    const deltas = linspace(-1.6, 1.6, 7); // b0 is the easiest benchmark
    const fx = raschFixture({ thetas, deltas, noise: () => 0.1 * gaussian(next) });

    const strongId = fx.ids[fx.ids.length - 1]!;
    const before = fitFrontierIndex(fx.releases, fx.benchmarks);
    const m0 = before.models[strongId]!;

    const trimmed = fx.releases.map((r) =>
      r.id === strongId ? { ...r, scores: r.scores.filter((s) => s.benchmark !== 'b0') } : r,
    );
    const after = fitFrontierIndex(trimmed, fx.benchmarks);
    const m1 = after.models[strongId]!;

    expect(m1.n).toBe(m0.n - 1);
    // Naive averaging would punish the model for dropping an easy test; the Rasch fit must not.
    const tolerance = m0.index - m0.indexLow;
    expect(m0.index - m1.index).toBeLessThanOrEqual(tolerance + 1e-9);
    expect(Math.abs(m0.theta - m1.theta)).toBeLessThanOrEqual(m0.se + 1e-9);
  });

  test('a model reporting only hard benchmarks is not penalised', () => {
    const bms = [benchmark('easy'), benchmark('hard')];
    const releases = [
      // Two equally able models; one reports both, the other only the hard benchmark.
      release('both', 'openai', '2025-01-01', [score('easy', 95), score('hard', 40)]),
      release('hardonly', 'anthropic', '2025-01-02', [score('hard', 40)]),
    ];
    const fit = fitFrontierIndex(releases, bms, { ridge: 0, tolerance: 1e-14, maxIter: 500 });
    expect(fit.models['hardonly']!.theta).toBeCloseTo(fit.models['both']!.theta, 6);
    // …while the raw average would have ranked them 67.5 vs 40.
    expect(fit.models['hardonly']!.coverage).toBeCloseTo(0.5, 12);
  });
});

describe('frontierLine', () => {
  test('is a strictly increasing running maximum over non-decreasing dates', () => {
    const bms = [benchmark('a'), benchmark('b')];
    const releases = [
      release('r1', 'openai', '2024-01-01', [score('a', 40), score('b', 30)]),
      release('r2', 'anthropic', '2024-06-01', [score('a', 30), score('b', 20)]), // regression
      release('r3', 'google', '2025-01-01', [score('a', 70), score('b', 60)]),
      release('r4', 'xai', '2025-02-01', [score('a', 71), score('b', 61)]),
      release('r5', 'meta', '2025-03-01', [score('a', 50), score('b', 40)]), // below the frontier
    ];
    const fit = fitFrontierIndex(releases, bms);
    const line = frontierLine(fit, { includeProvisional: true }); // two-benchmark fixture → provisional
    expect(line.map((p) => p.release_id)).toEqual(['r1', 'r3', 'r4']);
    expect(frontierLine(fit)).toEqual([]); // nothing qualified with only 2 index scores
    for (let i = 1; i < line.length; i++) {
      expect(line[i]!.index).toBeGreaterThan(line[i - 1]!.index);
      expect(line[i]!.date >= line[i - 1]!.date).toBe(true);
    }
  });

  test('empty fit gives an empty line', () => {
    expect(frontierLine(fitFrontierIndex([], [benchmark('a')]))).toEqual([]);
  });
});

describe('frontierVelocity', () => {
  const ramp = (days: number, perDay: number, from = '2025-01-01'): FrontierPoint[] =>
    Array.from({ length: days }, (_, i) => ({
      date: addDays(from, i),
      index: 10 + i * perDay,
      release_id: `r${i}`,
      lab: 'openai' as const,
    }));

  test('a linear daily ramp gives exactly its slope in points per 30 days', () => {
    const line = ramp(366, 1 / 30);
    const v = frontierVelocity(line, '2026-01-01', 365);
    expect(v).not.toBeNull();
    expect(v!).toBeCloseTo(1, 9);
  });

  test('scales with the ramp', () => {
    expect(frontierVelocity(ramp(200, 0.1), '2025-07-01', 180)!).toBeCloseTo(3, 9);
  });

  test('a flat frontier has zero velocity', () => {
    const line: FrontierPoint[] = [
      { date: '2025-01-01', index: 50, release_id: 'a', lab: 'openai' },
      { date: '2025-03-01', index: 50.000000001, release_id: 'b', lab: 'openai' },
    ];
    expect(frontierVelocity(line, '2025-12-31', 365)!).toBeCloseTo(0, 6);
  });

  test('null when the window holds fewer than two knots', () => {
    const line: FrontierPoint[] = [
      { date: '2020-01-01', index: 40, release_id: 'a', lab: 'openai' },
      { date: '2020-06-01', index: 50, release_id: 'b', lab: 'openai' },
    ];
    expect(frontierVelocity(line, '2025-12-31', 365)).toBeNull();
    expect(frontierVelocity([], '2025-12-31')).toBeNull();
  });

  test('days before the first knot are excluded from the regression', () => {
    // Knots start halfway through the window; the pre-history must not flatten the slope.
    const line = ramp(120, 0.05, '2025-07-01');
    const withPrehistory = frontierVelocity(line, '2025-10-28', 300);
    const tight = frontierVelocity(line, '2025-10-28', 119);
    expect(withPrehistory!).toBeCloseTo(tight!, 9);
  });
});

describe('performance', () => {
  test('300 releases x 17 benchmarks fits quickly', () => {
    const next = rng(99);
    const fx = raschFixture({
      thetas: linspace(-2, 2.5, 300),
      deltas: linspace(-1.6, 1.6, 13),
      stepDays: 3,
      extraNonIndexBenchmarks: 4,
      noise: () => 0.15 * gaussian(next),
    });
    expect(fx.benchmarks).toHaveLength(17);

    fitFrontierIndex(fx.releases, fx.benchmarks); // warm up
    const t0 = performance.now();
    const fit = fitFrontierIndex(fx.releases, fx.benchmarks);
    const ms = performance.now() - t0;

    expect(Object.keys(fit.models)).toHaveLength(300);
    // Target is < 30 ms; the assertion leaves headroom for a loaded CI machine.
    expect(ms).toBeLessThan(150);
  });
});

describe('qualified flag', () => {
  test('needs MIN_QUALIFIED_SCORES index scores; provisional models never form the frontier', () => {
    const bms = [benchmark('a'), benchmark('b'), benchmark('c')];
    const releases = [
      release('q1', 'openai', '2025-01-01', [score('a', 60), score('b', 50), score('c', 40)]),
      release('p1', 'meta', '2025-02-01', [score('a', 99)]), // single score, looks like a leader
      release('q2', 'google', '2025-03-01', [score('a', 65), score('b', 55), score('c', 45)]),
    ];
    const fit = fitFrontierIndex(releases, bms);
    expect(MIN_QUALIFIED_SCORES).toBe(3);
    expect(fit.models['q1']!.qualified).toBe(true);
    expect(fit.models['p1']!.qualified).toBe(false);
    expect(fit.models['p1']!.index).toBeGreaterThan(fit.models['q2']!.index);
    expect(frontierLine(fit).map((p) => p.release_id)).toEqual(['q1', 'q2']);
    expect(frontierLine(fit, { includeProvisional: true }).map((p) => p.release_id)).toEqual(['q1', 'p1']);
  });
});

describe('anchor recentring (legacy benchmarks)', () => {
  // Three modern anchors + one easy legacy benchmark; four models, all four benchmarks.
  const build = (legacyFlag: boolean) => {
    const benches = [benchmark('a'), benchmark('b'), benchmark('c'), benchmark('old', { legacy: legacyFlag })];
    const thetas = [-1, 0, 1, 2];
    const deltas = [-0.5, 0, 0.5, -3]; // the legacy one is far easier than the anchors
    const releases = thetas.map((t, m) =>
      release(`m${m}`, 'openai', addDays('2024-01-01', m * 30), benches.map((b, i) => score(b.id, indexFromTheta(t - deltas[i]!)))),
    );
    return { benches, releases, thetas, deltas };
  };

  test('δ is centred on the non-legacy anchors only', () => {
    const fx = build(true);
    const fit = fitFrontierIndex(fx.releases, fx.benches, { ridge: 0, tolerance: 1e-14, maxIter: 500 });
    const anchorMean = (fit.difficulties.a! + fit.difficulties.b! + fit.difficulties.c!) / 3;
    expect(anchorMean).toBeCloseTo(0, 10);
    expect(fit.difficulties.old!).toBeCloseTo(-3, 6);
    // θ comes back on the anchors' scale: mean(anchor δ) was 0 in the fixture too.
    for (let m = 0; m < fx.thetas.length; m++) expect(fit.models[`m${m}`]!.theta).toBeCloseTo(fx.thetas[m]!, 6);
  });

  test('without the legacy flag the easy benchmark drags the zero (old behaviour)', () => {
    const fx = build(false);
    const fit = fitFrontierIndex(fx.releases, fx.benches, { ridge: 0, tolerance: 1e-14, maxIter: 500 });
    const allMean = fit.benchmarksInIndex.reduce((acc, id) => acc + fit.difficulties[id]!, 0) / 4;
    expect(allMean).toBeCloseTo(0, 10);
    expect(fit.models.m1!.theta).toBeCloseTo(0.75, 6); // shifted by −mean(δ) = +0.75
  });

  test('falls back to all observed benchmarks when every one is legacy', () => {
    const benches = [benchmark('x', { legacy: true }), benchmark('y', { legacy: true })];
    const releases = [0, 1].map((m) => release(`m${m}`, 'openai', addDays('2024-01-01', m * 30), [score('x', 40 + m * 10), score('y', 60 + m * 10)]));
    const fit = fitFrontierIndex(releases, benches, { ridge: 0, tolerance: 1e-14, maxIter: 500 });
    expect(fit.difficulties.x! + fit.difficulties.y!).toBeCloseTo(0, 10);
  });
});

describe('frontierPace', () => {
  const thetaRamp = (days: number, perDay: number, from = '2025-01-01'): FrontierPoint[] =>
    Array.from({ length: days }, (_, i) => ({
      date: addDays(from, i),
      index: indexFromTheta(-1 + i * perDay),
      release_id: `r${i}`,
      lab: 'openai' as const,
    }));

  test('a linear ramp in θ gives its slope in logits per year and ln2/slope doubling days', () => {
    const perDay = 0.01;
    const pace = frontierPace(thetaRamp(366, perDay), '2026-01-01', 365);
    expect(pace).not.toBeNull();
    expect(pace!.logitsPerYear).toBeCloseTo(perDay * 365, 6);
    expect(pace!.doublingDays!).toBeCloseTo(Math.LN2 / perDay, 4);
    expect(pace!.steps).toBe(366);
  });

  test('a flat frontier has no doubling time', () => {
    const line: FrontierPoint[] = [
      { date: '2025-01-01', index: 50, release_id: 'a', lab: 'openai' },
      { date: '2025-03-01', index: 50.000000001, release_id: 'b', lab: 'openai' },
    ];
    const pace = frontierPace(line, '2025-12-31', 365);
    expect(pace!.logitsPerYear).toBeCloseTo(0, 6);
    expect(pace!.doublingDays === null || pace!.doublingDays > 1e6).toBe(true);
  });

  test('null when fewer than two knots fall in the window', () => {
    expect(frontierPace([{ date: '2020-01-01', index: 40, release_id: 'a', lab: 'openai' }], '2025-12-31')).toBeNull();
    expect(frontierPace([], '2025-12-31')).toBeNull();
  });
});

describe('frontierGains', () => {
  const line: FrontierPoint[] = [
    { date: '2024-02-10', index: indexFromTheta(0), release_id: 'a', lab: 'openai' },
    { date: '2024-03-20', index: indexFromTheta(0.5), release_id: 'b', lab: 'openai' },
    { date: '2024-08-01', index: indexFromTheta(1.5), release_id: 'c', lab: 'google' },
  ];

  test('quarterly gains sum to the total θ climb after the first knot', () => {
    const gains = frontierGains(line, '2024-12-31', 3);
    expect(gains.map((g) => g.start)).toEqual(['2024-01-01', '2024-04-01', '2024-07-01', '2024-10-01']);
    expect(gains.map((g) => g.steps)).toEqual([2, 0, 1, 0]);
    expect(gains[0]!.gain).toBeCloseTo(0.5, 9); // b − a; the first knot itself is the origin
    expect(gains[1]!.gain).toBeCloseTo(0, 9);
    expect(gains[2]!.gain).toBeCloseTo(1.0, 9);
    const total = gains.reduce((acc, g) => acc + g.gain, 0);
    expect(total).toBeCloseTo(1.5, 9);
  });

  test('half-years and empty input', () => {
    expect(frontierGains([], '2024-12-31')).toEqual([]);
    const h = frontierGains(line, '2024-12-31', 6);
    expect(h.map((g) => g.start)).toEqual(['2024-01-01', '2024-07-01']);
    expect(h[0]!.gain + h[1]!.gain).toBeCloseTo(1.5, 9);
    expect(h[1]!.end).toBe('2025-01-01');
  });
});
