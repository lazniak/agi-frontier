/**
 * Load `/latest.json` and derive everything the page shows.
 *
 * All of the maths lives in `@agi/shared` (the same code the worker uses) — this module only
 * arranges its output into the shapes the chart and the panels want, and memoises per
 * `(asOf, forecast mode)` so dragging the time scrubber stays cheap.
 *
 * The y axis is linear in the latent ability theta (log-odds) and *unbounded*; the Frontier
 * Rating (`1000 + (400 / ln 10)·theta`) and the bounded Frontier Index (`100·sigma(theta)`) are
 * two labellings of the same scale, so every fan, level and crossing here is expressed in theta
 * (or index) exactly as the shared maths returns it.
 */
import type {
  BacktestReport,
  BacktestRow,
  BandPoint,
  Benchmark,
  Bundle,
  Crossing,
  Era,
  FanPoint,
  FrontierGain,
  FrontierPace,
  FrontierPoint,
  FrontierTrend,
  IndexFit,
  ISODate,
  Lab,
  LabForecast,
  LabId,
  LeadershipStripe,
  Level,
  ModelIndex,
  ModelRelease,
  PaceRegime,
  PredictedRelease,
} from '@agi/shared';
import {
  addDays,
  backtestAsOf,
  benchmarkLevels,
  capabilityFan,
  fitFrontierIndex,
  forecastAll,
  frontierCrossings,
  frontierFan,
  frontierGains,
  frontierLine,
  frontierPace,
  frontierTrend,
  frontierVelocity,
  indexFromTheta,
  latestPerLab,
  leadershipStripes,
  lineupBand,
  paceEras,
  projectedEra as projectedEraOf,
  rankCurrentFlagships,
  releasesAsOf,
  thetaFromIndex,
  todayISO,
} from '@agi/shared';
import type { ForecastMode } from './state';

/** Left edge of the "recent" view (the modern basket era). */
export const CHART_START_RECENT: ISODate = '2023-01-01';
/** Room left of the first release in the story view. */
export const CHART_HISTORY_PAD_DAYS = 120;
/** The resting right edge: today + 3 years. The zoom can go far beyond it. */
export const CHART_FUTURE_DAYS = 1095;
/** How far past the k = 1 p95 date a lab's near-term fan is drawn. */
export const FAN_TAIL_DAYS = 30;
/** Minimum forecast length: the fans never stop closer than this to `asOf`. */
export const FAN_MIN_DAYS = 400;
/** Long-chain cap (REDESIGN §4). */
export const FORECAST_MAX_RELEASES = 24;
/** Small chain kept in the "next" view so the whiskers can hint at what follows. */
export const NEXT_MAX_RELEASES = 3;

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
  /** Left edge of the story view: a little before the first release. */
  chartStart: ISODate;
  /** Right edge of the resting view (today + 3 years); the zoom can go far beyond it. */
  chartEnd: ISODate;
  /** True when the loaded bundle contains releases produced by the OpenRouter researcher. */
  researched: boolean;
  /** True when the loaded bundle is the synthetic development fixture. */
  synthetic: boolean;
  /** Lazy memo of the full-horizon fit (all releases, asOf = today) — the backtest's `todayFit`. */
  readonly fullFit: () => IndexFit;
}

export interface SeriesPoint {
  release: ModelRelease;
  mi: ModelIndex;
}

export interface LabView {
  lab: Lab;
  /** Released *flagships* with a fit entry — the only things on the lab line. */
  points: SeriesPoint[];
  /**
   * The subset of `points` that qualifies for the index (METHODOLOGY §3). The lab line is drawn
   * through these and only these, so a provisional release can never bend the trend downwards.
   */
  qualified: SeriesPoint[];
  /** Released mid/small models with a fit entry — hollow markers, never on the line. */
  tiers: SeriesPoint[];
  forecast: LabForecast | null;
  /** Capability fan out to the resting right edge — the long view. */
  fan: FanPoint[];
  /** Capability fan trimmed to the k = 1 p95 date + 30 days — the next-release view. */
  fanNear: FanPoint[];
  /** Predicted releases (chain length follows the forecast mode). */
  predictions: PredictedRelease[];
  /** Non-released markers already known at `asOf`. */
  markers: ModelRelease[];
  /**
   * Released models with no score on any index benchmark (GPT-1, the first Kimi…). They have
   * no height on the chart, so they are drawn as ticks on the timeline instead of vanishing.
   */
  unscored: ModelRelease[];
  /** The lab's family band: flagship theta on top, smallest current tier below (REDESIGN §3). */
  band: BandPoint[];
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
  /** Same, across every tier — the rankings panel's tier filter (REDESIGN §3). */
  rankingsAll: ModelIndex[];
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
  /** Index range actually occupied by visible data — used by the panels. */
  extent: [number, number];
  /** The y-axis ladder of levels, ascending in theta (REDESIGN §2.1). */
  levels: Level[];
  /** OLS trend of the frontier's theta over the trailing year, ending at `asOf`. */
  trend: FrontierTrend | null;
  /** The frontier trend fan out to `fanEnd` — the grey/yellow continuation (REDESIGN §4). */
  frontierFan: FanPoint[];
  /** Past and predicted crossings of the levels (REDESIGN §2.2). */
  crossings: Crossing[];
  /** Pace regimes over time (REDESIGN §2.3). */
  eras: Era[];
  /** Regime of the current trend slope, open-ended. */
  projectedEra: PaceRegime | null;
  /** Family band per lab (REDESIGN §3). */
  bands: Map<LabId, BandPoint[]>;
  backtest: {
    /** The worker-computed whole-history report, when the bundle carries one. */
    report: BacktestReport | null;
    /** Live rows recomputed at the scrubbed date — non-null only while scrubbed. */
    rows: BacktestRow[] | null;
  };
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
  const firstDate = dates[0] ?? CHART_START_RECENT;
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
    chartStart: minDate(addDays(firstDate, -CHART_HISTORY_PAD_DAYS), CHART_START_RECENT),
    chartEnd: addDays(today, CHART_FUTURE_DAYS),
    researched: bundle.releases.some((r) => r.origin === 'researcher'),
    synthetic: bundle.releases.some((r) => (r.notes ?? '').includes('SYNTHETIC FIXTURE')),
    fullFit: memoFn(() => fitFrontierIndex(bundle.releases, bundle.benchmarks, {})),
  };
}

/** Zero-arg lazy memo: computes on first call, returns the same instance afterwards. */
function memoFn<T>(fn: () => T): () => T {
  let cache: { v: T } | null = null;
  return () => {
    if (cache === null) cache = { v: fn() };
    return cache.v;
  };
}

/* ------------------------------------------------------------------ compute */

const cache = new Map<string, Computed>();
const CACHE_MAX = 90;

/** `Computed` depends on `asOf` and on how deep the forecast chain is asked to go. */
export function compute(ctx: Ctx, asOf: ISODate, opts: { forecast?: ForecastMode } = {}): Computed {
  const key = `${asOf}|${opts.forecast ?? 'next'}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out = computeUncached(ctx, asOf, opts.forecast ?? 'next');
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, out);
  return out;
}

export function clearComputeCache(): void {
  cache.clear();
}

function computeUncached(ctx: Ctx, asOf: ISODate, forecastMode: ForecastMode): Computed {
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
    // Every tier, for the rankings panel's tier filter (REDESIGN section 3).
    const rankingsAll = rankCurrentFlagships(fit, bundle.releases, asOf, { tiers: ['flagship', 'mid', 'small'] });

    // The fans never stop: the resting edge is today + 3 years, and the chart asks for more
    // (up to its zoomed x-domain edge) as the reader zooms out.
    const fanEnd = maxDate(ctx.chartEnd, addDays(asOf, FAN_MIN_DAYS));
    // forecastAll re-derives the cadence prior internally; the call is kept only for readability.
    void bundle;

    const forecasts = new Map<LabId, LabForecast>();
    // The conformal σ scale comes from the worker's backtest (REDESIGN §5): every window drawn
    // here is as wide as the model's own track record says it must be. 1 until a backtest exists.
    const sigmaScale = ctx.bundle.backtest?.sigmaScale ?? 1;
    for (const f of forecastAll(ctx.labList.map((l) => l.id), bundle.releases, fit, {
      asOf,
      maxReleases: forecastMode === 'long' ? FORECAST_MAX_RELEASES : NEXT_MAX_RELEASES,
      tierFilter: ['flagship'],
      sigmaScale,
    })) {
      forecasts.set(f.lab, f);
    }

    const released = releasesAsOf(bundle.releases, asOf);
    const seriesByLab = new Map<LabId, SeriesPoint[]>();
    const tiersByLab = new Map<LabId, SeriesPoint[]>();
    for (const r of released) {
      const mi = fit.models[r.id];
      if (!mi) continue; // released but no official index score yet → not plottable
      const target = (r.tier ?? 'flagship') === 'flagship' ? seriesByLab : tiersByLab;
      const acc = target.get(r.lab);
      if (acc) acc.push({ release: r, mi });
      else target.set(r.lab, [{ release: r, mi }]);
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

    const levels = benchmarkLevels(fit, ctx.indexBenchmarks);
    const trend = frontierTrend(frontier, asOf);
    const fFan = frontierFan(frontier, asOf, { toDate: fanEnd, stepDays: 7 });
    const crossings = frontierCrossings(frontier, levels, asOf);
    const eras = paceEras(frontier, asOf);
    const projected = projectedEraOf(trend);

    const labViews: LabView[] = [];
    for (const lab of ctx.labList) {
      const points = seriesByLab.get(lab.id) ?? [];
      const qualified = points.filter((p) => p.mi.qualified);
      const forecast = forecasts.get(lab.id) ?? null;
      const hasFan = Boolean(forecast?.lastRelease) && points.length > 0;
      const fan = hasFan && forecast ? fanTo(forecast, asOf, fanEnd) : [];
      // The next-release view stops one release ahead: a fan drawn to the 3-year horizon for ten
      // labs merges into a single yellow block that hides everything under it.
      const nearEnd = nearFanEnd(forecast, asOf, fanEnd);
      const fanNear = hasFan && forecast ? fanTo(forecast, asOf, nearEnd) : [];
      labViews.push({
        lab,
        points,
        qualified,
        tiers: tiersByLab.get(lab.id) ?? [],
        forecast,
        fan,
        fanNear,
        // No date filter here — the chart keeps whatever falls inside the visible x-domain.
        predictions: forecast?.next ?? [],
        markers: markersByLab.get(lab.id) ?? [],
        unscored: unscoredByLab.get(lab.id) ?? [],
        band: lineupBand(fit, bundle.releases, lab.id, { asOf }),
        last: points.length ? points[points.length - 1]! : null,
        lastQualified: qualified.length ? qualified[qualified.length - 1]! : null,
      });
    }

    const bands = new Map(labViews.map((v) => [v.lab.id, v.band]));

    const byLab = new Map(labViews.map((v) => [v.lab.id, v]));
    // The headline number is the frontier, not the best current flagship: `frontierLine` already
    // filters to qualified models, so a provisional release can never become the lead.
    const top = seriesPoint(ctx, fit, frontier[frontier.length - 1]?.release_id);
    const topProvisional = seriesPoint(ctx, fit, bestProvisionalId(fit));

    // The worker may have shipped a whole-history backtest in the bundle (REDESIGN §5); while
    // the page is scrubbed, the k = 1 rows are replayed live at the scrubbed date.
    const backtest = {
      report: ctx.bundle.backtest ?? null,
      rows:
        asOf < ctx.today
          ? backtestAsOf(bundle.releases, bundle.benchmarks, ctx.labList.map((l) => l.id), asOf, {
              // The full-horizon fit knows the θ of releases *after* asOf — the scrubbed fit
              // cannot see them and would null out every `actual.theta`.
              todayFit: ctx.fullFit(),
              sigmaScale: ctx.bundle.backtest?.sigmaScale ?? 1,
            }).rows
          : null,
    };

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
      rankingsAll,
      labViews,
      byLab,
      top,
      topProvisional,
      nextUp: pickNextUp(ctx, labViews, asOf),
      extent: extentOfViews(labViews),
      levels,
      trend,
      frontierFan: fFan,
      crossings,
      eras,
      projectedEra: projected,
      bands,
      backtest,
    };
  } catch (err) {
    return { ...empty, ok: false, error: (err as Error).message };
  }
}

/**
 * Sample a lab's capability band from `asOf` to `end`, always landing exactly on `end` —
 * `capabilityFan` steps in whole weeks, so the last sample can otherwise fall up to six days
 * short and the trimmed fans would end on a ragged edge. Exported so the chart can re-ask for a
 * fan that reaches its current x-domain edge (REDESIGN §4: no fixed horizon).
 */
export function fanTo(forecast: LabForecast, asOf: ISODate, end: ISODate): FanPoint[] {
  if (end < asOf) return [];
  const pts = capabilityFan(forecast, { asOf, toDate: end, stepDays: 7 });
  const last = pts[pts.length - 1];
  if (last && last.date !== end) {
    const tail = capabilityFan(forecast, { asOf: end, toDate: end, stepDays: 7 })[0];
    if (tail) pts.push(tail);
  }
  return pts;
}

/** Where the next-release fan stops: the k = 1 p95 date plus a short tail. */
export function nearFanEnd(forecast: LabForecast | null, asOf: ISODate, hardEnd: ISODate): ISODate {
  const first = forecast?.next.find((p) => p.k === 1) ?? forecast?.next[0];
  if (!first) return minDate(addDays(asOf, 120), hardEnd);
  return minDate(addDays(first.p95Date, FAN_TAIL_DAYS), hardEnd);
}

function emptyComputed(ctx: Ctx, asOf: ISODate): Computed {
  const labViews = ctx.labList.map<LabView>((lab) => ({
    lab,
    points: [],
    qualified: [],
    tiers: [],
    forecast: null,
    fan: [],
    fanNear: [],
    predictions: [],
    markers: [],
    unscored: [],
    band: [],
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
    rankingsAll: [],
    labViews,
    byLab: new Map(labViews.map((v) => [v.lab.id, v])),
    top: null,
    topProvisional: null,
    nextUp: null,
    extent: [0, 100],
    levels: [],
    trend: null,
    frontierFan: [],
    crossings: [],
    eras: [],
    projectedEra: null,
    bands: new Map(),
    backtest: { report: ctx.bundle.backtest ?? null, rows: null },
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
 * Index range occupied by these lab views, padded. Kept for the panels; the chart itself works
 * in theta — see `thetaExtent`.
 */
export function extentOfViews(views: LabView[]): [number, number] {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of views) {
    for (const p of v.points) {
      lo = Math.min(lo, p.mi.indexLow);
      hi = Math.max(hi, p.mi.indexHigh);
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 100];
  const pad = Math.max(2, (hi - lo) * 0.12);
  return [Math.max(0, lo - pad), Math.min(100, hi + pad)];
}

/**
 * The resting range of the y axis in latent theta — unbounded above, unlike the old index extent.
 * From the lowest *point* to the highest fan edge (the lab fans at the requested depth, plus any
 * extra fans, e.g. the frontier trend fan). Provisional single-score error bars are ignored, or
 * they would reach the floor and leave the chart two-thirds empty.
 */
export function thetaExtent(
  views: LabView[],
  opts: { fanMode?: 'near' | 'long'; withTiers?: boolean; extra?: FanPoint[] } = {},
): [number, number] {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  const key = opts.fanMode === 'long' ? 'fan' : 'fanNear';
  for (const v of views) {
    for (const p of v.points) {
      lo = Math.min(lo, p.mi.theta);
      hi = Math.max(hi, p.mi.theta);
    }
    if (opts.withTiers) {
      for (const p of v.tiers) {
        lo = Math.min(lo, p.mi.theta);
        hi = Math.max(hi, p.mi.theta);
      }
    }
    for (const f of v[key]) {
      hi = Math.max(hi, fanHighTheta(f));
      lo = Math.min(lo, fanLowTheta(f));
    }
  }
  for (const f of opts.extra ?? []) {
    hi = Math.max(hi, fanHighTheta(f));
    lo = Math.min(lo, fanLowTheta(f));
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [thetaFromIndex(2), thetaFromIndex(99)];
  return [lo - 0.45, hi + 0.15];
}

/**
 * Fan edges in theta — FanPoint carries the un-clamped values natively (REDESIGN §4).
 */
export function fanLowTheta(f: FanPoint): number {
  const t = (f as Partial<Record<'thetaLow', number>>).thetaLow;
  return typeof t === 'number' ? t : thetaFromIndex(f.low);
}

export function fanMidTheta(f: FanPoint): number {
  const t = (f as Partial<Record<'theta', number>>).theta;
  return typeof t === 'number' ? t : thetaFromIndex(f.mid);
}

export function fanHighTheta(f: FanPoint): number {
  const t = (f as Partial<Record<'thetaHigh', number>>).thetaHigh;
  return typeof t === 'number' ? t : thetaFromIndex(f.high);
}

/** Predicted-release theta — `theta` exists today; the TODO(T31) alias documents the intent. */
export function predTheta(p: PredictedRelease): number {
  return p.theta;
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

/** Index of a theta value — kept for anything that still speaks index. */
export { indexFromTheta };
