import { describe, expect, test } from 'bun:test';
import { RATING_PER_LOGIT, evidenceOf, rankTies, ratingMargin } from '../src/index';
import type { ModelIndex } from '../src/index';

/** A ModelIndex with only the fields the ranking cares about. */
function mi(id: string, rating: number, se: number, used: { benchmark: string }[] = []): ModelIndex {
  return {
    release_id: id,
    lab: 'openai',
    date: '2026-01-01',
    theta: (rating - 1000) / RATING_PER_LOGIT,
    index: 50,
    se,
    indexLow: 40,
    indexHigh: 60,
    tier: 'flagship',
    rating,
    n: used.length,
    coverage: 0.5,
    qualified: used.length >= 3,
    used: used.map((u) => ({
      benchmark: u.benchmark,
      value: 50,
      predicted: 50,
      residual: 0,
      reported_by: 'official' as const,
    })),
  };
}

/** se in logits that produces the given rating half-width. */
const seFor = (margin: number): number => margin / RATING_PER_LOGIT;

describe('rankTies', () => {
  test('models the data cannot separate share one rank', () => {
    // The measured case from REDESIGN §12.9: 1298 ± 36, 1292 ± 72, 1269 ± 51.
    const groups = rankTies([
      mi('gemini', 1298, seFor(36)),
      mi('glm', 1292, seFor(72)),
      mi('kimi', 1269, seFor(51)),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rank).toBe(1);
    expect(groups[0]!.tied).toBe(true);
    expect(groups[0]!.members.map((m) => m.release_id)).toEqual(['gemini', 'glm', 'kimi']);
  });

  test('a clearly better model keeps its own rank', () => {
    const groups = rankTies([mi('astra', 1517, seFor(59)), mi('fable', 1367, seFor(59))]);
    expect(groups.map((g) => [g.rank, g.tied, g.members.length])).toEqual([
      [1, false, 1],
      [2, false, 1],
    ]);
  });

  test('the rank of a group is the position of its first member, so ranks skip', () => {
    const groups = rankTies([
      mi('a', 1500, seFor(5)),
      mi('b', 1400, seFor(30)),
      mi('c', 1390, seFor(30)),
      mi('d', 1200, seFor(5)),
    ]);
    expect(groups.map((g) => g.rank)).toEqual([1, 2, 4]);
    expect(groups[1]!.members.map((m) => m.release_id)).toEqual(['b', 'c']);
  });

  test('a wide interval cannot swallow the tail: ties are judged against the group leader', () => {
    // c overlaps b (b's low 1465 <= c's high 1475), but not the leader a (low 1480), so the
    // chain stops instead of dragging the rest of the table into rank 1.
    const groups = rankTies([
      mi('a', 1500, seFor(20)),
      mi('b', 1485, seFor(20)),
      mi('c', 1455, seFor(20)),
      mi('d', 1440, seFor(20)),
    ]);
    expect(groups[0]!.members.map((m) => m.release_id)).toEqual(['a', 'b']);
    expect(groups[1]!.rank).toBe(3);
    expect(groups[1]!.members.map((m) => m.release_id)).toEqual(['c', 'd']);
  });

  test('a zero-width interval never ties with a strictly lower rating', () => {
    const groups = rankTies([mi('a', 1300, 0), mi('b', 1299.9, 0)]);
    expect(groups).toHaveLength(2);
  });

  test('an empty table produces no groups', () => {
    expect(rankTies([])).toEqual([]);
  });

  test('ratingMargin converts the standard error to rating points', () => {
    expect(ratingMargin({ se: seFor(36) })).toBeCloseTo(36, 6);
    expect(ratingMargin({ se: seFor(36) }, 2)).toBeCloseTo(72, 6);
  });
});

describe('evidenceOf', () => {
  const community = new Set(['lmarena-text']);

  test('a rating resting on one community Elo score is labelled as such', () => {
    const e = evidenceOf(mi('grok', 1400, 0.1, [{ benchmark: 'lmarena-text' }]), community);
    expect(e.kind).toBe('community-only');
    expect(e.label).toBe('community Elo only');
    expect(e.n).toBe(1);
  });

  test('official test scores carry no warning label', () => {
    const e = evidenceOf(
      mi('astra', 1517, 0.3, [{ benchmark: 'hle' }, { benchmark: 'arc-agi-2' }, { benchmark: 'gpqa-diamond' }]),
      community,
    );
    expect(e.kind).toBe('official');
    expect(e.label).toBe('');
    expect(e.community).toBe(0);
  });

  test('a mix of official and community scores counts both and stays unlabelled', () => {
    const e = evidenceOf(
      mi('kimi', 1269, 0.3, [{ benchmark: 'hle' }, { benchmark: 'lmarena-text' }]),
      community,
    );
    expect(e.kind).toBe('mixed');
    expect(e.n).toBe(2);
    expect(e.community).toBe(1);
    expect(e.label).toBe('');
  });

  test('several community scores and nothing else are still community-only', () => {
    const e = evidenceOf(
      mi('x', 1200, 0.3, [{ benchmark: 'lmarena-text' }, { benchmark: 'lmarena-vision' }]),
      new Set(['lmarena-text', 'lmarena-vision']),
    );
    expect(e.kind).toBe('community-only');
    expect(e.label).toBe('community scores only');
  });

  test('a model the fit could not use reports no evidence', () => {
    expect(evidenceOf(mi('x', 1000, 1), community).kind).toBe('none');
  });
});
