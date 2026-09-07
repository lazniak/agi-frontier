/** Geometry, scales and the editorial tick ladders for the frontier chart. */
import { scaleLinear, scaleTime, type ScaleTime } from 'd3-scale';
import { ratingFromTheta, thetaFromRating } from '@agi/shared';
import { indexFromTheta, thetaFromIndex, type ISODate } from '@agi/shared';

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Geom {
  width: number;
  height: number;
  m: Margins;
  /** Inner plot area. */
  iw: number;
  ih: number;
  /** Convenience edges. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  compact: boolean;
  /** Is the right-hand gutter wide enough for the lab end-labels? */
  endLabels: boolean;
  /** The pace strip under the plot: top edge and height (0 when there is no room). */
  paceTop: number;
  paceH: number;
}

export type XScale = ScaleTime<number, number>;

/**
 * The y axis is linear in the latent ability theta either way — only the *labels* differ:
 * `rating` reads the unbounded Frontier Rating (1000 + 173.72·theta), `index` reads the bounded
 * Frontier Index (100·sigma(theta)). Both take and return *index* units at the edges of the
 * domain for backwards compatibility, but the domain itself is carried in theta via `makeY`.
 */
export type YMode = 'rating' | 'index';

export interface YScale {
  (index: number): number;
  invert(px: number): number;
  /** Domain in index units. */
  domain(): [number, number];
  /** Domain in latent theta — the axis' native units. */
  thetaDomain(): [number, number];
  range(): [number, number];
  mode: YMode;
}

const DAY = 86_400_000;

/** Below this the right-hand gutter cannot hold a lab name without eating the plot. */
const END_LABEL_MIN_WIDTH = 560;
/** Height of the pace strip (frontier gain per quarter) under the plot. */
const PACE_H = 54;
const PACE_H_COMPACT = 40;
/** Gap between the x-axis labels / leadership stripe and the pace strip. */
const PACE_GAP = 44;
/** Right-hand gutter: the level ladder lives here (REDESIGN §7.1). */
export const GUTTER_RIGHT = 144;
export const GUTTER_RIGHT_COMPACT = 84;

export function geometry(width: number, height: number): Geom {
  const compact = width < 720;
  const endLabels = width >= END_LABEL_MIN_WIDTH;
  const paceH = height < 360 ? 0 : compact ? PACE_H_COMPACT : PACE_H;
  const gutter = compact ? GUTTER_RIGHT_COMPACT : GUTTER_RIGHT;
  const m: Margins = {
    // The "Frontier Rating" caption sits above the plot, clear of the top tick and the scrubber.
    top: compact ? 32 : 38,
    right: Math.max(endLabels ? (compact ? 76 : 96) : 20, gutter),
    bottom: (compact ? 58 : 66) + (paceH ? paceH + PACE_GAP - (compact ? 12 : 8) : 0),
    left: compact ? 38 : 54,
  };
  const iw = Math.max(10, width - m.left - m.right);
  const ih = Math.max(10, height - m.top - m.bottom);
  const y0 = m.top + ih;
  return {
    width,
    height,
    m,
    iw,
    ih,
    x0: m.left,
    x1: m.left + iw,
    y0,
    y1: m.top,
    compact,
    endLabels,
    paceTop: y0 + PACE_GAP + (compact ? 4 : 8),
    paceH,
  };
}

/** UTC midnight for an ISO day — every date in the dataset is a UTC day. */
export function toDate(iso: ISODate): Date {
  return new Date(`${iso}T00:00:00Z`);
}

export function fromDate(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function makeX(domain: [Date, Date], geom: Geom): XScale {
  return scaleTime().domain(domain).range([geom.x0, geom.x1]);
}

/**
 * The y scale: linear in theta, unbounded. It is constructed from a theta domain and converts
 * index values to pixels through the logit, so every layer can keep drawing with `y(index)`.
 * Nothing here clamps to [0, 100] — the rating axis has no ceiling.
 */
export function makeY(domain: [number, number], geom: Geom, mode: YMode): YScale {
  void mode; // the pixel mapping is identical; only the tick labels differ
  const lin = scaleLinear().domain(domain).range([geom.y0, geom.y1]).clamp(false);
  const y = ((v: number) => lin(thetaFromIndex(clampIndex(v)))) as YScale;
  y.invert = (px) => indexFromTheta(lin.invert(px));
  y.domain = () => [indexFromTheta(domain[0]), indexFromTheta(domain[1])];
  y.thetaDomain = () => [domain[0], domain[1]];
  y.range = () => [geom.y0, geom.y1];
  y.mode = mode;
  return y;
}

/** Index values are clipped to the same band as the fit before taking the logit. */
const LOGIT_LO = 0.5;
const LOGIT_HI = 99.5;

function clampIndex(v: number): number {
  return v < LOGIT_LO ? LOGIT_LO : v > LOGIT_HI ? LOGIT_HI : v;
}

/* ------------------------------------------------------------------- ticks */

export interface TimeTick {
  date: Date;
  label: string;
  /** Year boundaries get a stronger rule and a heavier label. */
  major: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A tick ladder that stays readable at every zoom level: years far out, quarters,
 * then months, then fortnights. January always reads as the year.
 */
export function timeTicks(x: XScale, maxTicks: number): TimeTick[] {
  const dom = x.domain();
  const a = dom[0] ?? new Date(0);
  const b = dom[1] ?? new Date(0);
  const spanDays = (b.getTime() - a.getTime()) / DAY;
  const out: TimeTick[] = [];

  const push = (d: Date, label: string, major: boolean): void => {
    if (d >= a && d <= b) out.push({ date: d, label, major });
  };

  if (spanDays > 2400) {
    // Years only. Every year is a major tick and majors are never thinned, so pick the stride
    // from the pixel budget here: nine years on a phone become 2019 · 2021 · 2023 · 2025.
    const step = Math.max(1, Math.ceil(spanDays / 365.25 / Math.max(1, maxTicks)));
    const first = a.getUTCFullYear();
    const start = first + ((step - (first % step)) % step);
    for (let y = start; y <= b.getUTCFullYear() + 1; y += step) {
      push(new Date(Date.UTC(y, 0, 1)), String(y), true);
    }
  } else if (spanDays > 1000) {
    for (let y = a.getUTCFullYear(); y <= b.getUTCFullYear() + 1; y++) {
      for (let q = 0; q < 4; q++) {
        const d = new Date(Date.UTC(y, q * 3, 1));
        push(d, q === 0 ? String(y) : `Q${q + 1}`, q === 0);
      }
    }
  } else if (spanDays > 120) {
    const step = spanDays > 430 ? 2 : 1;
    for (let y = a.getUTCFullYear(); y <= b.getUTCFullYear() + 1; y++) {
      for (let mo = 0; mo < 12; mo += step) {
        const d = new Date(Date.UTC(y, mo, 1));
        push(d, mo === 0 ? String(y) : (MONTHS[mo] ?? ''), mo === 0);
      }
    }
  } else {
    const start = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1));
    for (let i = 0; i < 200; i++) {
      const d = new Date(start.getTime() + i * 14 * DAY);
      if (d > b) break;
      push(d, `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ''}`, d.getUTCDate() <= 14 && d.getUTCMonth() === 0);
    }
  }

  return thin(out, x, maxTicks);
}

/**
 * Thin the ladder by *pixel* distance rather than by index: keeping every n-th tick regardless of
 * where it lands is what puts "Q2" hard against "2024" on a narrow chart. Year marks always win —
 * a quarter that crowds one is dropped, never the other way round.
 */
function thin(ticks: TimeTick[], x: XScale, maxTicks: number): TimeTick[] {
  const range = x.range();
  const width = Math.abs((range[1] ?? 0) - (range[0] ?? 0));
  const minPx = maxTicks > 0 ? width / maxTicks : 0;
  if (!(minPx > 0) || ticks.length <= 1) return ticks;

  // Distance from each tick to the next major, so a minor never squeezes in just before a year.
  const nextMajorX: number[] = new Array(ticks.length).fill(Number.POSITIVE_INFINITY);
  let ahead = Number.POSITIVE_INFINITY;
  for (let i = ticks.length - 1; i >= 0; i--) {
    nextMajorX[i] = ahead;
    if (ticks[i]!.major) ahead = x(ticks[i]!.date);
  }

  const kept: TimeTick[] = [];
  let lastX = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i]!;
    const px = x(t.date);
    if (t.major) {
      // A year is never dropped — only the minor labels crowding it are.
      while (kept.length && !kept[kept.length - 1]!.major && px - lastX < minPx) {
        kept.pop();
        const prev = kept[kept.length - 1];
        lastX = prev ? x(prev.date) : Number.NEGATIVE_INFINITY;
      }
    } else if (px - lastX < minPx || (nextMajorX[i] ?? Infinity) - px < minPx) {
      continue;
    }
    kept.push(t);
    lastX = px;
  }
  return kept;
}

/**
 * Round rating steps the axis admits, coarsest first: the ladder generator walks them and keeps
 * a step only when it clears the pixel budget, so zooming in refines 200 → 100 → 50 naturally.
 */
export const RATING_LADDER = [1000, 500, 400, 200, 100, 50, 25, 10, 5, 2, 1];

/** Round index steps for the bounded reading, coarsest first. */
export const INDEX_LADDER = [10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01];

export interface ValueTick {
  /** Position in theta (the axis' native units). */
  theta: number;
  /** The label exactly as drawn (rating or index). */
  label: string;
}

/** `93.1` — trim trailing zeros so ladder steps like 0.5 read clean. */
export function fmtTickLabel(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2)));
}

/**
 * The y-axis ladder for either labelling. Walks the round-step ladder from coarse to fine and
 * keeps a step when it clears `minPx` from everything already kept — the same admission rule as
 * the old logit ladder, now in native units and unbounded in both directions.
 */
export function valueTicks(y: YScale, geom: Geom): ValueTick[] {
  const [tLo, tHi] = y.thetaDomain();
  if (!(tHi > tLo)) return [];
  const ladder = y.mode === 'rating' ? RATING_LADDER : INDEX_LADDER;
  const minPx = geom.compact ? 30 : 26;
  const yOf = y.mode === 'rating' ? ratingFromTheta : indexFromTheta;
  const thetaOf = y.mode === 'rating' ? thetaFromRating : thetaFromIndex;
  const kept: ValueTick[] = [];
  const pxOf = (theta: number): number => y(indexFromTheta(theta));

  for (const step of ladder) {
    const lo = Math.ceil(yOf(tLo) / step - 1e-9) * step;
    const hi = Math.floor(yOf(tHi) / step + 1e-9) * step;
    if (!(hi >= lo)) continue;
    const count = Math.round((hi - lo) / step) + 1;
    if (count > 4000) continue; // pathological zoom, the finer steps will take over
    for (let i = 0; i < count; i++) {
      const value = lo + i * step;
      const theta = thetaOf(value);
      const px = pxOf(theta);
      if (kept.some((k) => Math.abs(pxOf(k.theta) - px) < minPx)) continue;
      kept.push({ theta, label: fmtTickLabel(value) });
    }
    if (kept.length > 1) {
      kept.sort((a, b) => a.theta - b.theta);
      // Already filling the axis at a coarse step — stop refining.
      const densest = kept.slice(1).every((k, i) => pxOf(k.theta) - pxOf(kept[i]!.theta) >= minPx * 2.2);
      if (densest && kept.length >= (geom.compact ? 4 : 6)) break;
    }
  }
  return kept.sort((a, b) => a.theta - b.theta);
}

/**
 * Nice, stable theta bounds so "fit to data" and the resting domain never land on ragged numbers.
 * Rounding happens in theta (quarter-logit steps) — "nice" on this axis — and nothing is clamped
 * to [0, 100]: the rating axis is unbounded above.
 */
export function niceThetaExtent([lo, hi]: [number, number]): [number, number] {
  if (!(hi > lo)) return [-1, 4];
  const step = 0.25;
  return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
}

/* -------------------------------------------------------------- legacy API */

/**
 * @deprecated index-domain variant kept for the panels; the chart uses `niceThetaExtent`.
 */
export function niceExtent([lo, hi]: [number, number]): [number, number] {
  if (!(hi > lo)) return [2, 99];
  const step = 0.25;
  const tl = Math.floor(thetaFromIndex(clampIndex(lo)) / step) * step;
  const th = Math.ceil(thetaFromIndex(clampIndex(hi)) / step) * step;
  return [indexFromTheta(tl), indexFromTheta(th)];
}
