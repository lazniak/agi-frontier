import type { ISODate, LabId, ModelRelease, ReleaseStatus } from './types';
import type { IndexFit, ModelIndex } from './frontier-index';
import { frontierLine } from './frontier-index';

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
  const knots = frontierLine(fit);
  return knots.map((k, i) => ({
    from: k.date,
    to: i + 1 < knots.length ? knots[i + 1]!.date : null,
    lab: k.lab,
    release_id: k.release_id,
    index: k.index,
  }));
}

/**
 * Current flagships (latest released per lab as of `asOf`) with their index, sorted descending.
 * Labs without a fitted model are omitted. Implemented by the shared-math task.
 */
export function rankCurrentFlagships(fit: IndexFit, releases: ModelRelease[], asOf: ISODate): ModelIndex[] {
  const out: ModelIndex[] = [];
  for (const r of latestPerLab(releases, asOf).values()) {
    const m = fit.models[r.id];
    if (m) out.push(m); // labs whose flagship has no official index score are omitted
  }
  // Qualified flagships first (by index), then provisional ones (by index).
  return out.sort((a, b) => Number(b.qualified) - Number(a.qualified) || (b.index - a.index) || a.release_id.localeCompare(b.release_id));
}
