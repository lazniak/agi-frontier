import { describe, expect, test } from 'bun:test';
import { familyRibbon, labLineup, lineupBand, tierOf } from '../src/lineup';
import { fitFrontierIndex } from '../src/frontier-index';
import { benchmark, release, score } from './test-helpers';
import type { ModelRelease } from '../src/types';

const BMS = [benchmark('a'), benchmark('b'), benchmark('c')];

/** The fixture builder has no tier option, so set it through this thin wrapper. */
function tierRelease(
  id: string,
  lab: Parameters<typeof release>[1],
  date: string,
  scores: ReturnType<typeof score>[],
  tier?: ModelRelease['tier'],
): ModelRelease {
  const r = release(id, lab, date, scores);
  return tier === undefined ? r : { ...r, tier };
}

describe('tierOf', () => {
  test('absent tier means flagship', () => {
    expect(tierOf(release('x', 'openai', '2024-01-01', []))).toBe('flagship');
    expect(tierOf(tierRelease('x', 'openai', '2024-01-01', [], 'small'))).toBe('small');
  });
});

describe('labLineup', () => {
  const releases = [
    release('f1', 'openai', '2024-01-01', [score('a', 60), score('b', 50), score('c', 45)]),
    tierRelease('s1', 'openai', '2024-02-01', [score('a', 30), score('b', 25), score('c', 20)], 'small'),
    tierRelease('s2', 'openai', '2024-04-01', [score('a', 35), score('b', 28), score('c', 24)], 'small'),
    tierRelease('m1', 'openai', '2024-05-01', [score('a', 45), score('b', 40), score('c', 33)], 'mid'),
    tierRelease('s3', 'openai', '2025-06-01', [score('a', 40), score('b', 30), score('c', 26)], 'small'),
    release('g1', 'google', '2024-03-01', [score('a', 55), score('b', 48), score('c', 40)]),
  ];
  const fit = fitFrontierIndex(releases, BMS);

  test('latest released fitted model per tier', () => {
    const lineup = labLineup(fit, releases, 'openai', '2024-12-01');
    expect(Object.keys(lineup).sort()).toEqual(['flagship', 'mid', 'small']);
    expect(lineup.flagship!.release.id).toBe('f1');
    expect(lineup.small!.release.id).toBe('s2'); // s3 is past the cutoff
    expect(lineup.mid!.release.id).toBe('m1');
  });

  test('asOf cuts the lineup and other labs stay out', () => {
    const early = labLineup(fit, releases, 'openai', '2024-02-15');
    expect(early.flagship!.release.id).toBe('f1');
    expect(early.small!.release.id).toBe('s1');
    expect(early.mid).toBeUndefined();
    expect(labLineup(fit, releases, 'google', '2024-12-01').flagship!.release.id).toBe('g1');
  });

  test('models without fit scores never enter the lineup', () => {
    const bare: ModelRelease[] = [release('bare', 'meta', '2024-01-01', [])];
    const bareFit = fitFrontierIndex([...releases, ...bare], BMS);
    expect(labLineup(bareFit, [...releases, ...bare], 'meta', '2024-12-01')).toEqual({});
  });
});

describe('lineupBand', () => {
  test('single-tier lab: hi equals lo at every point', () => {
    const releases = [
      release('f1', 'openai', '2024-01-01', [score('a', 40), score('b', 30), score('c', 25)]),
      release('f2', 'openai', '2024-03-01', [score('a', 60), score('b', 50), score('c', 45)]),
    ];
    const fit = fitFrontierIndex(releases, BMS);
    const band = lineupBand(fit, releases, 'openai');
    expect(band.map((p) => p.date)).toEqual(['2024-01-01', '2024-03-01']);
    for (const p of band) {
      expect(p.hiTheta).toBe(p.loTheta);
      expect(p.hiId).toBe(p.loId);
    }
    expect(band[1]!.hiId).toBe('f2');
    expect(band[1]!.hiTheta).toBeGreaterThan(band[0]!.hiTheta);
  });

  test('flagship + small: lo follows the small model, hi stays on the flagship', () => {
    const releases = [
      release('f1', 'anthropic', '2024-01-01', [score('a', 60), score('b', 50), score('c', 45)]),
      tierRelease('s1', 'anthropic', '2024-02-01', [score('a', 30), score('b', 22), score('c', 18)], 'small'),
      tierRelease('s2', 'anthropic', '2024-04-01', [score('a', 35), score('b', 27), score('c', 22)], 'small'),
    ];
    const fit = fitFrontierIndex(releases, BMS);
    const band = lineupBand(fit, releases, 'anthropic');
    expect(band.map((p) => p.date)).toEqual(['2024-01-01', '2024-02-01', '2024-04-01']);

    expect(band[0]!.hiId).toBe('f1');
    expect(band[0]!.loId).toBe('f1');
    expect(band[0]!.hiTheta).toBeCloseTo(band[0]!.loTheta, 12);

    expect(band[1]!.hiId).toBe('f1');
    expect(band[1]!.loId).toBe('s1');
    expect(band[1]!.hiTheta).toBeGreaterThan(band[1]!.loTheta);

    expect(band[2]!.loId).toBe('s2');
    expect(band[2]!.hiId).toBe('f1');
    expect(band[2]!.loTheta).toBeGreaterThan(band[1]!.loTheta);
  });

  test('asOf cuts the walk; same-day releases collapse into one point', () => {
    const releases = [
      release('f1', 'google', '2024-01-01', [score('a', 40), score('b', 30), score('c', 25)]),
      tierRelease('s1', 'google', '2024-02-01', [score('a', 30), score('b', 22), score('c', 18)], 'small'),
      tierRelease('s2', 'google', '2024-02-01', [score('a', 33), score('b', 25), score('c', 20)], 'small'),
      tierRelease('s3', 'google', '2024-06-01', [score('a', 35), score('b', 27), score('c', 22)], 'small'),
    ];
    const fit = fitFrontierIndex(releases, BMS);
    const band = lineupBand(fit, releases, 'google', { asOf: '2024-03-01' });
    expect(band).toHaveLength(2); // 2024-01-01 and one collapsed point on 2024-02-01
    expect(band[1]!.date).toBe('2024-02-01');
    expect(band[1]!.loId).toBe('s2'); // later id in sort order wins the slot
    expect(band[1]!.loTheta).toBeCloseTo(fit.models['s2']!.theta, 12);
  });

  test('qualifiedOnly drops one-score models from the lineup', () => {
    const releases = [
      release('f1', 'meta', '2024-01-01', [score('a', 50), score('b', 40), score('c', 33)]),
      tierRelease('s1', 'meta', '2024-02-01', [score('a', 30)], 'small'), // 1 score -> provisional
    ];
    const fit = fitFrontierIndex(releases, BMS);
    expect(fit.models['s1']!.qualified).toBe(false);

    const full = lineupBand(fit, releases, 'meta');
    expect(full).toHaveLength(2);
    expect(full[1]!.loId).toBe('s1');

    const qualified = lineupBand(fit, releases, 'meta', { qualifiedOnly: true });
    expect(qualified).toHaveLength(1);
    expect(qualified[0]!.loId).toBe('f1');
    expect(qualified[0]!.date).toBe('2024-01-01');
  });

  test('before the first flagship the band degenerates to a line', () => {
    const releases = [
      tierRelease('s1', 'xai', '2024-01-01', [score('a', 30), score('b', 22), score('c', 18)], 'small'),
      tierRelease('s2', 'xai', '2024-03-01', [score('a', 34), score('b', 26), score('c', 21)], 'small'),
      release('f1', 'xai', '2024-05-01', [score('a', 60), score('b', 50), score('c', 45)]),
    ];
    const fit = fitFrontierIndex(releases, BMS);
    const band = lineupBand(fit, releases, 'xai');
    expect(band.map((p) => p.date)).toEqual(['2024-01-01', '2024-03-01', '2024-05-01']);
    expect(band[0]!.hiId).toBe('s1');
    expect(band[0]!.hiTheta).toBe(band[0]!.loTheta);
    expect(band[2]!.hiId).toBe('f1');
    expect(band[2]!.loId).toBe('s2');
  });
});

describe('familyRibbon', () => {
  /**
   * Ages at the 2025-05-15 knot: f1 = 500 d (evicted by the default 365-day window), f2 = 300 d
   * (still current), f3 = 0 d. θ ranks f1 > f3 > f2, so the eviction is *observable*: with the
   * window the top edge is f3, without it f1 would keep the slot for ever. Any regression that
   * stopped advancing `from` changes `hiId` here.
   */
  const releases = [
    release('f1', 'openai', '2024-01-01', [score('a', 60), score('b', 50), score('c', 45)]),
    release('f2', 'openai', '2024-07-19', [score('a', 30), score('b', 25), score('c', 20)]),
    release('f3', 'openai', '2025-05-15', [score('a', 45), score('b', 40), score('c', 33)]),
  ];
  const fit = fitFrontierIndex(releases, BMS);
  const theta = (id: string) => fit.models[id]!.theta;

  test('the fixture really is ordered f1 > f3 > f2 in θ', () => {
    expect(theta('f1')).toBeGreaterThan(theta('f3'));
    expect(theta('f3')).toBeGreaterThan(theta('f2'));
  });

  test('a model older than the window drops out of the family and gives up its edge', () => {
    const band = familyRibbon(fit, releases, 'openai', { asOf: '2025-05-15' });
    expect(band.map((p) => p.date)).toEqual(['2024-01-01', '2024-07-19', '2025-05-15']);

    // 2024-07-19: f1 is 200 days old, still current — it holds the top edge.
    expect(band[1]!.hiId).toBe('f1');
    expect(band[1]!.loId).toBe('f2');

    // 2025-05-15: f1 is 500 days old and gone; f2 is 300 days old and stays, so the family is
    // {f2, f3} and the top edge moves down from f1's θ to f3's.
    expect(band[2]!.hiId).toBe('f3');
    expect(band[2]!.loId).toBe('f2');
    expect(band[2]!.hiTheta).toBeCloseTo(theta('f3'), 12);
    expect(band[2]!.hiTheta).toBeLessThan(band[1]!.hiTheta);
  });

  test('windowDays widened past the oldest release keeps every model in the family', () => {
    const band = familyRibbon(fit, releases, 'openai', { asOf: '2025-05-15', windowDays: 600 });
    expect(band[2]!.hiId).toBe('f1'); // 500 d < 600 d, so f1 is still current
    expect(band[2]!.loId).toBe('f2');
  });

  test('a tight window evicts at the earlier knot too', () => {
    const band = familyRibbon(fit, releases, 'openai', { asOf: '2025-05-15', windowDays: 30 });
    // Every gap here is larger than 30 days, so each knot sees only its own release.
    for (const p of band) expect(p.hiId).toBe(p.loId);
    expect(band[1]!.hiId).toBe('f2');
    expect(band[2]!.hiId).toBe('f3');
  });

  test('the asOf knot collapses onto the latest model when the window has emptied', () => {
    // 2026-06-01: f2 is 682 d old and f3 382 d — nobody is inside the 365-day window, so rather
    // than vanishing the ribbon degenerates to the single latest model.
    const band = familyRibbon(fit, releases, 'openai', { asOf: '2026-06-01' });
    const last = band[band.length - 1]!;
    expect(last.date).toBe('2026-06-01');
    expect(last.hiId).toBe('f3');
    expect(last.loId).toBe('f3');
    expect(last.hiTheta).toBeCloseTo(last.loTheta, 12);
  });

  test('tiers filter and same-day collapse', () => {
    const mixed = [
      release('f1', 'google', '2024-01-01', [score('a', 60), score('b', 50), score('c', 45)]),
      tierRelease('s1', 'google', '2024-02-01', [score('a', 30), score('b', 22), score('c', 18)], 'small'),
      tierRelease('s2', 'google', '2024-02-01', [score('a', 33), score('b', 25), score('c', 20)], 'small'),
    ];
    const mixedFit = fitFrontierIndex(mixed, BMS);
    const all = familyRibbon(mixedFit, mixed, 'google', { asOf: '2024-03-01' });
    expect(all.map((p) => p.date)).toEqual(['2024-01-01', '2024-02-01', '2024-03-01']);
    expect(all[1]!.hiId).toBe('f1');
    expect(all[1]!.loId).toBe('s1'); // the weaker of the two same-day smalls

    const flagshipsOnly = familyRibbon(mixedFit, mixed, 'google', { asOf: '2024-03-01', tiers: ['flagship'] });
    expect(flagshipsOnly.map((p) => p.date)).toEqual(['2024-01-01', '2024-03-01']);
    for (const p of flagshipsOnly) expect(p.hiId).toBe('f1');
  });

  test('a lab with nothing fitted has no ribbon', () => {
    expect(familyRibbon(fit, releases, 'meta', { asOf: '2025-05-15' })).toEqual([]);
  });
});
