/**
 * Backtest and calibration of the release-date forecast (REDESIGN §5): replay history —
 * at each grid date fit and forecast strictly as of that date, then compare the k = 1
 * prediction with the lab's next actual flagship release. Pure and deterministic; fits are
 * memoised per `asOf` inside one call, so the browser can afford the whole series.
 */
import type { BacktestReport, BacktestRow, Benchmark, ISODate, LabId, ModelRelease } from './types';
import type { IndexFit } from './frontier-index';
import { fitFrontierIndex } from './frontier-index';
import { cadencePrior, forecastLab, lognormalConditionalQuantile } from './prediction';
import { addDays, daysBetween } from './timeline';

export interface BacktestAsOf {
  asOf: ISODate;
  rows: BacktestRow[];
}

/** Nominal coverage levels of the calibration curve (REDESIGN §5). */
export const CALIBRATION_NOMINAL: readonly number[] = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

export interface BacktestSeriesOptions {
  /** First grid date. Default: first released flagship date + 365 d. */
  from?: ISODate | undefined;
  /** End of the observed history; the grid stops at `to − 30 d` (REDESIGN §11). */
  to: ISODate;
  /** Grid spacing in days (default 30). */
  stepDays?: number | undefined;
  /** Pseudo-observations pulling each lab toward the pooled cadence prior (default 2). */
  priorWeight?: number | undefined;
  /** Cadence recency half-life in days passed to every forecast (default 730; Infinity = unweighted). */
  halfLifeDays?: number | undefined;
  /** σ multiplier passed to every forecast (default 1). */
  sigmaScale?: number | undefined;
  /** A fit as of *today*, so rows can take actual theta without refitting per call. */
  todayFit?: IndexFit | undefined;
  /**
   * Shared per-`asOf` fit cache. The fit does not depend on the forecast options, so
   * `calibrateForecast` passes one cache across all σ scales and pays for the fits once.
   */
  fitCache?: Map<ISODate, IndexFit> | undefined;
}

/** Everything the row builder needs, precomputed once per call site. */
interface ReplayContext {
  fit: IndexFit;
  prior: ReturnType<typeof cadencePrior>;
  todayFit: IndexFit;
  priorWeight: number | undefined;
  halfLifeDays: number | undefined;
  sigmaScale: number | undefined;
}

/** A replay row plus the waiting law behind its prediction (for the calibration curve). */
interface ReplayResult {
  row: BacktestRow;
  law: { mu: number; sigma: number; elapsedDays: number; lastDate: ISODate } | null;
}

/**
 * One replay row (REDESIGN §5): the lab's k = 1 prediction made as of `asOf` against its
 * first *flagship* `released` model after `asOf` (none gives `actual: null`, excluded from
 * coverage). errorDays = actual minus predicted median; in68 / in90 = actual inside
 * p16-p84 / p05-p95; actual.theta comes from a fit as of today; thetaError = actual minus predicted.
 */
function replayRow(releases: ModelRelease[], lab: LabId, asOf: ISODate, ctx: ReplayContext): ReplayResult {
  const forecast = forecastLab(lab, releases, ctx.fit, ctx.prior, {
    asOf,
    ...(ctx.priorWeight !== undefined ? { priorWeight: ctx.priorWeight } : {}),
    ...(ctx.halfLifeDays !== undefined ? { halfLifeDays: ctx.halfLifeDays } : {}),
    ...(ctx.sigmaScale !== undefined ? { sigmaScale: ctx.sigmaScale } : {}),
  });
  const pred = forecast.next[0] ?? null;

  // First flagship release strictly after asOf: what actually happened next.
  let actual: { release_id: string; date: ISODate } | null = null;
  for (const r of releases) {
    if (r.lab !== lab || r.status !== 'released' || r.date <= asOf) continue;
    if ((r.tier ?? 'flagship') !== 'flagship') continue;
    if (actual === null || r.date < actual.date || (r.date === actual.date && r.id < actual.release_id)) {
      actual = { release_id: r.id, date: r.date };
    }
  }

  const actualTheta = actual !== null ? (ctx.todayFit.models[actual.release_id]?.theta ?? null) : null;
  const predictedTheta = pred !== null ? pred.theta : null;

  const row: BacktestRow = {
    asOf,
    lab,
    predictedMedian: pred !== null ? pred.medianDate : null,
    p05: pred !== null ? pred.p05Date : null,
    p16: pred !== null ? pred.p16Date : null,
    p84: pred !== null ? pred.p84Date : null,
    p95: pred !== null ? pred.p95Date : null,
    predictedTheta,
    actual: actual !== null ? { release_id: actual.release_id, date: actual.date, theta: actualTheta } : null,
    errorDays: pred !== null && actual !== null ? daysBetween(pred.medianDate, actual.date) : null,
    in68: pred !== null && actual !== null ? pred.p16Date <= actual.date && actual.date <= pred.p84Date
      : null,
    in90: pred !== null && actual !== null ? pred.p05Date <= actual.date && actual.date <= pred.p95Date
      : null,
    thetaError: pred !== null && actual !== null && actualTheta !== null ? actualTheta - pred.theta : null,
  };
  return {
    row,
    law:
      forecast.lastRelease !== null
        ? {
            mu: forecast.mu,
            sigma: forecast.sigma,
            elapsedDays: forecast.elapsedDays,
            lastDate: forecast.lastRelease.date,
          }
        : null,
  };
}

/**
 * Replay one date (REDESIGN §5): fit as of `asOf`, forecast as of `asOf`, one row per lab.
 * `opts.todayFit` avoids refitting the present-day fit; otherwise it is computed once here.
 */
export function backtestAsOf(
  releases: ModelRelease[],
  benchmarks: Benchmark[],
  labIds: LabId[],
  asOf: ISODate,
  opts: {
    priorWeight?: number | undefined;
    halfLifeDays?: number | undefined;
    sigmaScale?: number | undefined;
    todayFit?: IndexFit | undefined;
  } = {},
): BacktestAsOf {
  const ctx: ReplayContext = {
    fit: fitFrontierIndex(releases, benchmarks, { asOf }),
    prior: cadencePrior(releases, asOf, ['flagship'], opts.halfLifeDays ?? 730),
    todayFit: opts.todayFit ?? fitFrontierIndex(releases, benchmarks, {}),
    priorWeight: opts.priorWeight,
    halfLifeDays: opts.halfLifeDays,
    sigmaScale: opts.sigmaScale,
  };
  return { asOf, rows: labIds.map((lab) => replayRow(releases, lab, asOf, ctx).row) };
}

/**
 * Roll the backtest over a grid of `asOf` dates (REDESIGN §5/§11): from `from` (default:
 * first released flagship date + 365 d) to `to - 30 d`, stepping `stepDays`, and aggregate
 * coverage, error and calibration statistics over the rows that have an actual release.
 * The per-`asOf` fit is memoised inside the call; identical input gives an identical report.
 */
export function backtestSeries(
  releases: ModelRelease[],
  benchmarks: Benchmark[],
  labIds: LabId[],
  opts: BacktestSeriesOptions,
): BacktestReport {
  const stepDays = Math.max(1, Math.round(opts.stepDays ?? 30));

  let firstFlagship: ISODate | null = null;
  for (const r of releases) {
    if (r.status !== 'released' || (r.tier ?? 'flagship') !== 'flagship') continue;
    if (firstFlagship === null || r.date < firstFlagship) firstFlagship = r.date;
  }
  const from = opts.from ?? addDays(firstFlagship ?? opts.to, 365);
  const lastGridDate = addDays(opts.to, -30);

  const todayFit = opts.todayFit ?? fitFrontierIndex(releases, benchmarks, {});

  const fitCache = new Map<ISODate, IndexFit>();
  const grid: ISODate[] = [];
  for (let d = from; d <= lastGridDate; d = addDays(d, stepDays)) grid.push(d);

  const rows: BacktestRow[] = [];
  type LabAgg = { n: number; hits68: number; hits90: number; absSum: number; signedSum: number };
  const perLab = new Map<LabId, LabAgg>();
  let unforecastable = 0;
  // (lab, asOf) -> the waiting law of the k = 1 prediction made there, for the calibration
  // curve (which needs quantiles other than the four published percentile dates).
  const law = new Map<string, { mu: number; sigma: number; elapsedDays: number; lastDate: ISODate }>();

  for (const asOf of grid) {
    let fit = fitCache.get(asOf);
    if (!fit) {
      fit = fitFrontierIndex(releases, benchmarks, { asOf });
      fitCache.set(asOf, fit);
    }
    const ctx: ReplayContext = {
      fit,
      prior: cadencePrior(releases, asOf, ['flagship'], opts.halfLifeDays ?? 730),
      todayFit,
      priorWeight: opts.priorWeight,
      halfLifeDays: opts.halfLifeDays,
      sigmaScale: opts.sigmaScale,
    };
    for (const lab of labIds) {
      const { row, law: waitingLaw } = replayRow(releases, lab, asOf, ctx);
      rows.push(row);
      if (waitingLaw !== null) law.set(`${lab}|${asOf}`, waitingLaw);

      const agg = perLab.get(lab) ?? { n: 0, hits68: 0, hits90: 0, absSum: 0, signedSum: 0 };
      if (row.actual !== null) {
        if (row.predictedMedian !== null) {
          // Forecastable row: the only ones coverage and errors are measured over.
          agg.n += 1;
          if (row.in68 === true) agg.hits68 += 1;
          if (row.in90 === true) agg.hits90 += 1;
          if (row.errorDays !== null) {
            agg.absSum += Math.abs(row.errorDays);
            agg.signedSum += row.errorDays;
          }
        } else {
          unforecastable += 1;
        }
      }
      perLab.set(lab, agg);
    }
  }

  const withActual = rows.filter((r) => r.actual !== null);
  const forecastable = withActual.filter((r) => r.predictedMedian !== null);
  const n = forecastable.length;
  const hits68 = forecastable.filter((r) => r.in68 === true).length;
  const hits90 = forecastable.filter((r) => r.in90 === true).length;
  const withError = forecastable.filter((r) => r.errorDays !== null);
  const absMean = withError.reduce((s, r) => s + Math.abs(r.errorDays!), 0);
  const signedMean = withError.reduce((s, r) => s + r.errorDays!, 0);
  const maeDays = withError.length > 0 ? absMean / withError.length : 0;
  const biasDays = withError.length > 0 ? signedMean / withError.length : 0;
  const medianAbsDays = withError.length > 0 ? median(withError.map((r) => Math.abs(r.errorDays!))) : 0;

  const thetaPairs = forecastable.filter((r) => r.thetaError !== null);
  const thetaMae =
    thetaPairs.length > 0
      ? thetaPairs.reduce((s, r) => s + Math.abs(r.thetaError!), 0) / thetaPairs.length
      : null;

  const byLab: BacktestReport['byLab'] = {} as BacktestReport['byLab'];
  for (const lab of labIds) {
    const agg = perLab.get(lab) ?? { n: 0, hits68: 0, hits90: 0, absSum: 0, signedSum: 0 };
    byLab[lab] = {
      n: agg.n,
      coverage68: agg.n > 0 ? agg.hits68 / agg.n : 0,
      coverage90: agg.n > 0 ? agg.hits90 / agg.n : 0,
      maeDays: agg.n > 0 ? agg.absSum / agg.n : 0,
    };
  }

  // Calibration (REDESIGN §5): for nominal q, the share of actual dates at or before the
  // q-quantile date of the prediction - lastRelease + conditional quantile of the waiting law.
  // Perfect calibration gives observed = nominal. Rows without a prediction cannot contribute.
  const calibration = CALIBRATION_NOMINAL.map((nominal) => {
    let covered = 0;
    let counted = 0;
    for (const r of forecastable) {
      const ms = law.get(`${r.lab}|${r.asOf}`);
      if (!ms) continue;
      const days = lognormalConditionalQuantile(ms.mu, ms.sigma, Math.max(0, ms.elapsedDays), nominal);
      if (r.actual!.date <= addDays(ms.lastDate, days)) covered += 1;
      counted += 1;
    }
    return { nominal, observed: counted > 0 ? covered / counted : 0 };
  });

  return {
    from,
    to: opts.to,
    stepDays,
    n,
    unforecastable,
    coverage68: n > 0 ? hits68 / n : 0,
    coverage90: n > 0 ? hits90 / n : 0,
    maeDays,
    medianAbsDays,
    biasDays,
    thetaMae,
    byLab,
    calibration,
    sigmaScale: opts.sigmaScale ?? 1,
    halfLifeDays: opts.halfLifeDays ?? 730,
    rows,
  };
}

/** Median of a list (mean of the two middle values when even); 0 for an empty list. */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export interface CalibrateForecastResult {
  /** The winning σ multiplier. */
  sigmaScale: number;
  /** The full report produced with the winning scale. */
  report: BacktestReport;
  /** Loss `|cov68 − 0.68| + |cov90 − 0.90|` of the winner. */
  loss: number;
}

/**
 * Grid-search the σ multiplier (REDESIGN §5, iteration 2): try `sigmaScale ∈ {1.0, 1.1, …, 3.0}`
 * and pick the scale minimising `|cov68 − 0.68| + |cov90 − 0.90|` on `backtestSeries`
 * (ties → the smaller scale, i.e. the first minimum in scan order). The per-`asOf` fits do not
 * depend on the scale, so one shared `fitCache` serves the whole search and the cost is one
 * grid of fits plus 21 cheap forecast passes.
 */
export function calibrateForecast(
  releases: ModelRelease[],
  benchmarks: Benchmark[],
  labIds: LabId[],
  opts: {
    to: ISODate;
    stepDays?: number | undefined;
    halfLifeDays?: number | undefined;
    from?: ISODate | undefined;
  },
): CalibrateForecastResult {
  const fitCache = new Map<ISODate, IndexFit>();
  let best: CalibrateForecastResult | null = null;
  for (let k = 10; k <= 30; k++) {
    const sigmaScale = k / 10;
    const report = backtestSeries(releases, benchmarks, labIds, {
      to: opts.to,
      ...(opts.stepDays !== undefined ? { stepDays: opts.stepDays } : {}),
      ...(opts.halfLifeDays !== undefined ? { halfLifeDays: opts.halfLifeDays } : {}),
      ...(opts.from !== undefined ? { from: opts.from } : {}),
      sigmaScale,
      fitCache,
    });
    const loss = Math.abs(report.coverage68 - 0.68) + Math.abs(report.coverage90 - 0.9);
    if (best === null || loss < best.loss) best = { sigmaScale, report, loss };
  }
  return best!;
}
