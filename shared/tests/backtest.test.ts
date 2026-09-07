import { describe, expect, test } from 'bun:test';
import { backtestAsOf, backtestSeries } from '../src/backtest';
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
