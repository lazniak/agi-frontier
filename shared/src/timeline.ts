import type { ISODate, LabId, ModelRelease, ReleaseStatus } from './types';
import type { IndexFit, ModelIndex } from './frontier-index';

const DAY_MS = 86_400_000;

/** Parse `YYYY-MM-DD` as a UTC midnight Date. Throws on malformed input. */
export function parseISODate(s: ISODate): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`Bad ISO date: ${s}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export function toISODate(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function todayISO(now: Date = new Date()): ISODate {
  return toISODate(now);
}

export function addDays(iso: ISODate, days: number): ISODate {
  return toISODate(new Date(parseISODate(iso).getTime() + Math.round(days) * DAY_MS));
}

/** Signed whole days from `a` to `b` (b − a). */
export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((parseISODate(b).getTime() - parseISODate(a).getTime()) / DAY_MS);
}

export function daysSince(iso: ISODate, asOf: ISODate): number {
  return daysBetween(iso, asOf);
}

/** Fractional days between two ISO dates, for continuous math. */
export function dateToDayNumber(iso: ISODate): number {
  return parseISODate(iso).getTime() / DAY_MS;
}

export function dayNumberToDate(day: number): ISODate {
  return toISODate(new Date(Math.round(day) * DAY_MS));
}

/** Releases visible at `asOf`: `date <= asOf` and status in `statuses` (default: released only). */
export function releasesAsOf(
  releases: ModelRelease[],
  asOf: ISODate,
  statuses: ReleaseStatus[] = ['released'],
): ModelRelease[] {
  const set = new Set(statuses);
  return releases
    .filter((r) => set.has(r.status) && r.date <= asOf)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id.localeCompare(b.id)));
}

/** Latest released flagship per lab as of `asOf`. */
export function latestPerLab(releases: ModelRelease[], asOf: ISODate): Map<LabId, ModelRelease> {
  const out = new Map<LabId, ModelRelease>();
  for (const r of releasesAsOf(releases, asOf)) out.set(r.lab, r); // sorted ascending → last write wins
  return out;
}

export interface LeadershipStripe {
  from: ISODate;
  /** null = still leading at the end of the fitted data. */
  to: ISODate | null;
  lab: LabId;
  release_id: string;
  index: number;
}

/**
 * Who held the top Frontier Index and for how long. Consecutive stripes are contiguous;
 * a new stripe starts only when a release beats the current leader.
 * Implemented by the shared-math task.
 */
export function leadershipStripes(fit: IndexFit): LeadershipStripe[] {
  void fit;
  throw new Error('not implemented: leadershipStripes');
}

/**
 * Current flagships (latest released per lab as of `asOf`) with their index, sorted descending.
 * Labs without a fitted model are omitted. Implemented by the shared-math task.
 */
export function rankCurrentFlagships(fit: IndexFit, releases: ModelRelease[], asOf: ISODate): ModelIndex[] {
  void fit; void releases; void asOf;
  throw new Error('not implemented: rankCurrentFlagships');
}
