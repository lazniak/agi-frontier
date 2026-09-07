import { describe, expect, test } from 'bun:test';
import {
  addDays,
  dateToDayNumber,
  dayNumberToDate,
  daysBetween,
  latestPerLab,
  leadershipStripes,
  parseISODate,
  rankCurrentFlagships,
  releasesAsOf,
  toISODate,
} from '../src/timeline';
import { fitFrontierIndex, frontierLine } from '../src/frontier-index';
import { benchmark, release, score } from './test-helpers';

const BMS = [benchmark('a'), benchmark('b')];

describe('date arithmetic', () => {
  test('round-trips and signed differences', () => {
    expect(toISODate(parseISODate('2025-03-04'))).toBe('2025-03-04');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29'); // leap year
    expect(addDays('2025-02-28', 1)).toBe('2025-03-01');
    expect(daysBetween('2025-01-01', '2025-01-31')).toBe(30);
    expect(daysBetween('2025-01-31', '2025-01-01')).toBe(-30);
    expect(dayNumberToDate(dateToDayNumber('2025-07-19'))).toBe('2025-07-19');
    expect(() => parseISODate('2025-7-19')).toThrow();
  });
});

describe('leadershipStripes', () => {
  const releases = [
    release('r1', 'openai', '2024-01-01', [score('a', 40), score('b', 30)]),
    release('r2', 'anthropic', '2024-06-01', [score('a', 55), score('b', 45)]),
    release('r3', 'google', '2024-09-01', [score('a', 41), score('b', 31)]), // never leads
    release('r4', 'xai', '2025-01-01', [score('a', 70), score('b', 60)]),
  ];
  const fit = fitFrontierIndex(releases, BMS);

  test('stripes are contiguous, ordered, and the last one is open', () => {
    const stripes = leadershipStripes(fit);
    const line = frontierLine(fit);
    expect(stripes.map((s) => s.release_id)).toEqual(line.map((p) => p.release_id));
    expect(stripes.map((s) => s.lab)).toEqual(['openai', 'anthropic', 'xai']);
    expect(stripes[0]!.from).toBe('2024-01-01');
    expect(stripes[0]!.to).toBe('2024-06-01');
    expect(stripes[1]!.from).toBe('2024-06-01');
    expect(stripes[1]!.to).toBe('2025-01-01');
    expect(stripes[2]!.to).toBeNull();
    for (let i = 1; i < stripes.length; i++) {
      expect(stripes[i - 1]!.to).toBe(stripes[i]!.from);
      expect(stripes[i]!.index).toBeGreaterThan(stripes[i - 1]!.index);
    }
  });

  test('empty fit gives no stripes', () => {
    expect(leadershipStripes(fitFrontierIndex([], BMS))).toEqual([]);
  });
});

describe('rankCurrentFlagships', () => {
  const releases = [
    release('openai-old', 'openai', '2024-01-01', [score('a', 90), score('b', 85)]),
    release('openai-new', 'openai', '2025-01-01', [score('a', 60), score('b', 50)]),
    release('anthropic-1', 'anthropic', '2024-11-01', [score('a', 80), score('b', 70)]),
    release('google-1', 'google', '2024-12-01', [score('a', 75), score('b', 65)]),
    // No index scores at all → never fitted, so the lab drops out of the ranking.
    release('meta-1', 'meta', '2024-12-15', []),
    // Not yet released as of the cut-off.
    release('xai-1', 'xai', '2025-06-01', [score('a', 99), score('b', 98)]),
  ];
  const fit = fitFrontierIndex(releases, BMS, { asOf: '2025-03-01' });

  test('one row per lab, latest release, sorted by index descending', () => {
    const rows = rankCurrentFlagships(fit, releases, '2025-03-01');
    expect(rows.map((r) => r.release_id)).toEqual(['anthropic-1', 'google-1', 'openai-new']);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.index).toBeGreaterThanOrEqual(rows[i]!.index);
    }
    // openai-old is stronger but superseded — the ranking shows current flagships only.
    expect(rows.some((r) => r.release_id === 'openai-old')).toBe(false);
    expect(rows.some((r) => r.lab === 'meta')).toBe(false);
    expect(rows.some((r) => r.lab === 'xai')).toBe(false);
  });

  test('time-scrubbing back changes the ranking', () => {
    const early = fitFrontierIndex(releases, BMS, { asOf: '2024-06-01' });
    const rows = rankCurrentFlagships(early, releases, '2024-06-01');
    expect(rows.map((r) => r.release_id)).toEqual(['openai-old']);
  });
});

describe('releasesAsOf / latestPerLab', () => {
  const releases = [
    release('openai-a', 'openai', '2024-01-01', []),
    release('openai-b', 'openai', '2024-05-01', []),
    release('anthropic-a', 'anthropic', '2024-03-01', []),
    release('meta-a', 'meta', '2024-04-01', [], { status: 'announced' }),
  ];

  test('filters by status and date and sorts deterministically', () => {
    expect(releasesAsOf(releases, '2024-04-01').map((r) => r.id)).toEqual(['openai-a', 'anthropic-a']);
    expect(releasesAsOf(releases, '2024-12-01', ['released', 'announced']).map((r) => r.id)).toEqual([
      'openai-a',
      'anthropic-a',
      'meta-a',
      'openai-b',
    ]);
  });

  test('latest per lab', () => {
    const latest = latestPerLab(releases, '2024-12-01');
    expect(latest.get('openai')!.id).toBe('openai-b');
    expect(latest.get('anthropic')!.id).toBe('anthropic-a');
    expect(latest.has('meta')).toBe(false);
  });
});
