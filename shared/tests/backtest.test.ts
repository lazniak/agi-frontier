import { describe, expect, test } from 'bun:test';
import { backtestAsOf, backtestSeries, calibrateForecast } from '../src/backtest';
import { fitFrontierIndex } from '../src/frontier-index';
import { addDays } from '../src/timeline';
import { benchmark, release, score } from './test-helpers';
import { LAB_IDS } from '../src/schema';
import type { LabId, ModelRelease } from '../src/types';

const BMS = [benchmark('a'), benchmark('b'), benchmark('c')];

/**
 * A perfectly regular lab: a flagship release every 90 days, ability climbing linearly.
 * A well-calibrated forecast of a deterministic process must put every actual inside the
 * 90 % window and most of them inside the 68 % one.
 */
function regularLab(extra: ModelRelease[] = []): ModelRelease[] {
  const out: ModelRelease[] = [];
  for (let i = 0; i < 8; i++) {
    out.push(
      release(`reg-m${i}`, 'openai', addDays('2023-01-01', i * 90), [
        score('a', 40 + 4 * i),
        score('b', 32 + 4 * i),
        score('c', 26 + 4 * i),
      ]),
    );
  }
  return [...out, ...extra];
}

describe('backtestAsOf', () => {
  test('matches the k = 1 prediction against the next actual flagship', () => {
    const releases = regularLab();
    const fit = fitFrontierIndex(releases, BMS, { asOf: '2023-03-01' });
    const { rows } = backtestAsOf(releases, BMS, ['openai'], '2023-03-01', { todayFit: fit });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.asOf).toBe('2023-03-01');
    expect(row.lab).toBe('openai');
    expect(row.predictedMedian).not.toBeNull();
    expect(row.actual).not.toBeNull();
    expect(row.actual!.release_id).toBe('reg-m1'); // next flagship after 2023-03-01 (m1 = +90 d)
    expect(row.errorDays).not.toBeNull();
    expect(row.in68).toBe(true); // deterministic process, tight window
    expect(row.in90).toBe(true);
  });

  test('a lab with no later release yields actual null and null coverage fields', () => {
    const releases = regularLab();
    const fit = fitFrontierIndex(releases, BMS, { asOf: '2024-10-01' });
    const { rows } = backtestAsOf(releases, BMS, ['openai'], '2024-10-01', { todayFit: fit });
    const row = rows[0]!;
    expect(row.actual).toBeNull();
    expect(row.errorDays).toBeNull();
    expect(row.in68).toBeNull();
    expect(row.in90).toBeNull();
    expect(row.thetaError).toBeNull();
    expect(row.predictedMedian).not.toBeNull(); // the prediction itself still exists
  });
});

describe('backtestSeries — regular lab', () => {
  const releases = regularLab();
  const to = '2025-01-01';
  const report = backtestSeries(releases, BMS, ['openai'], { to, stepDays: 30 });

  test('every actual lands inside the 90 percent window, most inside 68', () => {
    expect(report.n).toBeGreaterThan(0);
    expect(report.coverage90).toBe(1);
    expect(report.coverage68).toBeGreaterThanOrEqual(0.5);
  });

  test('errors are small for a perfectly regular cadence', () => {
    expect(report.maeDays).toBeLessThan(30);
    expect(report.medianAbsDays).toBeLessThan(30);
    expect(Math.abs(report.biasDays)).toBeLessThan(30);
  });

  test('calibration is monotone non-decreasing in the nominal level', () => {
    expect(report.calibration.map((c) => c.nominal)).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
    for (let i = 1; i < report.calibration.length; i++) {
      expect(report.calibration[i]!.observed).toBeGreaterThanOrEqual(
        report.calibration[i - 1]!.observed - 1e-12,
      );
    }
    expect(report.calibration[0]!.observed).toBeGreaterThanOrEqual(0);
    expect(report.calibration[8]!.observed).toBeLessThanOrEqual(1);
  });

  test('grid, report shape and lab aggregation', () => {
    expect(report.from).toBe(addDays('2023-01-01', 365));
    expect(report.stepDays).toBe(30);
    expect(report.rows.every((r) => r.asOf >= report.from && r.asOf <= addDays(to, -30))).toBe(true);
    expect(Object.keys(report.byLab)).toEqual(['openai']);
    expect(report.byLab['openai']!.n).toBe(report.n);
    expect(report.thetaMae).not.toBeNull();
  });

  test('deterministic: the same input twice gives deep-equal reports', () => {
    const again = backtestSeries(releases, BMS, ['openai'], { to, stepDays: 30 });
    expect(JSON.stringify(again)).toBe(JSON.stringify(report));
  });
});

describe('backtestSeries — empty and mixed inputs', () => {
  test('a lab with no later release is excluded from n and coverage', () => {
    // A single-release lab stops producing actuals once the grid passes its last release.
    const solo = release('solo-m0', 'mistral', '2023-06-01', [
      score('a', 50),
      score('b', 42),
      score('c', 35),
    ]);
    const releases = [solo];
    // Grid starts at first flagship + 365 d = 2024-06-01; to = 2025-06-01 leaves grid room.
    const report = backtestSeries(releases, BMS, ['mistral'], { to: '2025-06-01', stepDays: 30 });
    expect(report.n).toBe(0);
    expect(report.coverage68).toBe(0);
    expect(report.coverage90).toBe(0);
    expect(report.maeDays).toBe(0);
    expect(report.thetaMae).toBeNull();
    expect(report.byLab['mistral']!.n).toBe(0);
    // rows exist but all carry actual null
    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.rows.every((r) => r.actual === null)).toBe(true);
  });

  test('non-flagship releases are never the actual', () => {
    const small: ModelRelease = {
      ...release('reg-s', 'openai', '2023-04-15', [score('a', 55), score('b', 47), score('c', 40)]),
      tier: 'small',
    };
    const releases = regularLab([small]);
    const { rows } = backtestAsOf(releases, BMS, ['openai'], '2023-03-01', {});
    expect(rows[0]!.actual!.release_id).toBe('reg-m1'); // not the small tier model
  });

  test('runs across every known lab without throwing', () => {
    const releases = regularLab();
    const report = backtestSeries(releases, BMS, [...LAB_IDS] as LabId[], { to: '2024-06-01', stepDays: 60 });
    expect(Object.keys(report.byLab).sort()).toEqual([...LAB_IDS].sort());
    expect(report.calibration).toHaveLength(9);
  });
});

/* ------------------------------------------------------- T31 iteration 2 additions */

describe('backtestSeries — forecastable rows only (T31 it. 2)', () => {
  test('a lab whose first release is after the grid start feeds unforecastable, not n', () => {
    // Regular openai releases 2023-…; mistral releases only from 2024-09-01, i.e. after the
    // grid start (2023-01-01 + 365 d = 2024-01-01): early mistral rows have no prediction.
    const late = [
      release('late-m0', 'mistral', '2024-09-01', [score('a', 50), score('b', 42), score('c', 35)]),
      release('late-m1', 'mistral', '2024-12-01', [score('a', 55), score('b', 47), score('c', 40)]),
    ];
    const releases = [...regularLab(), ...late];
    const report = backtestSeries(releases, BMS, ['openai', 'mistral'], { to: '2025-01-01', stepDays: 30 });
    expect(report.unforecastable).toBeGreaterThan(0);
    // n counts exactly the rows with both a prediction and an actual
    expect(report.n).toBe(
      report.rows.filter((r) => r.predictedMedian !== null && r.actual !== null).length,
    );
    // rows with an actual but no prediction are exactly the unforecastable set
    expect(report.rows.filter((r) => r.actual !== null && r.predictedMedian === null).length).toBe(
      report.unforecastable,
    );
    // mistral rows before its first release are the unforecastable ones
    expect(report.byLab['mistral']!.n).toBeGreaterThan(0);
  });

  test('the report records sigmaScale and halfLifeDays', () => {
    const releases = regularLab();
    const r1 = backtestSeries(releases, BMS, ['openai'], { to: '2024-06-01' });
    expect(r1.sigmaScale).toBe(1);
    expect(r1.halfLifeDays).toBe(730);
    const r2 = backtestSeries(releases, BMS, ['openai'], {
      to: '2024-06-01',
      sigmaScale: 1.5,
      halfLifeDays: Infinity,
    });
    expect(r2.sigmaScale).toBe(1.5);
    expect(r2.halfLifeDays).toBe(Infinity);
  });

  test('shared fitCache gives identical reports and calibrateForecast picks the low-loss scale', () => {
    const releases = regularLab();
    const plain = backtestSeries(releases, BMS, ['openai'], { to: '2024-06-01' });
    const cached = backtestSeries(releases, BMS, ['openai'], {
      to: '2024-06-01',
      fitCache: new Map(),
    });
    expect(JSON.stringify(cached)).toBe(JSON.stringify(plain));

    // scale > 1 widens the windows; on this deterministic fixture coverage is already 1,
    // so the loss is minimal at the smallest scale (1.0) — ties keep the smaller scale.
    const cal = calibrateForecast(releases, BMS, ['openai'], { to: '2024-06-01', stepDays: 60 });
    expect(cal.sigmaScale).toBe(1.0);
    expect(cal.report.sigmaScale).toBe(1.0);
    const expectedLoss = Math.abs(cal.report.coverage68 - 0.68) + Math.abs(cal.report.coverage90 - 0.9);
    expect(cal.loss).toBeCloseTo(expectedLoss, 12);
  });
});

describe('calibrateForecast — synthetic under-coverage (T31 it. 2)', () => {
  // A lab that speeds up steadily (each gap ~0.78x the previous). A stationary unweighted
  // log-normal over-reacts to the early long gaps: actuals land before p16, so scale 1
  // under-covers hard, while scale 2 covers the 90 % window. Built by hand, deterministic.
  function acceleratingLab(): ModelRelease[] {
    const gaps: number[] = [];
    let g = 200;
    for (let i = 0; i < 14; i++) {
      gaps.push(Math.round(g));
      g *= 0.78;
    }
    let d = '2022-01-01';
    const out: ModelRelease[] = [];
    gaps.forEach((gg, i) => {
      const scores = [score('a', 40 + 3 * i), score('b', 32 + 3 * i), score('c', 26 + 3 * i)];
      out.push(release(`acc-m${i}`, 'openai', d, scores));
      d = addDays(d, gg);
    });
    out.push(release('acc-m14', 'openai', d, [score('a', 82), score('b', 74), score('c', 68)]));
    return out;
  }

  const releases = acceleratingLab();
  const to = '2027-01-01';

  test('scale 1 under-covers, scale 2 covers the 90 percent window', () => {
    const s1 = backtestSeries(releases, BMS, ['openai'], {
      to, stepDays: 30, sigmaScale: 1, halfLifeDays: Infinity,
    });
    expect(s1.n).toBeGreaterThan(5);
    expect(s1.coverage90).toBeLessThan(0.5);
    const s2 = backtestSeries(releases, BMS, ['openai'], {
      to, stepDays: 30, sigmaScale: 2, halfLifeDays: Infinity,
    });
    expect(s2.coverage90).toBe(1);
  });

  test('returns the scale with the smallest loss (ties keep the smaller scale)', () => {
    const cal = calibrateForecast(releases, BMS, ['openai'], { to, stepDays: 30, halfLifeDays: Infinity });
    let bestLoss = Number.POSITIVE_INFINITY;
    let bestScale = Number.NaN;
    for (let k = 10; k <= 30; k++) {
      const r = backtestSeries(releases, BMS, ['openai'], {
        to,
        stepDays: 30,
        halfLifeDays: Infinity,
        sigmaScale: k / 10,
      });
      const loss = Math.abs(r.coverage68 - 0.68) + Math.abs(r.coverage90 - 0.9);
      if (loss < bestLoss) {
        bestLoss = loss;
        bestScale = k / 10;
      }
    }
    expect(cal.sigmaScale).toBe(bestScale);
    expect(cal.loss).toBeCloseTo(bestLoss, 12);
    expect(cal.report.sigmaScale).toBe(bestScale);
  });
});
