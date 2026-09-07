import { describe, expect, test } from 'bun:test';
import {
  benchmarkLevels,
  frontierCrossings,
  frontierFan,
  frontierTrend,
  paceEras,
  PACE_REGIMES,
  projectedEra,
  regimeOf,
  SATURATION_P,
} from '../src/stages';
import { fitFrontierIndex, frontierLine, indexFromTheta, logit, thetaFromIndex } from '../src/frontier-index';
import type { FrontierPoint } from '../src/frontier-index';
import { addDays, dateToDayNumber } from '../src/timeline';
import { benchmark, raschFixture, release, score } from './test-helpers';

/** A θ ramp as a frontier line: knot i sits `from + i` days with θ = θ0 + i·perDay. */
function thetaRamp(
  days: number, perDay: number, from = '2025-01-01', theta0 = 0, wiggle = 0,
): FrontierPoint[] {
  return Array.from({ length: days }, (_, i) => ({
    date: addDays(from, i),
    index: indexFromTheta(theta0 + i * perDay + wiggle * Math.sin(i * 1.7)),
    release_id: `r${i}`,
    lab: 'openai' as const,
  }));
}

describe('benchmarkLevels', () => {
  // One model per benchmark score, so δ is fully determined by the anchor recentring.
  const build = () => {
    const benches = [
      benchmark('gpqa', { generation: 3 }),
      benchmark('mmlu', { legacy: true, generation: 2 }),
      benchmark('arc', { generation: 4 }),
      { ...benchmark('arena', { generation: 3 }), unit: 'elo' as const, max: 4000, elo_reference: 1200 },
    ];
    // Fit first (all four observed), then read δ and build a human baseline on top.
    const releases = [
      release('m1', 'openai', '2025-01-01', [score('gpqa', 60), score('mmlu', 80), score('arc', 30), score('arena', 1300)]),
      release('m2', 'openai', '2025-06-01', [score('gpqa', 70), score('mmlu', 85), score('arc', 40), score('arena', 1350)]),
    ];
    benches[0]!.human_baseline = 80; // gpqa
    const fit = fitFrontierIndex(releases, benches);
    return { fit, benches };
  };

  test('human / saturation / generation / ceiling levels follow θ = δ + logit(p)', () => {
    const { fit, benches } = build();
    const levels = benchmarkLevels(fit, benches);
    const byId = new Map(levels.map((l) => [l.id, l]));

    const dGpqa = fit.difficulties.gpqa!;
    const human = byId.get('human:gpqa');
    expect(human).toBeDefined();
    expect(human!.theta).toBeCloseTo(dGpqa + logit(benches[0]!.human_baseline! / 100), 10);
    expect(human!.label).toBe('Human experts · gpqa 80 %');

    const dArc = fit.difficulties.arc!;
    const satArc = byId.get('sat:arc');
    expect(satArc).toBeDefined();
    expect(satArc!.theta).toBeCloseTo(dArc + logit(SATURATION_P), 10);
    expect(satArc!.label).toBe('Saturated · arc (95 %)');

    // Elo benchmarks have no saturation level.
    expect(byId.has('sat:arena')).toBe(false);

    // Generation 4 = only arc; ceiling = max saturation θ over non-legacy (gpqa, arc).
    const satGpqa = dGpqa + logit(SATURATION_P);
    expect(byId.get('gen:4')!.theta).toBeCloseTo(satArc!.theta, 10);
    const ceiling = byId.get('ceiling');
    expect(ceiling).toBeDefined();
    expect(ceiling!.theta).toBeCloseTo(Math.max(satGpqa, satArc!.theta), 10);

    for (const l of levels) expect(l.rating).toBeCloseTo(1000 + (400 / Math.LN10) * l.theta, 10);
  });

  test('levels are sorted ascending by θ and include every generation present', () => {
    const { fit, benches } = build();
    const levels = benchmarkLevels(fit, benches);
    for (let i = 1; i < levels.length; i++) expect(levels[i]!.theta).toBeGreaterThanOrEqual(levels[i - 1]!.theta);
    const gens = levels.filter((l) => l.kind === 'generation').map((l) => l.generation);
    expect(gens.length).toBeGreaterThanOrEqual(2);
    expect(byIdSafe(levels, 'gen:2')).toBeDefined();
  });

  test('a benchmark that no model reported has no saturation level', () => {
    const benches = [benchmark('seen'), benchmark('unseen')];
    const releases = [release('m1', 'openai', '2025-01-01', [score('seen', 50)])];
    const levels = benchmarkLevels(fitFrontierIndex(releases, benches), benches);
    expect(levels.filter((l) => l.benchmark === 'unseen')).toEqual([]);
    expect(levels.map((l) => l.id)).toContain('sat:seen');
  });
});

function byIdSafe(levels: { id: string }[], id: string): { id: string } | undefined {
  return levels.find((l) => l.id === id);
}

describe('frontierTrend', () => {
  test('a linear θ ramp gives exactly its slope and ~0 residual', () => {
    const perDay = 0.002;
    const start = '2025-01-01';
    const line = thetaRamp(500, perDay, start); // daily knots → the step function is exact
    const asOf = addDays(start, 499);
    const t = frontierTrend(line, asOf, 365);
    expect(t).not.toBeNull();
    expect(t!.slopePerDay).toBeCloseTo(perDay, 9);
    expect(t!.n).toBe(366); // 365-day window, both endpoints sampled (same rule as frontierPace)
    expect(t!.windowDays).toBe(365);
    expect(t!.residualSigma).toBeCloseTo(0, 6);
    expect(t!.slopeSe).toBeCloseTo(0, 6);
    expect(t!.refDay).toBe(dateToDayNumber(asOf));
    // intercept is θ at day number 0 (1970-01-01): θ(d) = intercept + slope·d must hold everywhere.
    expect(t!.intercept).toBeCloseTo(-perDay * dateToDayNumber(start), 6);
    const dAny = dateToDayNumber('2025-06-01');
    expect(t!.intercept + t!.slopePerDay * dAny).toBeCloseTo(perDay * (dAny - dateToDayNumber(start)), 9);
  });

  test('null for an empty line or a window with fewer than two knots', () => {
    expect(frontierTrend([], '2025-06-01')).toBeNull();
    const line = thetaRamp(3, 0.01, '2020-01-01');
    expect(frontierTrend(line, '2025-06-01', 365)).toBeNull();
  });
});

describe('frontierFan', () => {
  test('mid follows the ramp; the band is non-decreasing with distance', () => {
    const perDay = 0.003;
    const asOf = addDays('2025-01-01', 364);
    const line = thetaRamp(365, perDay, '2025-01-01', 0, 0.05);
    const fan = frontierFan(line, asOf, { toDate: addDays(asOf, 180), stepDays: 7, windowDays: 365 });
    expect(fan.length).toBeGreaterThanOrEqual(25);
    // The last sample lands exactly on toDate.
    expect(fan[fan.length - 1]!.date).toBe(addDays(asOf, 180));
    for (const p of fan) {
      expect(p.low).toBeLessThan(p.mid);
      expect(p.mid).toBeLessThan(p.high);
    }
    // Half-width = Z90·sqrt(σ² + (se·Δd)²) with σ, se ≈ 0 on a perfect ramp — band stays tight
    // but must never shrink as Δd grows.
    let prevHalf = -1;
    for (const p of fan) {
      const half = thetaFromIndex(p.high) - thetaFromIndex(p.mid);
      expect(half).toBeGreaterThanOrEqual(prevHalf - 1e-9);
      prevHalf = half;
    }
    // Mid continues the ramp: mid at asOf ≈ θ of the ramp there (within the noise scale).
    expect(Math.abs(thetaFromIndex(fan[0]!.mid) - perDay * 364)).toBeLessThan(0.05);
  });

  test('empty when there is no trend', () => {
    expect(frontierFan([], '2025-06-01', { toDate: '2026-06-01' })).toEqual([]);
    const line = thetaRamp(3, 0.01, '2020-01-01');
    expect(frontierFan(line, '2025-06-01', { toDate: '2026-06-01' })).toEqual([]);
  });
});

describe('frontierCrossings', () => {
  const perDay = 0.003;
  const asOf = addDays('2025-01-01', 364);
  const line = thetaRamp(365, perDay, '2025-01-01', 0, 0.05); // wiggle keeps sd > 0
  const mkLevel = (theta: number, id: string) => ({
    id, kind: 'ceiling' as const, label: id, theta, rating: 1000 + (400 / Math.LN10) * theta,
  });

  test('a level already passed is `past` with the first qualifying knot', () => {
    const monotone = thetaRamp(365, perDay); // no wiggle: strictly increasing knots
    const passedTheta = thetaFromIndex(monotone[10]!.index) - 1e-6; // knot 10 is the first at/above
    const [c] = frontierCrossings(monotone, [mkLevel(passedTheta, 'lvl-passed')], asOf);
    expect(c).toBeDefined();
    expect(c!.kind).toBe('past');
    expect(c!.date).toBe(monotone[10]!.date);
    expect(c!.release_id).toBe('r10');
    expect(c!.lab).toBe('openai');
  });

  test('a level above the frontier is `predicted` with ordered, non-past quantiles', () => {
    const above = thetaFromIndex(line[line.length - 1]!.index) + 0.3;
    const [c] = frontierCrossings(line, [mkLevel(above, 'lvl-future')], asOf);
    expect(c).toBeDefined();
    expect(c!.kind).toBe('predicted');
    const toDays = (iso: string) => Date.parse(iso) / 86_400_000;
    expect(toDays(c!.p05!)).toBeLessThan(toDays(c!.p16!));
    expect(toDays(c!.p16!)).toBeLessThan(toDays(c!.date));
    expect(toDays(c!.date)).toBeLessThan(toDays(c!.p84!));
    expect(toDays(c!.p84!)).toBeLessThan(toDays(c!.p95!));
    for (const q of [c!.p05!, c!.p16!, c!.date, c!.p84!, c!.p95!]) expect(q >= asOf).toBe(true);
    // Median should be close to (gap / slope) days after the last knot.
    const expectDays = 0.3 / perDay;
    expect(Math.abs(toDays(c!.date) - toDays(asOf) - expectDays)).toBeLessThan(30);
  });

  test('no prediction when the slope is non-positive; sorted θ ascending, past first', () => {
    const flat: FrontierPoint[] = [
      { date: '2025-01-01', index: 60, release_id: 'a', lab: 'openai' },
      { date: '2025-06-01', index: 60.0000001, release_id: 'b', lab: 'openai' },
    ];
    const below = mkLevel(thetaFromIndex(50), 'below');
    const above = mkLevel(thetaFromIndex(90), 'above');
    const cs = frontierCrossings(flat, [above, below], '2025-12-01');
    expect(cs.map((c) => c.level.id)).toEqual(['below']); // past only; no prediction on a flat line
    expect(cs[0]!.kind).toBe('past');

    const cs2 = frontierCrossings(line, [below, above], asOf);
    expect(cs2.map((c) => c.kind)).toEqual(['past', 'predicted']);
  });
});

describe('paceEras and regimes', () => {
  test('regimeOf boundaries', () => {
    expect(regimeOf(0.1)).toBe('dormant');
    expect(regimeOf(PACE_REGIMES.dormant)).toBe('climb');
    expect(regimeOf(1.4)).toBe('climb');
    expect(regimeOf(PACE_REGIMES.climb)).toBe('acceleration');
    expect(regimeOf(2.9)).toBe('acceleration');
    expect(regimeOf(PACE_REGIMES.acceleration)).toBe('takeoff');
    expect(regimeOf(10)).toBe('takeoff');
  });

  test('a pace that changes regime mid-way yields two eras, the last one open', () => {
    // θ(t) built from its derivative (one knot per day): ~0.3 logits/yr through 2024, then
    // ~1.4 from 2025. The trailing-year pace at the 2025 month grid therefore climbs out of
    // `dormant` into `climb` and every transition month stays inside `climb` (< 1.5).
    const days: FrontierPoint[] = [];
    let theta = -0.2;
    for (let i = 0; i < 731; i++) {
      theta += (i < 366 ? 0.3 : 1.4) / 365;
      days.push({
        date: addDays('2024-01-01', i),
        index: indexFromTheta(theta),
        release_id: `r${i}`,
        lab: 'openai' as const,
      });
    }
    const asOf = '2026-01-01';
    const eras = paceEras(days, asOf, { windowDays: 365 });
    expect(eras.length).toBe(2);
    expect(eras[0]!.regime).toBe('dormant');
    expect(eras[1]!.regime).toBe('climb');
    expect(eras[0]!.end).toBe(eras[1]!.start);
    expect(eras[1]!.end).toBeNull();
    expect(eras[1]!.meanPace).toBeGreaterThan(eras[0]!.meanPace);
    expect(eras[1]!.maxPace).toBeGreaterThanOrEqual(eras[1]!.meanPace);
  });

  test('projectedEra reads the trend slope; null without a trend', () => {
    const perDay = 0.01; // 3.65 logits/yr → takeoff
    const asOf = addDays('2025-01-01', 364);
    const trend = frontierTrend(thetaRamp(365, perDay), asOf);
    expect(projectedEra(trend)).toBe('takeoff');
    expect(projectedEra(null)).toBeNull();
  });
});
