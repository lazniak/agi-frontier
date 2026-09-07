/**
 * Family bands (REDESIGN §3): a lab's lineup over time, from its flagship on top to the
 * smallest current tier below. Pure functions; consumed by the chart band layer.
 */
import type { BandPoint, ISODate, LabId, ModelRelease, ModelTier } from './types';
import type { IndexFit, ModelIndex } from './frontier-index';

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
