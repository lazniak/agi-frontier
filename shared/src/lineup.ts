/**
 * Family bands (REDESIGN §3): a lab's lineup over time, from its flagship on top to the
 * smallest current tier below. Pure functions; consumed by the chart band layer.
 */
import type { BandPoint, ISODate, LabId, ModelRelease, ModelTier } from './types';
import type { IndexFit, ModelIndex } from './frontier-index';
import { daysBetween } from './timeline';

export const ALL_TIERS: ModelTier[] = ['flagship', 'mid', 'small'];

/** A release's tier; `tier` absent on the release means `flagship` (REDESIGN §3). */
export function tierOf(r: ModelRelease): ModelTier {
  return r.tier ?? 'flagship';
}

/**
 * Latest *released* model per tier as of `asOf` (REDESIGN §3): for each tier the newest
 * release with `date <= asOf` that the fit scored; ties on date break by id (last wins).
 * A lab's lineup is therefore at most one model per tier — the current one.
 */
export function labLineup(
  fit: IndexFit,
  releases: ModelRelease[],
  lab: LabId,
  asOf: ISODate,
): Partial<Record<ModelTier, { release: ModelRelease; mi: ModelIndex }>> {
  const out: Partial<Record<ModelTier, { release: ModelRelease; mi: ModelIndex }>> = {};
  const rows = releases
    .filter(
      (r) => r.lab === lab && r.status === 'released' && r.date <= asOf && fit.models[r.id] !== undefined,
    )
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id.localeCompare(b.id)));
  for (const r of rows) out[tierOf(r)] = { release: r, mi: fit.models[r.id]! };
  return out;
}

/**
 * The lab's lineup band as a step series (REDESIGN §3): at every date the lineup changes,
 * emit `{ date, hiTheta, loTheta, hiId, loId }` — hi is the current flagship's θ, lo the
 * minimum θ over the current lineup (all tiers). One tier ever ⇒ hi = lo (just the line).
 * Same-day releases collapse into one point (the later id in sort order wins the slot).
 */
export function lineupBand(
  fit: IndexFit,
  releases: ModelRelease[],
  lab: LabId,
  opts: { asOf?: ISODate | undefined; qualifiedOnly?: boolean } = {},
): BandPoint[] {
  const asOf = opts.asOf;
  const qualifiedOnly = opts.qualifiedOnly ?? false;

  const rows = releases
    .filter(
      (r) =>
        r.lab === lab &&
        r.status === 'released' &&
        (asOf === undefined || r.date <= asOf) &&
        fit.models[r.id] !== undefined &&
        (!qualifiedOnly || fit.models[r.id]!.qualified),
    )
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id.localeCompare(b.id)));

  const out: BandPoint[] = [];
  // Current lineup state: per tier the latest model seen so far (date-then-id order).
  const state = new Map<ModelTier, { theta: number; id: string }>();
  const emit = (date: ISODate): void => {
    // hi = the current flagship's θ; lo = min θ over the whole lineup (all tiers).
    // Before the lab's first flagship, the band degenerates to a line at the lineup max.
    const flagship = state.get('flagship');
    let hiTheta = Number.NEGATIVE_INFINITY;
    let hiId = '';
    let loTheta = Number.POSITIVE_INFINITY;
    let loId = '';
    for (const t of ALL_TIERS) {
      const e = state.get(t);
      if (!e) continue;
      if (flagship !== undefined ? t === 'flagship' : e.theta > hiTheta) {
        hiTheta = e.theta;
        hiId = e.id;
      }
      if (e.theta < loTheta) {
        loTheta = e.theta;
        loId = e.id;
      }
    }
    if (hiId !== '' && loId !== '') out.push({ date, hiTheta, loTheta, hiId, loId });
  };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const mi = fit.models[r.id]!;
    state.set(tierOf(r), { theta: mi.theta, id: r.id });
    // Same-day releases collapse into one point (REDESIGN §3): emit once, after the last
    // row of that date — the later id in sort order has then won each tier slot.
    const nextSameDay = i + 1 < rows.length && rows[i + 1]!.date === r.date;
    if (!nextSameDay) emit(r.date);
  }
  return out;
}

/** Options of {@link familyRibbon}. */
export interface FamilyRibbonOptions {
  /** Only releases with `date <= asOf` count; the ribbon is also extended to this date. */
  asOf?: ISODate | undefined;
  /** How long a release stays in the "current family" after its launch (default 365 days). */
  windowDays?: number | undefined;
  /** Lineup tiers that may enter the family (default all three). */
  tiers?: ModelTier[] | undefined;
}

/**
 * Real-data family ribbon (REDESIGN §12.3): a filled band per lab through time whose edges are
 * the best and the weakest member of the lab's *current family*.
 *
 * At every date `t` in the lab's release dates (≤ `asOf`, same-day launches collapsing into
 * one knot) the current family is every released, fitted model of the lab in `tiers` with
 * `t − windowDays ≤ date ≤ t`; `hiTheta` / `loTheta` are the max / min θ over that set (ids in
 * `hiId` / `loId`). A final knot is emitted at `asOf` (when it lies after the last release) so
 * the band can be drawn to "now"; there the window may be empty — a lab that has not shipped
 * for over a year — and the family then degenerates to the single latest model, so the ribbon
 * collapses onto its line rather than vanishing. With one current model hi = lo everywhere.
 *
 * This is deliberately *not* `lineupBand`: that one keeps one slot per tier forever, this one
 * forgets a model once it is older than the window, which is what "the family's upper and
 * lower bound" means on a chart that shows every tier.
 */
export function familyRibbon(
  fit: IndexFit,
  releases: ModelRelease[],
  lab: LabId,
  opts: FamilyRibbonOptions = {},
): BandPoint[] {
  const asOf = opts.asOf;
  const windowDays = Math.max(0, opts.windowDays ?? 365);
  const tiers = new Set<ModelTier>(opts.tiers ?? ALL_TIERS);

  const rows = releases
    .filter(
      (r) =>
        r.lab === lab &&
        r.status === 'released' &&
        (asOf === undefined || r.date <= asOf) &&
        tiers.has(tierOf(r)) &&
        fit.models[r.id] !== undefined,
    )
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id.localeCompare(b.id)));
  if (rows.length === 0) return [];

  /** hi/lo over `rows[from..to]` (inclusive), which is never empty when called. */
  const knot = (date: ISODate, from: number, to: number): BandPoint => {
    let hiTheta = Number.NEGATIVE_INFINITY;
    let hiId = '';
    let loTheta = Number.POSITIVE_INFINITY;
    let loId = '';
    for (let i = from; i <= to; i++) {
      const r = rows[i]!;
      const theta = fit.models[r.id]!.theta;
      // Strict comparisons keep the earliest row on ties, so the ids are deterministic.
      if (theta > hiTheta) {
        hiTheta = theta;
        hiId = r.id;
      }
      if (theta < loTheta) {
        loTheta = theta;
        loId = r.id;
      }
    }
    return { date, hiTheta, loTheta, hiId, loId };
  };

  const out: BandPoint[] = [];
  let from = 0; // first row still inside the window — only ever moves forward
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const nextSameDay = i + 1 < rows.length && rows[i + 1]!.date === r.date;
    if (nextSameDay) continue; // collapse same-day launches into one knot
    while (from < i && daysBetween(rows[from]!.date, r.date) > windowDays) from++;
    out.push(knot(r.date, from, i));
  }

  // Extend to asOf so the last state is visible up to "now".
  const lastDate = rows[rows.length - 1]!.date;
  if (asOf !== undefined && asOf > lastDate) {
    const last = rows.length - 1;
    while (from < last && daysBetween(rows[from]!.date, asOf) > windowDays) from++;
    // Window empty at asOf ⇒ the single latest model (which may itself be outside the window).
    const start = daysBetween(rows[from]!.date, asOf) > windowDays ? last : from;
    out.push(knot(asOf, start, last));
  }
  return out;
}
