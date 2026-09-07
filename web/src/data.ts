/**
 * Load `/latest.json` and derive everything the page shows.
 *
 * All of the maths lives in `@agi/shared` (the same code the worker uses) — this module only
 * arranges its output into the shapes the chart and the panels want, and memoises per `asOf`
 * so dragging the time scrubber stays cheap.
 */
import type {
  Bundle,
  Benchmark,
  FanPoint,
  FrontierPoint,
  IndexFit,
  ISODate,
  Lab,
  LabForecast,
  LabId,
  LeadershipStripe,
  ModelIndex,
  ModelRelease,
  PredictedRelease,
} from '@agi/shared';
import {
  addDays,
  cadencePrior,
  capabilityFan,
  fitFrontierIndex,
  forecastAll,
  frontierLine,
  frontierVelocity,
  latestPerLab,
  leadershipStripes,
  rankCurrentFlagships,
  releasesAsOf,
  todayISO,
} from '@agi/shared';

/** The chart always starts here; the right edge is `today + CHART_FUTURE_DAYS`. */
export const CHART_START: ISODate = '2023-01-01';
export const CHART_FUTURE_DAYS = 548; // ~18 months
/** Chained forecasts are cut at 3 years, matching METHODOLOGY §4. */
export const FORECAST_HORIZON_DAYS = 1095;

export interface Ctx {
  bundle: Bundle;
  labs: Map<LabId, Lab>;
  labList: Lab[];
  benchmarks: Map<string, Benchmark>;
  benchmarkList: Benchmark[];
  indexBenchmarks: Benchmark[];
  releasesById: Map<string, ModelRelease>;
  today: ISODate;
  /** First release date in the dataset (scrubber lower bound is derived from it). */
  firstDate: ISODate;
  chartEnd: ISODate;
  /** True when the loaded bundle is the synthetic development fixture. */
  synthetic: boolean;
}

export interface SeriesPoint {
  release: ModelRelease;
  mi: ModelIndex;
}

export interface LabView {
  lab: Lab;
  points: SeriesPoint[];
  forecast: LabForecast | null;
  fan: FanPoint[];
  /** Predicted releases clipped to the chart's right edge. */
  predictions: PredictedRelease[];
  /** Non-released markers already known at `asOf`. */
  markers: ModelRelease[];
  last: SeriesPoint | null;
}

export interface NextUp {
  lab: Lab;
  forecast: LabForecast;
  pred: PredictedRelease;
}

export interface Computed {
  ok: boolean;
  error: string | null;
  asOf: ISODate;
  fanEnd: ISODate;
  fit: IndexFit;
  frontier: FrontierPoint[];
  velocity: number | null;
  stripes: LeadershipStripe[];
  rankings: ModelIndex[];
  labViews: LabView[];
  byLab: Map<LabId, LabView>;
  top: SeriesPoint | null;
  nextUp: NextUp | null;
  /** Index range actually occupied by visible data — used by "fit to data". */
  extent: [number, number];
}

const EMPTY_FIT: IndexFit = {
  asOf: null,
  benchmarksInIndex: [],
  difficulties: {},
  models: {},
  residualSigma: 0,
  iterations: 0,
  converged: true,
};

/* ------------------------------------------------------------------ loading */

export async function loadBundle(): Promise<Bundle> {
  const res = await fetch('/latest.json', { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`/latest.json responded ${res.status} ${res.statusText}`);
  const bundle = (await res.json()) as Bundle;
  if (!bundle || !Array.isArray(bundle.releases) || !Array.isArray(bundle.labs)) {
    throw new Error('/latest.json is not an AGI Frontier bundle');
  }
  return bundle;
}

export function makeCtx(bundle: Bundle): Ctx {
  const today = todayISO();
  const dates = bundle.releases.map((r) => r.date).sort();
  const firstDate = dates[0] ?? CHART_START;
  return {
    bundle,
    labs: new Map(bundle.labs.map((l) => [l.id, l])),
    labList: bundle.labs,
    benchmarks: new Map(bundle.benchmarks.map((b) => [b.id, b])),
    benchmarkList: bundle.benchmarks,
    indexBenchmarks: bundle.benchmarks.filter((b) => b.in_index),
    releasesById: new Map(bundle.releases.map((r) => [r.id, r])),
    today,
    firstDate,
    chartEnd: addDays(today, CHART_FUTURE_DAYS),
    synthetic: bundle.releases.some((r) => (r.notes ?? '').includes('SYNTHETIC FIXTURE')),
  };
}

/* ------------------------------------------------------------------ compute */

const cache = new Map<ISODate, Computed>();
const CACHE_MAX = 90;

export function compute(ctx: Ctx, asOf: ISODate): Computed {
  const hit = cache.get(asOf);
  if (hit) return hit;
  const out = computeUncached(ctx, asOf);
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(asOf, out);
  return out;
}

export function clearComputeCache(): void {
  cache.clear();
}

function computeUncached(ctx: Ctx, asOf: ISODate): Computed {
  const { bundle } = ctx;
  const empty = emptyComputed(ctx, asOf);
  try {
    const fit = fitFrontierIndex(bundle.releases, bundle.benchmarks, { asOf });
    const frontier = frontierLine(fit);
    const velocity = frontier.length >= 2 ? frontierVelocity(frontier, asOf) : null;
    const stripes = leadershipStripes(fit);
    const rankings = rankCurrentFlagships(fit, bundle.releases, asOf);

    const fanEnd = minDate(addDays(asOf, FORECAST_HORIZON_DAYS), maxDate(ctx.chartEnd, addDays(asOf, 200)));
    const prior = cadencePrior(bundle.releases, asOf);
    void prior; // forecastAll re-derives the prior internally; kept for readability of the pipeline.

    const forecasts = new Map<LabId, LabForecast>();
    for (const f of forecastAll(ctx.labList.map((l) => l.id), bundle.releases, fit, { asOf })) {
      forecasts.set(f.lab, f);
    }

    const released = releasesAsOf(bundle.releases, asOf);
    const seriesByLab = new Map<LabId, SeriesPoint[]>();
    for (const r of released) {
      const mi = fit.models[r.id];
      if (!mi) continue; // released but no official index score yet → not plottable
      const arr = seriesByLab.get(r.lab);
      if (arr) arr.push({ release: r, mi });
      else seriesByLab.set(r.lab, [{ release: r, mi }]);
    }

    const markersByLab = new Map<LabId, ModelRelease[]>();
    for (const r of bundle.releases) {
      if (r.status === 'released') continue;
      if (knownAt(r) > asOf) continue; // not yet announced as of the scrubbed date
      const arr = markersByLab.get(r.lab);
      if (arr) arr.push(r);
      else markersByLab.set(r.lab, [r]);
    }

    const labViews: LabView[] = [];
    for (const lab of ctx.labList) {
      const points = seriesByLab.get(lab.id) ?? [];
      const forecast = forecasts.get(lab.id) ?? null;
      const fan =
        forecast && forecast.lastRelease && points.length > 0
          ? capabilityFan(forecast, { asOf, toDate: fanEnd, stepDays: 7 })
          : [];
      const predictions = (forecast?.next ?? []).filter((p) => p.medianDate <= ctx.chartEnd);
      labViews.push({
        lab,
        points,
        forecast,
        fan,
        predictions,
        markers: markersByLab.get(lab.id) ?? [],
        last: points.length ? points[points.length - 1]! : null,
      });
    }

    const byLab = new Map(labViews.map((v) => [v.lab.id, v]));
    const topId = rankings[0]?.release_id;
    const topRelease = topId ? ctx.releasesById.get(topId) : undefined;
    const top = topRelease && rankings[0] ? { release: topRelease, mi: rankings[0] } : null;

    return {
      ok: true,
      error: null,
      asOf,
      fanEnd,
      fit,
      frontier,
      velocity,
      stripes,
      rankings,
      labViews,
      byLab,
      top,
      nextUp: pickNextUp(ctx, labViews, asOf),
      extent: extentOfViews(labViews),
    };
  } catch (err) {
    return { ...empty, ok: false, error: (err as Error).message };
  }
}

function emptyComputed(ctx: Ctx, asOf: ISODate): Computed {
  const labViews = ctx.labList.map<LabView>((lab) => ({
    lab,
    points: [],
    forecast: null,
    fan: [],
    predictions: [],
    markers: [],
    last: null,
  }));
  return {
    ok: true,
    error: null,
    asOf,
    fanEnd: ctx.chartEnd,
    fit: EMPTY_FIT,
    frontier: [],
    velocity: null,
    stripes: [],
    rankings: [],
    labViews,
    byLab: new Map(labViews.map((v) => [v.lab.id, v])),
    top: null,
    nextUp: null,
    extent: [0, 100],
  };
}

/** The soonest credible next flagship across all labs. */
function pickNextUp(ctx: Ctx, views: LabView[], asOf: ISODate): NextUp | null {
  let best: NextUp | null = null;
  for (const v of views) {
    const pred = v.predictions.find((p) => p.k === 1 && p.medianDate >= asOf);
    if (!pred || !v.forecast) continue;
    if (!best || pred.medianDate < best.pred.medianDate) best = { lab: v.lab, forecast: v.forecast, pred };
  }
  void ctx;
  return best;
}

/** Index range occupied by these lab views, padded. Exported so "fit to data" can honour the legend. */
export function extentOfViews(views: LabView[]): [number, number] {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of views) {
    for (const p of v.points) {
      lo = Math.min(lo, p.mi.indexLow);
      hi = Math.max(hi, p.mi.indexHigh);
    }
    for (const f of v.fan) {
      lo = Math.min(lo, f.low);
      hi = Math.max(hi, f.high);
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 100];
  const pad = Math.max(2, (hi - lo) * 0.12);
  return [Math.max(0, lo - pad), Math.min(100, hi + pad)];
}

/**
 * When a non-released model became public knowledge. `retrieved_at` is the only timestamp the
 * data contract records for an announcement, so scrubbing uses it to keep the past honest.
 */
function knownAt(r: ModelRelease): ISODate {
  const ts = r.announcement?.retrieved_at;
  const day = typeof ts === 'string' && ts.length >= 10 ? ts.slice(0, 10) : null;
  return day ?? r.date;
}

const minDate = (a: ISODate, b: ISODate): ISODate => (a < b ? a : b);
const maxDate = (a: ISODate, b: ISODate): ISODate => (a > b ? a : b);

/* ---------------------------------------------------------------- utilities */

/** Latest released flagship per lab as of `asOf` (used by the release-watch cards). */
export function flagships(ctx: Ctx, asOf: ISODate): Map<LabId, ModelRelease> {
  return latestPerLab(ctx.bundle.releases, asOf);
}

/** Every score a release reported, in basket order, with the ones outside the index last. */
export function orderedScores(ctx: Ctx, release: ModelRelease): ModelRelease['scores'] {
  const rank = new Map(ctx.benchmarkList.map((b, i) => [b.id, i] as const));
  return [...release.scores].sort((a, b) => {
    const ba = ctx.benchmarks.get(a.benchmark);
    const bb = ctx.benchmarks.get(b.benchmark);
    const ia = (ba?.in_index ? 0 : 1000) + (rank.get(a.benchmark) ?? 500);
    const ib = (bb?.in_index ? 0 : 1000) + (rank.get(b.benchmark) ?? 500);
    return ia - ib;
  });
}

/** How many distinct primary sources back a release. */
export function sourceCount(release: ModelRelease): number {
  const urls = new Set<string>([release.announcement.url]);
  for (const s of release.sources ?? []) urls.add(s.url);
  for (const s of release.scores) urls.add(s.source.url);
  return urls.size;
}
