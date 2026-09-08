/**
 * Benchmark lifetimes and comparability (REDESIGN §12.5).
 *
 * Benchmarks are born, live and burn out at 100 %. This module says, per benchmark, when it
 * was introduced, when the frontier saturated it and how much of the recent frontier still
 * reports it — and, per model, how many benchmarks it shares with its contemporaries, i.e. the
 * "common benchmark set" the Rasch comparison actually rests on. Pure functions, no I/O.
 */
import type { Benchmark, ISODate, ModelRelease } from './types';
import type { IndexFit } from './frontier-index';
import { tierOf } from './lineup';
import { daysBetween } from './timeline';

/** Life stage of a benchmark as of a date (REDESIGN §12.5). */
export type LifetimeState = 'fresh' | 'active' | 'saturated' | 'legacy';

/** One row of the lifetimes strip: a benchmark from introduction to saturation (or today). */
export interface BenchmarkLifetime {
  /** `Benchmark.id`. */
  benchmark: string;
  /** Year the benchmark was published (`Benchmark.introduced`). */
  introduced: number;
  /** Date of the first released model scoring it (≤ asOf), null when nobody has. */
  firstScore: ISODate | null;
  /** Number of released models (≤ asOf) reporting it, any config or reporter — one per model. */
  nScores: number;
  /**
   * First release date (≤ asOf) at which a released model's best *official* score reached
   * `SATURATION_SHARE` of the benchmark's range; null while the benchmark is alive. Elo-unit
   * benchmarks have no ceiling and never saturate.
   */
  saturatedAt: ISODate | null;
  state: LifetimeState;
  generation: number;
  /** δ_b from the fit — null when the benchmark is not in the index or no fitted model used it. */
  delta: number | null;
  weight: number;
  /** Share of the flagships released in the 12 months before `asOf` that report the benchmark (0–1). */
  coverageOfFrontier: number;
}

/** Per-model comparability: how many benchmarks it shares with its ±window contemporaries. */
export interface Comparability {
  /** Distinct index benchmarks the model was fitted on that at least one neighbour was fitted on too. */
  shared: number;
  /** Fitted flagships (other than the model itself) released within ±`windowMonths` of it. */
  neighbours: number;
}

/** A benchmark is saturated once the best official score reaches this share of its range. */
export const SATURATION_SHARE = 0.95;

/** "Fresh" = introduced within this many days of `asOf` and not yet saturated. */
export const FRESH_DAYS = 365;

/** Flagships released within this many days before `asOf` define the "current frontier" for coverage. */
export const COVERAGE_DAYS = 365;

/** Mean Gregorian month in days — how `windowMonths` becomes a day count. */
const DAYS_PER_MONTH = 365.25 / 12;

/**
 * `introduced` is a year, so the introduction date is taken as that year's midpoint: unbiased
 * for a benchmark published at an unknown month, and it keeps "within 12 months" meaningful —
 * a 2026 benchmark is fresh through mid-2027, a 2025 one stops being fresh in mid-2026.
 */
function introductionDate(year: number): ISODate {
  return `${String(year).padStart(4, '0')}-07-01`;
}

const byDateThenId = (a: ModelRelease, b: ModelRelease): number =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : a.id.localeCompare(b.id);

/**
 * Lifetimes of every benchmark as of `asOf` (REDESIGN §12.5), in the order of `benchmarks`.
 *
 * A benchmark whose introduction still lies ahead of `asOf` — the time-travel slider moved
 * behind it — is **omitted**: it does not exist at the viewed date, and nothing can be said
 * about a life that has not begun. The one exception is a benchmark that already carries a
 * score at `asOf`: `introduced` is only a year (taken at its midpoint), so a January benchmark
 * can legitimately be scored months before its nominal introduction date, and observed evidence
 * beats the curator's rounding.
 *
 * - `firstScore` / `nScores`: over released models with `date <= asOf`, any score on the
 *   benchmark (official or maintainer, any config); a model counts once.
 * - `saturatedAt`: walking releases in date order, the first whose best **official** score on a
 *   `%`-unit benchmark is ≥ `min + 0.95·(max − min)`. Official only because saturation is a
 *   statement about what the labs themselves claim; Elo never saturates.
 * - `state`: `legacy` when the curator flagged it in benchmarks.json (the same flag the fit uses
 *   to keep a benchmark out of the anchor set) — the curator's retirement beats the data;
 *   else `saturated` when `saturatedAt` is set; else `fresh` when introduced within
 *   `FRESH_DAYS` of `asOf` (mid-year of `introduced`); else `active`.
 * - `delta`: the fit's δ_b, null unless some fitted model's `used` references the benchmark
 *   (an unobserved index benchmark sits at exactly 0 and that proves nothing).
 * - `coverageOfFrontier`: flagships (tier absent ⇒ flagship) released within `COVERAGE_DAYS`
 *   before `asOf` (inclusive) that report the benchmark, over all such flagships; 0 with none.
 */
export function benchmarkLifetimes(
  fit: IndexFit,
  releases: ModelRelease[],
  benchmarks: Benchmark[],
  asOf: ISODate,
): BenchmarkLifetime[] {
  const released = releases
    .filter((r) => r.status === 'released' && r.date <= asOf)
    .slice()
    .sort(byDateThenId);
  const recentFlagships = released.filter(
    (r) => tierOf(r) === 'flagship' && daysBetween(r.date, asOf) <= COVERAGE_DAYS,
  );

  const observed = new Set<string>();
  for (const m of Object.values(fit.models)) for (const u of m.used) observed.add(u.benchmark);

  const out: BenchmarkLifetime[] = [];
  for (const b of benchmarks) {
    const range = b.max - b.min;
    const threshold = b.min + SATURATION_SHARE * range;
    const canSaturate = b.unit === '%' && range > 0;

    let firstScore: ISODate | null = null;
    let nScores = 0;
    let saturatedAt: ISODate | null = null;
    for (const r of released) {
      let reports = false;
      let bestOfficial = Number.NEGATIVE_INFINITY;
      for (const s of r.scores) {
        if (s.benchmark !== b.id) continue;
        reports = true;
        if (s.reported_by === 'official' && s.value > bestOfficial) bestOfficial = s.value;
      }
      if (!reports) continue;
      nScores++;
      if (firstScore === null) firstScore = r.date;
      if (saturatedAt === null && canSaturate && bestOfficial >= threshold) saturatedAt = r.date;
    }

    // Negative age = the benchmark is not yet born at the viewed date. Without this guard it
    // passed the `<= FRESH_DAYS` test and was reported "fresh" with no scores at all, drawing a
    // bar that starts in the future of the date the reader is looking at.
    const ageDays = daysBetween(introductionDate(b.introduced), asOf);
    if (ageDays < 0 && nScores === 0) continue;

    let state: LifetimeState;
    if (b.legacy) state = 'legacy';
    else if (saturatedAt !== null) state = 'saturated';
    else if (ageDays >= 0 && ageDays <= FRESH_DAYS) state = 'fresh';
    else state = 'active';

    const delta = observed.has(b.id) && fit.difficulties[b.id] !== undefined ? fit.difficulties[b.id]! : null;

    let covered = 0;
    for (const r of recentFlagships) if (r.scores.some((s) => s.benchmark === b.id)) covered++;
    const coverageOfFrontier = recentFlagships.length > 0 ? covered / recentFlagships.length : 0;

    out.push({
      benchmark: b.id,
      introduced: b.introduced,
      firstScore,
      nScores,
      saturatedAt,
      state,
      generation: b.generation,
      delta,
      weight: b.weight,
      coverageOfFrontier,
    });
  }
  return out;
}

/**
 * Comparability of every fitted, released model (`date <= asOf`) with its contemporaries
 * (REDESIGN §12.5): `neighbours` = the other fitted **flagships** released within
 * ±`windowMonths` (default 18) of the model's date; `shared` = the distinct index benchmarks the
 * model was fitted on (`ModelIndex.used`) that at least one neighbour was fitted on as well.
 * Every tier gets a row (a small model is compared against the flagships of its time), only
 * flagships serve as neighbours — they are the frontier the comparison is about. A model with
 * no neighbour has `shared = 0`. The benchmarks are the fit's `used` sets, not the raw score
 * lists, because that is exactly what the Rasch comparison rests on.
 */
export function comparability(
  fit: IndexFit,
  releases: ModelRelease[],
  opts: { asOf: ISODate; windowMonths?: number | undefined },
): Map<string, Comparability> {
  const windowDays = Math.round(Math.max(0, opts.windowMonths ?? 18) * DAYS_PER_MONTH);
  const rows = releases
    .filter((r) => r.status === 'released' && r.date <= opts.asOf && fit.models[r.id] !== undefined)
    .slice()
    .sort(byDateThenId);
  const usedOf = new Map<string, Set<string>>();
  for (const r of rows) usedOf.set(r.id, new Set(fit.models[r.id]!.used.map((u) => u.benchmark)));

  const out = new Map<string, Comparability>();
  for (const r of rows) {
    const mine = usedOf.get(r.id)!;
    const sharedSet = new Set<string>();
    let neighbours = 0;
    for (const other of rows) {
      if (other.id === r.id || tierOf(other) !== 'flagship') continue;
      if (Math.abs(daysBetween(r.date, other.date)) > windowDays) continue;
      neighbours++;
      for (const id of usedOf.get(other.id)!) if (mine.has(id)) sharedSet.add(id);
    }
    out.set(r.id, { shared: sharedSet.size, neighbours });
  }
  return out;
}
