/**
 * Stages — the y-axis ladder of levels, the frontier trend with its fan, past/predicted
 * crossings of those levels and the pace eras (REDESIGN §2, §4 frontier fan only).
 * Everything is derived from the fit and the frontier line; the only prose in the maths
 * are the regime names. Pure functions, no I/O.
 */
import type {
  Benchmark,
  Crossing,
  Era,
  FrontierTrend,
  ISODate,
  Level,
  PaceRegime,
} from './types';
import type { FanPoint } from './prediction';
import type { FrontierPoint, IndexFit } from './frontier-index';
import { frontierPace, indexFromTheta, logit, thetaFromIndex } from './frontier-index';
import { dateToDayNumber, dayNumberToDate } from './timeline';
import { ratingFromTheta } from './rating';

/** Saturation level of a percent benchmark: the θ at which it stops discriminating (REDESIGN §2.1). */
export const SATURATION_P = 0.95;

/** Upper bounds of the pace regimes in logits/yr (REDESIGN §2.3); ≥ 3 is takeoff. */
export const PACE_REGIMES = { dormant: 0.5, climb: 1.5, acceleration: 3 } as const;

/** Normal quantiles used for the crossing windows and the trend fan. */
const Z90 = 1.2816;
const Z05 = 1.6449;

/** Classify a pace in logits/yr: < 0.5 dormant, < 1.5 climb, < 3 acceleration, else takeoff. */
export function regimeOf(paceLogitsPerYear: number): PaceRegime {
  if (paceLogitsPerYear < PACE_REGIMES.dormant) return 'dormant';
  if (paceLogitsPerYear < PACE_REGIMES.climb) return 'climb';
  if (paceLogitsPerYear < PACE_REGIMES.acceleration) return 'acceleration';
  return 'takeoff';
}

/**
 * The ladder of levels (REDESIGN §2.1), sorted ascending by θ:
 *
 * - `human` per benchmark with `human_baseline` and `in_index`: θ = δ_b + logit(h/100).
 * - `saturation` per observed `%`-unit index benchmark: θ = δ_b + logit(0.95). Elo-unit
 *   benchmarks have no ceiling and are skipped.
 * - `generation` per generation present: mean of that generation's saturation θ.
 * - `ceiling`: max saturation θ over non-legacy index benchmarks.
 *
 * Only benchmarks with an observed δ count — "observed" means some fitted model's `used`
 * entry references the benchmark id (a δ of exactly 0 alone proves nothing).
 */
export function benchmarkLevels(fit: IndexFit, benchmarks: Benchmark[]): Level[] {
  const observed = new Set<string>();
  for (const m of Object.values(fit.models)) for (const u of m.used) observed.add(u.benchmark);

  const byId = new Map(benchmarks.map((b) => [b.id, b]));
  const saturationTheta = new Map<string, number>(); // benchmark id → θ
  const generationSat = new Map<number, number[]>(); // generation → saturation θ values

  const levels: Level[] = [];
  for (const id of fit.benchmarksInIndex) {
    if (!observed.has(id)) continue;
    const b = byId.get(id);
    if (!b) continue;
    const d = fit.difficulties[id];
    if (d === undefined) continue;

    // h ≥ 100 has no finite logit — such a "baseline" is not a usable level.
    if (b.human_baseline !== null && b.human_baseline > 0 && b.human_baseline < 100) {
      const theta = d + logit(b.human_baseline / 100);
      levels.push({
        id: `human:${b.id}`,
        kind: 'human',
        label: `Human experts · ${b.short} ${b.human_baseline} %`,
        theta,
        rating: ratingFromTheta(theta),
        benchmark: b.id,
      });
    }

    if (b.unit === '%') {
      const theta = d + logit(SATURATION_P);
      saturationTheta.set(b.id, theta);
      const gens = generationSat.get(b.generation) ?? [];
      gens.push(theta);
      generationSat.set(b.generation, gens);
      levels.push({
        id: `sat:${b.id}`,
        kind: 'saturation',
        label: `Saturated · ${b.short} (95 %)`,
        theta,
        rating: ratingFromTheta(theta),
        benchmark: b.id,
      });
    }
  }

  for (const [gen, thetas] of [...generationSat.entries()].sort((a, b) => a[0] - b[0])) {
    const theta = thetas.reduce((s, t) => s + t, 0) / thetas.length;
    levels.push({
      id: `gen:${gen}`,
      kind: 'generation',
      label: `Generation ${gen} basket saturated`,
      theta,
      rating: ratingFromTheta(theta),
      generation: gen,
    });
  }

  let ceilingTheta = Number.NEGATIVE_INFINITY;
  for (const id of fit.benchmarksInIndex) {
    const b = byId.get(id);
    if (!b || b.legacy) continue;
    const t = saturationTheta.get(id);
    if (t !== undefined && t > ceilingTheta) ceilingTheta = t;
  }
  if (Number.isFinite(ceilingTheta)) {
    levels.push({
      id: 'ceiling',
      kind: 'ceiling',
      label: 'Current basket ceiling',
      theta: ceilingTheta,
      rating: ratingFromTheta(ceilingTheta),
    });
  }

  return levels.sort((a, b) => a.theta - b.theta);
}

/**
 * OLS of θ (= thetaFromIndex(index)) of the running-maximum step function, sampled daily over
 * the trailing `windowDays` ending at `asOf` — the same sampling rules as `frontierPace`:
 * days before the first knot are excluded and fewer than 2 knots in the window give null
 * (REDESIGN §2.2).
 *
 * `intercept` is θ at day number 0: fitting `y = a + b·x` with `x = d − from` gives
 * `θ(d) = a + b·(d − from)`, i.e. `intercept = a − b·from`, so `θ(d) = intercept + b·d`
 * for any day number d.
 */
export function frontierTrend(line: FrontierPoint[], asOf: ISODate, windowDays = 365): FrontierTrend | null {
  if (line.length === 0) return null;
  const endDay = dateToDayNumber(asOf);
  const startDay = endDay - Math.max(0, Math.round(windowDays));
  let steps = 0;
  for (const p of line) {
    const d = dateToDayNumber(p.date);
    if (d >= startDay && d <= endDay) steps++;
  }
  if (steps < 2) return null;

  const knotDays = line.map((p) => dateToDayNumber(p.date));
  const from = Math.max(startDay, knotDays[0]!);
  if (endDay < from) return null;

  // Sample the step function daily and accumulate the normal equations.
  let ptr = -1;
  let cur = 0;
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let d = from; d <= endDay; d++) {
    while (ptr + 1 < line.length && knotDays[ptr + 1]! <= d) {
      ptr++;
      cur = thetaFromIndex(line[ptr]!.index);
    }
    if (ptr < 0) continue;
    const x = d - from;
    n++;
    sx += x;
    sy += cur;
    sxx += x * x;
    sxy += x * cur;
    syy += cur * cur;
  }
  if (n < 2) return null;
  const denom = sxx - (sx * sx) / n; // centred Sxx
  if (!(denom > 0)) return null;

  const sCxy = sxy - (sx * sy) / n; // centred Sxy
  const slopePerDay = sCxy / denom;
  const a = sy / n - slopePerDay * (sx / n); // fit at x = d − from
  const intercept = a - slopePerDay * from; // θ(d) = intercept + slope·d
  // SSE = centred Syy − Sxy²/Sxx (the intercept absorbs the means).
  const sCyy = syy - (sy * sy) / n;
  const sse = Math.max(0, sCyy - (sCxy * sCxy) / denom);
  const residualSigma = Math.sqrt(sse / (n - 2));
  const slopeSe = residualSigma / Math.sqrt(denom);

  return {
    slopePerDay,
    intercept,
    slopeSe,
    residualSigma,
    n,
    windowDays: Math.round(windowDays),
    refDay: endDay,
  };
}

/**
 * The frontier trend fan (REDESIGN §4): θ̂ = intercept + slope·d, half-width
 * `Z90 · sqrt(residualSigma² + (slopeSe·(d − refDay))²)`, mapped through indexFromTheta.
 * The axis is unbounded, so θ is never clamped — the index conversion saturates by itself.
 * Sampled every `stepDays` from `asOf`, with the `toDate` sample always included (the idea of
 * `fanTo` in web/src/data.ts, reimplemented here so web code stays out of shared).
 * Empty when there is no trend.
 */
export function frontierFan(
  line: FrontierPoint[],
  asOf: ISODate,
  opts: { toDate: ISODate; stepDays?: number; windowDays?: number },
): FanPoint[] {
  const trend = frontierTrend(line, asOf, opts.windowDays ?? 365);
  if (!trend) return [];
  const step = Math.max(1, Math.round(opts.stepDays ?? 7));
  const startDay = dateToDayNumber(asOf);
  const endDay = dateToDayNumber(opts.toDate);
  if (endDay < startDay) return [];

  const days: number[] = [];
  for (let d = startDay; d <= endDay; d += step) days.push(d);
  if (days[days.length - 1] !== endDay) days.push(endDay);

  return days.map((d) => {
    const theta = trend.intercept + trend.slopePerDay * d;
    const dd = d - trend.refDay;
    const half = Z90 * Math.sqrt(trend.residualSigma * trend.residualSigma
      + (trend.slopeSe * dd) * (trend.slopeSe * dd));
    return {
      date: dayNumberToDate(d),
      low: indexFromTheta(theta - half),
      mid: indexFromTheta(theta),
      high: indexFromTheta(theta + half),
      theta,
      thetaLow: theta - half,
      thetaHigh: theta + half,
    };
  });
}

/**
 * Past and predicted crossings of the levels (REDESIGN §2.2).
 *
 * - `past`: the first frontier knot whose θ ≥ level.theta.
 * - `predicted`: from the frontier trend, for levels not yet passed and slope b > 0:
 *   t* = refDay + (L − θ̂(refDay)) / b, delta-method variance
 *   var(t*) = ((L − θ̂)/b²)²·se_b² + (σ_res / b)², normal quantiles at z = 0, ±1, ±1.6449
 *   (median = t*, p16 = t* − 1·sd, p84 = t* + 1·sd, p05 = t* − 1.6449·sd, p95 = t* + 1.6449·sd).
 *   Every quantile is clamped to ≥ asOf; medians more than `maxYears` after asOf are dropped.
 * Returns past crossings first, then predicted ones, each group ascending in θ.
 */
export function frontierCrossings(
  line: FrontierPoint[],
  levels: Level[],
  asOf: ISODate,
  opts: { windowDays?: number; maxYears?: number } = {},
): Crossing[] {
  const trend = frontierTrend(line, asOf, opts.windowDays ?? 365);
  const refDay = dateToDayNumber(asOf);
  const past: Crossing[] = [];
  const predicted: Crossing[] = [];
  const maxDays = (opts.maxYears ?? 15) * 365;

  for (const level of levels) {
    let passedAt: FrontierPoint | null = null;
    for (const p of line) {
      if (thetaFromIndex(p.index) >= level.theta) {
        passedAt = p;
        break;
      }
    }
    if (passedAt) {
      past.push({
        level,
        kind: 'past',
        date: passedAt.date,
        release_id: passedAt.release_id,
        lab: passedAt.lab,
      });
      continue;
    }

    if (!trend || trend.slopePerDay <= 0) continue;
    const b = trend.slopePerDay;
    const thetaRef = trend.intercept + b * refDay;
    const dt = (level.theta - thetaRef) / b;
    if (dt <= 0) continue;
    if (dt > maxDays) continue;
    const varT = ((level.theta - thetaRef) / (b * b)) ** 2 * trend.slopeSe ** 2
      + (trend.residualSigma / b) ** 2;
    const sd = Math.sqrt(varT);
    const iso = (day: number): ISODate => {
      const clamped = Math.max(day, refDay);
      return dayNumberToDate(clamped);
    };
    const medianDay = refDay + dt;
    predicted.push({
      level,
      kind: 'predicted',
      date: iso(medianDay),
      p05: iso(medianDay - Z05 * sd),
      p16: iso(medianDay - 1 * sd),
      p84: iso(medianDay + 1 * sd),
      p95: iso(medianDay + Z05 * sd),
    });
  }

  return [...past, ...predicted];
}

/** First day of the month `offset` months after `iso` (offset may be negative). */
function firstOfMonth(iso: ISODate, offset = 0): ISODate {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7)) - 1 + offset;
  return `${y + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}-01`;
}

/**
 * Pace regimes over time (REDESIGN §2.3): a monthly grid (first of each month) from the first
 * knot + `windowDays` to `asOf`; at each month the trailing-year `frontierPace` is classified
 * with `regimeOf` (months without a pace are skipped), and consecutive months in the same regime
 * merge into one era. The last era is open (`end: null`). Empty when fewer than two months.
 */
export function paceEras(line: FrontierPoint[], asOf: ISODate, opts: { windowDays?: number } = {}): Era[] {
  if (line.length === 0) return [];
  const windowDays = opts.windowDays ?? 365;
  const firstKnot = line[0]!.date;
  const gridStart = firstOfMonth(firstOfMonth(firstKnot), 1); // first month start after the first knot
  const startDay = dateToDayNumber(firstKnot) + Math.max(0, Math.round(windowDays));
  const endDay = dateToDayNumber(asOf);
  if (endDay < startDay) return [];

  // Month starts with day number ≥ startDay, up to and including asOf.
  const months: { date: ISODate; day: number }[] = [];
  for (let iso = gridStart; dateToDayNumber(iso) <= endDay; iso = firstOfMonth(iso, 1)) {
    const day = dateToDayNumber(iso);
    if (day >= startDay) months.push({ date: iso, day });
  }
  if (months.length < 2) return [];

  interface MonthPace { date: ISODate; regime: PaceRegime; pace: number }
  const paced: MonthPace[] = [];
  for (const { date } of months) {
    const pace = frontierPace(line, date, windowDays);
    if (pace) paced.push({ date, regime: regimeOf(pace.logitsPerYear), pace: pace.logitsPerYear });
  }
  if (paced.length < 2) return [];

  const eras: Era[] = [];
  let start = paced[0]!.date;
  let regime = paced[0]!.regime;
  let paces = [paced[0]!.pace];
  let maxPace = paced[0]!.pace;
  const flush = (endDate: ISODate | null): void => {
    const meanPace = paces.reduce((s, p) => s + p, 0) / paces.length;
    eras.push({ start, end: endDate, regime, meanPace, maxPace });
  };
  for (let i = 1; i < paced.length; i++) {
    const cur = paced[i]!;
    if (cur.regime !== regime) {
      flush(cur.date);
      start = cur.date;
      regime = cur.regime;
      paces = [];
      maxPace = cur.pace;
    } else if (cur.pace > maxPace) {
      maxPace = cur.pace;
    }
    paces.push(cur.pace);
  }
  flush(null);
  return eras;
}

/** Regime of the projected pace: the current trend slope expressed per year; null without a trend. */
export function projectedEra(trend: FrontierTrend | null): PaceRegime | null {
  if (!trend) return null;
  return regimeOf(trend.slopePerDay * 365);
}
