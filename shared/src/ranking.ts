/**
 * Honest ranking (REDESIGN §12.9).
 *
 * A league table ordered by a point estimate reads as an order even where the evidence cannot
 * supply one. Measured on 2026-09-08, the top of this chart was exactly that case: Gemini 3.1 Pro
 * at 1298 ± 36 sat above GLM-5.3 at 1292 ± 72 and Kimi K3 at 1269 ± 51 — three models the data
 * cannot separate, printed as ranks 1, 2 and 3. The cause was not the estimator but the evidence:
 * models released in 2026-H2 carried a mean of 2.6 index benchmarks against 5.5 in the half-year
 * before, and some carried a community Elo score and nothing else.
 *
 * So the table keeps its order — any other order invites a different complaint — and says out
 * loud where that order is not supported: models that cannot be told apart share one rank, and a
 * row's evidence is reported alongside its rating rather than buried in a coverage percentage.
 */
import { RATING_PER_LOGIT } from './rating';
import type { ModelIndex } from './frontier-index';

/** One rank of the table: a single model, or several the data cannot separate. */
export interface TieGroup {
  /** 1-based rank shown for the whole group (the position of its first member). */
  rank: number;
  /** Members in the incoming order (descending rating). */
  members: ModelIndex[];
  /** True when the group holds more than one model. */
  tied: boolean;
}

/** Nominal coverage of the interval used to decide a tie. 1 se ≈ 68 %. */
export const TIE_Z = 1;

/** Half-width of a model's rating interval, in rating points. */
export function ratingMargin(m: Pick<ModelIndex, 'se'>, z = TIE_Z): number {
  return z * RATING_PER_LOGIT * m.se;
}

/**
 * Group a rating-sorted list into ranks, merging models whose rating intervals overlap.
 *
 * A model joins the current group while its upper bound still reaches the *group leader's* lower
 * bound. Comparing against the leader rather than the previous member matters: chained
 * comparisons are not transitive, so "each overlaps the one above" would let a single wide
 * interval swallow an arbitrarily long tail of the table. Comparing to the leader asks the
 * question a reader actually has — "is this distinguishable from the best of this rank?" — and
 * keeps groups bounded.
 *
 * `models` must already be sorted by descending rating; the order is preserved verbatim.
 */
export function rankTies(models: ModelIndex[], z = TIE_Z): TieGroup[] {
  const groups: TieGroup[] = [];
  let leaderLow = Number.POSITIVE_INFINITY;
  let current: TieGroup | null = null;

  models.forEach((m, i) => {
    const high = m.rating + ratingMargin(m, z);
    if (current === null || high < leaderLow) {
      current = { rank: i + 1, members: [m], tied: false };
      leaderLow = m.rating - ratingMargin(m, z);
      groups.push(current);
      return;
    }
    current.members.push(m);
    current.tied = true;
  });

  return groups;
}

/** What a row's rating actually rests on. */
export type EvidenceKind = 'official' | 'mixed' | 'community-only' | 'none';

export interface Evidence {
  kind: EvidenceKind;
  /** Index benchmarks used by the fit. */
  n: number;
  /** How many of them are community benchmarks (LMArena and the like). */
  community: number;
  /** Short, honest label for the UI; empty for a well-evidenced row. */
  label: string;
}

/**
 * Classify what a model's rating rests on. A single community Elo score is a different kind of
 * claim from three official test results, and the existing "provisional" flag (fewer than three
 * benchmarks) does not distinguish them — Grok 4.6's rating came from LMArena alone.
 *
 * `communityBenchmarks` is the set of benchmark ids flagged `community` in benchmarks.json.
 */
export function evidenceOf(m: Pick<ModelIndex, 'used'>, communityBenchmarks: ReadonlySet<string>): Evidence {
  const n = m.used.length;
  const community = m.used.filter((u) => communityBenchmarks.has(u.benchmark)).length;
  if (n === 0) return { kind: 'none', n, community, label: 'no index benchmarks' };
  if (community === n) {
    return {
      kind: 'community-only',
      n,
      community,
      label: n === 1 ? 'community Elo only' : 'community scores only',
    };
  }
  if (community > 0) return { kind: 'mixed', n, community, label: '' };
  return { kind: 'official', n, community, label: '' };
}
