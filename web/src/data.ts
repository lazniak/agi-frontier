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
  FrontierGain,
  FrontierPace,
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
  indexFromTheta,
  thetaFromIndex,
  frontierGains,
  frontierLine,
  frontierPace,
  frontierVelocity,
  latestPerLab,
  leadershipStripes,
  rankCurrentFlagships,
  releasesAsOf,
  todayISO,
} from '@agi/shared';

/** The chart always starts here; the right edge depends on the long-range toggle. */
export const CHART_START: ISODate = '2023-01-01';
/** Default right edge: today + 12 months. Only the next release per lab fits in it. */
export const CHART_FUTURE_DAYS = 365;
/** "Long-range forecast (3 years)" right edge, matching the chained-forecast horizon. */
export const CHART_FUTURE_DAYS_LONG = 1095;
/** Chained forecasts are cut at 3 years, matching METHODOLOGY §4. */
export const FORECAST_HORIZON_DAYS = 1095;
/** How far past the k = 1 p95 date a lab's near-term fan is drawn. */
export const FAN_TAIL_DAYS = 30;

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
  /** Right edge of the long-range view (today + 3 years); also clips the chained predictions. */
  chartEnd: ISODate;
  /** Right edge of the default view (today + 12 months). */
  chartEndNear: ISODate;
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
  /**
   * The subset of `points` that qualifies for the index (METHODOLOGY §3). The lab line is drawn
   * through these and only these, so a provisional release can never bend the trend downwards.
   */
  qualified: SeriesPoint[];
  forecast: LabForecast | null;
  /** Capability fan out to the 3-year horizon — the long-range view. */
  fan: FanPoint[];
  /** Capability fan trimmed to the k = 1 p95 date + 30 days — the default view. */
  fanNear: FanPoint[];
  /** Predicted releases clipped to the chart's right edge. */
  predictions: PredictedRelease[];
  /** Non-released markers already known at `asOf`. */
  markers: ModelRelease[];
  /**
   * Released flagships with no score on any index benchmark (GPT-1, the first Kimi…). They have
   * no height on the chart, so they are drawn as ticks on the timeline instead of vanishing.
   */
  unscored: ModelRelease[];
  last: SeriesPoint | null;
  /** Last *qualified* release — where the lab line actually ends. */
  lastQualified: SeriesPoint | null;
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
  /** Trailing-year slope of the frontier in logits, and the implied odds-doubling time. */
  pace: FrontierPace | null;
  /** Frontier gain per calendar quarter, first knot to `asOf` — the pace strip under the chart. */
  gains: FrontierGain[];
  stripes: LeadershipStripe[];
  rankings: ModelIndex[];
  labViews: LabView[];
  byLab: Map<LabId, LabView>;
  /**
   * The frontier itself: the last knot of the running maximum, which `frontierLine` builds from
   * qualified models only. Never a provisional release — see METHODOLOGY §3.
   */
  top: SeriesPoint | null;
  /**
   * Highest-index provisional release as of `asOf`. Shown as a footnote when it out-scores `top`,
   * so a reader who spots a bigger number on the chart is not left wondering why it is not the lead.
   */
  topProvisional: SeriesPoint | null;
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
    chartEnd: addDays(today, CHART_FUTURE_DAYS_LONG),
    chartEndNear: addDays(today, CHART_FUTURE_DAYS),
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
    const pace = frontier.length >= 2 ? frontierPace(frontier, asOf) : null;
    const gains = frontierGains(frontier, asOf, 3);
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

    const unscoredByLab = new Map<LabId, ModelRelease[]>();
    for (const r of released) {
      if (fit.models[r.id]) continue;
      const arr = unscoredByLab.get(r.lab);
      if (arr) arr.push(r);
      else unscoredByLab.set(r.lab, [r]);
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
      const qualified = points.filter((p) => p.mi.qualified);
      const forecast = forecasts.get(lab.id) ?? null;
      const hasFan = Boolean(forecast?.lastRelease) && points.length > 0;
      const fan = hasFan && forecast ? fanTo(forecast, asOf, fanEnd) : [];
      // The default view stops one release ahead: a fan drawn to the 3-year horizon for ten labs
      // merges into a single yellow block that hides everything under it.
      const nearEnd = nearFanEnd(forecast, asOf, fanEnd);
      const fanNear = hasFan && forecast ? fanTo(forecast, asOf, nearEnd) : [];
      const predictions = (forecast?.next ?? []).filter((p) => p.medianDate <= ctx.chartEnd);
      labViews.push({
        lab,
        points,
        qualified,
        forecast,
        fan,
        fanNear,
        predictions,
        markers: markersByLab.get(lab.id) ?? [],
        unscored: unscoredByLab.get(lab.id) ?? [],
        last: points.length ? points[points.length - 1]! : null,
        lastQualified: qualified.length ? qualified[qualified.length - 1]! : null,
      });
    }

    const byLab = new Map(labViews.map((v) => [v.lab.id, v]));
    // The headline number is the frontier, not the best current flagship: `frontierLine` already
    // filters to qualified models, so a provisional release can never become the lead.
    const top = seriesPoint(ctx, fit, frontier[frontier.length - 1]?.release_id);
    const topProvisional = seriesPoint(ctx, fit, bestProvisionalId(fit));

    return {
      ok: true,
      error: null,
      asOf,
      fanEnd,
      fit,
      frontier,
      velocity,
      pace,
      gains,
      stripes,
      rankings,
      labViews,
      byLab,
      top,
      topProvisional,
      nextUp: pickNextUp(ctx, labViews, asOf),
      extent: extentOfViews(labViews),
    };
  } catch (err) {
    return { ...empty, ok: false, error: (err as Error).message };
  }
}

/**
 * Sample a lab's capability band from `asOf` to `end`, always landing exactly on `end` —
 * `capabilityFan` steps in whole weeks, so the last sample can otherwise fall up to six days
 * short and the trimmed fans would end on a ragged edge.
 */
function fanTo(forecast: LabForecast, asOf: ISODate, end: ISODate): FanPoint[] {
  if (end < asOf) return [];
  const pts = capabilityFan(forecast, { asOf, toDate: end, stepDays: 7 });
  const last = pts[pts.length - 1];
  if (last && last.date !== end) {
    const tail = capabilityFan(forecast, { asOf: end, toDate: end, stepDays: 7 })[0];
    if (tail) pts.push(tail);
  }
  return pts;
}

/** Where the default (non-long-range) fan stops: the k = 1 p95 date plus a short tail. */
function nearFanEnd(forecast: LabForecast | null, asOf: ISODate, hardEnd: ISODate): ISODate {
  const first = forecast?.next.find((p) => p.k === 1) ?? forecast?.next[0];
  if (!first) return minDate(addDays(asOf, 120), hardEnd);
  return minDate(addDays(first.p95Date, FAN_TAIL_DAYS), hardEnd);
}

function emptyComputed(ctx: Ctx, asOf: ISODate): Computed {
  const labViews = ctx.labList.map<LabView>((lab) => ({
    lab,
    points: [],
    qualified: [],
    forecast: null,
    fan: [],
    fanNear: [],
    predictions: [],
    markers: [],
    unscored: [],
    last: null,
    lastQualified: null,
  }));
  return {
    ok: true,
    error: null,
    asOf,
    fanEnd: ctx.chartEnd,
    fit: EMPTY_FIT,
    frontier: [],
    velocity: null,
    pace: null,
    gains: [],
    stripes: [],
    rankings: [],
    labViews,
    byLab: new Map(labViews.map((v) => [v.lab.id, v])),
    top: null,
    topProvisional: null,
    nextUp: null,
    extent: [0, 100],
  };
}

/** Pair a fitted model with its release, or null when either half is missing. */
function seriesPoint(ctx: Ctx, fit: IndexFit, id: string | undefined): SeriesPoint | null {
  if (!id) return null;
  const mi = fit.models[id];
  const release = ctx.releasesById.get(id);
  return mi && release ? { release, mi } : null;
}

/** Highest-index provisional model in the fit (the fit is already scoped to `asOf`). */
function bestProvisionalId(fit: IndexFit): string | undefined {
  let best: ModelIndex | undefined;
  for (const m of Object.values(fit.models)) {
    if (m.qualified) continue;
    if (!best || m.index > best.index || (m.index === best.index && m.release_id < best.release_id)) best = m;
  }
  return best?.release_id;
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

/**
 * Index range occupied by these lab views, padded. Exported so "fit to data" can honour the
 * legend — and the long-range toggle, since the two views draw different fans.
 */
export function extentOfViews(views: LabView[], longRange = false): [number, number] {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of views) {
    for (const p of v.points) {
      lo = Math.min(lo, p.mi.indexLow);
      hi = Math.max(hi, p.mi.indexHigh);
    }
    for (const f of longRange ? v.fan : v.fanNear) {
      lo = Math.min(lo, f.low);
      hi = Math.max(hi, f.high);
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 100];
  const pad = Math.max(2, (hi - lo) * 0.12);
  return [Math.max(0, lo - pad), Math.min(100, hi + pad)];
}

/**
 * The resting range of the logit axis: from the lowest *point* to the highest fan edge. Unlike
 * `extentOfViews` it ignores the error bars — a provisional release fitted from one score has a
 * ± that reaches the floor of the scale and would leave the bottom third of the chart empty.
 * Padded by a fixed amount of latent ability rather than a fraction of the index.
 */
export function restingLogitExtent(views: LabView[], longRange = false): [number, number] {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of views) {
    for (const p of v.points) {
      lo = Math.min(lo, p.mi.index);
      hi = Math.max(hi, p.mi.index);
    }
    for (const f of longRange ? v.fan : v.fanNear) hi = Math.max(hi, f.high);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [2, 99];
  const clamp = (v: number): number => Math.min(99.5, Math.max(0.5, v));
  const tl = thetaFromIndex(clamp(lo)) - 0.45;
  const th = thetaFromIndex(clamp(hi)) + 0.15;
  return [clamp(indexFromTheta(tl)), clamp(indexFromTheta(th))];
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
