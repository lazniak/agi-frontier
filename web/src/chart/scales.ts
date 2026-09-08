/** Geometry, scales, the 2-D view transform and the editorial tick ladders for the frontier chart. */
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
  /**
   * The time-axis strip (REDESIGN §12.1) is a second SVG under the plot; these are its rows in
   * *strip* coordinates. `axisH` holds the leadership stripe and the date labels, the pace strip
   * follows underneath (`paceH` = 0 when the layer is off or there is no room).
   */
  axisH: number;
  /** Total height of the strip SVG: axis rows plus the pace block. */
  stripH: number;
  /** Top edge of the leadership stripe / release ticks inside the strip. */
  stripeY: number;
  /** Baseline of the date labels inside the strip. */
  axisLabelY: number;
  /** The pace strip: top edge and height inside the strip SVG (0 when there is no room). */
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
  /**
   * Pixel of a latent theta directly — no sigmoid round trip. Layers that already hold theta
   * (levels, fans, ribbons, lenses) must use this: `y(indexFromTheta(θ))` loses everything above
   * θ ≈ 5 (index 99.5+) to float saturation, and the rating axis has no ceiling.
   */
  theta(t: number): number;
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
/** Fixed height of the time-axis rows of the strip (REDESIGN §12.1: 40 px). */
export const AXIS_H = 40;
/** Height of the pace bars block under the axis rows. */
const PACE_H = 40;
const PACE_H_COMPACT = 30;
/** Room above the pace bars for their caption. */
const PACE_CAP = 16;
/** Right-hand gutter: the level ladder lives here (REDESIGN §7.1). */
export const GUTTER_RIGHT = 150;
export const GUTTER_RIGHT_COMPACT = 100;

export interface GeomOptions {
  /** Draw the pace block under the axis (the "pace" layer toggle). Default true. */
  pace?: boolean;
}

/**
 * Plot geometry. The plot SVG no longer reserves a bottom margin for the dates or the pace strip:
 * both live in the axis strip, so the plot can pan vertically while the dates stay put.
 */
export function geometry(width: number, height: number, opts: GeomOptions = {}): Geom {
  const compact = width < 720;
  const endLabels = width >= END_LABEL_MIN_WIDTH;
  const gutter = compact ? GUTTER_RIGHT_COMPACT : GUTTER_RIGHT;
  const m: Margins = {
    // The "Frontier Rating" caption sits above the plot, clear of the top tick and the scrubber.
    top: compact ? 32 : 38,
    right: Math.max(endLabels ? (compact ? 76 : 96) : 20, gutter),
    // A hair of room so the bottom-most point is not shaved by the strip.
    bottom: 6,
    // Wide enough for a four-digit rating tick (`2000` is 31 px at 11 px Jost) plus the 10 px the
    // labels sit off the axis; `drawGrid` nudges anything wider still (five digits when zoomed
    // far out) back inside rather than letting the viewport clip it.
    left: compact ? 44 : 54,
  };
  const iw = Math.max(10, width - m.left - m.right);
  const ih = Math.max(10, height - m.top - m.bottom);
  const y0 = m.top + ih;
  const paceH = opts.pace === false ? 0 : compact ? PACE_H_COMPACT : PACE_H;
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
    axisH: AXIS_H,
    stripH: AXIS_H + (paceH ? PACE_CAP + paceH + 4 : 0),
    stripeY: 3,
    axisLabelY: 30,
    paceTop: AXIS_H + PACE_CAP,
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
  // Only the two exact poles of the sigmoid are guarded (their logit is ±Infinity); everything
  // else maps as it is — the old [0.5, 99.5] clamp pinned every rung above rating 1919 to one row.
  const y = ((v: number) => lin(thetaFromIndex(guardIndex(v)))) as YScale;
  y.theta = (t) => lin(t);
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

/** Keep an index strictly inside (0, 100) so its logit is finite; ±40 logits is far off any chart. */
const INDEX_EPS = 100 / (1 + Math.exp(40));

function guardIndex(v: number): number {
  return v < INDEX_EPS ? INDEX_EPS : v > 100 - INDEX_EPS ? 100 - INDEX_EPS : v;
}

/* ---------------------------------------------------------- view transform */

/**
 * The chart's 2-D view (REDESIGN §12.1): independent zoom factors per axis and a translation,
 * applied on top of the *resting* scales. `px = k · basePx + t` on each axis, so `kx`/`ky` can
 * differ — d3-zoom's single `k` could not express "time zoomed in, rating zoomed out", which is
 * exactly what Ctrl+wheel / Shift+wheel ask for. Identity = the resting view.
 */
export interface View2D {
  kx: number;
  ky: number;
  tx: number;
  ty: number;
}

export const VIEW_IDENTITY: View2D = { kx: 1, ky: 1, tx: 0, ty: 0 };

/** Zoom range per axis (REDESIGN §12.1). */
export const K_MIN = 0.25;
export const K_MAX = 60;

/** Is the view the resting one (within float noise)? */
export function isIdentity(v: View2D): boolean {
  return Math.abs(v.kx - 1) < 1e-9 && Math.abs(v.ky - 1) < 1e-9 && Math.abs(v.tx) < 1e-6 && Math.abs(v.ty) < 1e-6;
}

/** The base x scale seen through the view: the domain that lands on the plot's range. */
export function viewX(base: XScale, v: View2D): XScale {
  if (v.kx === 1 && v.tx === 0) return base;
  const range = base.range();
  const r0 = range[0] ?? 0;
  const r1 = range[1] ?? 0;
  const d0 = base.invert((r0 - v.tx) / v.kx);
  const d1 = base.invert((r1 - v.tx) / v.kx);
  return base.copy().domain([d0, d1]) as XScale;
}

/**
 * The theta domain seen through the view's y half. The resting domain maps to the plot range;
 * the view rescales it exactly like `viewX` does for time.
 */
export function viewThetaDomain(rest: [number, number], geom: Geom, v: View2D): [number, number] {
  if (v.ky === 1 && v.ty === 0) return rest;
  const lin = scaleLinear().domain(rest).range([geom.y0, geom.y1]).clamp(false);
  return [lin.invert((geom.y0 - v.ty) / v.ky), lin.invert((geom.y1 - v.ty) / v.ky)];
}

/**
 * Zoom the view about a pixel point: the data under `(px, py)` stays under the pointer. Factors
 * are clamped to [K_MIN, K_MAX] per axis; a factor of 1 leaves that axis alone.
 */
export function zoomAbout(v: View2D, fx: number, fy: number, px: number, py: number): View2D {
  const kx = clampK(v.kx * fx);
  const ky = clampK(v.ky * fy);
  const rx = kx / v.kx;
  const ry = ky / v.ky;
  return { kx, ky, tx: px - (px - v.tx) * rx, ty: py - (py - v.ty) * ry };
}

export function clampK(k: number): number {
  return k < K_MIN ? K_MIN : k > K_MAX ? K_MAX : k;
}

/**
 * Translation limits (REDESIGN §12.1). Time may travel 1.5 plot widths beyond the resting window
 * on either side. Rating is unbounded *upward* but bounded below: the row for rating 0 may never
 * rise above the plot's bottom edge, so `floorPx` — where rating 0 sits in the *base* y scale —
 * must map at or below `geom.y0` through the view.
 */
export function constrainView(v: View2D, geom: Geom, floorPx: number): View2D {
  const out = { ...v };
  // x: base px of the visible edges must stay inside [x0 − 1.5 iw, x1 + 1.5 iw]
  const slack = geom.iw * 1.5;
  const leftBase = (geom.x0 - out.tx) / out.kx;
  const rightBase = (geom.x1 - out.tx) / out.kx;
  if (leftBase < geom.x0 - slack) out.tx = geom.x0 - (geom.x0 - slack) * out.kx;
  else if (rightBase > geom.x1 + slack) out.tx = geom.x1 - (geom.x1 + slack) * out.kx;
  // y: the floor row (rating 0) must not rise above the plot bottom
  const floorView = floorPx * out.ky + out.ty;
  if (floorView < geom.y0) out.ty = geom.y0 - floorPx * out.ky;
  return out;
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
  } else if (spanDays > 20) {
    const start = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1));
    for (let i = 0; i < 200; i++) {
      const d = new Date(start.getTime() + i * 14 * DAY);
      if (d > b) break;
      push(d, `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ''}`, d.getUTCDate() <= 14 && d.getUTCMonth() === 0);
    }
  } else {
    // Days: the deepest zoom the 60× limit allows still needs a label or two.
    const start = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate()));
    for (let i = 0; i < 200; i++) {
      const d = new Date(start.getTime() + i * DAY);
      if (d > b) break;
      push(d, `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ''}`, d.getUTCDate() === 1);
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
 * Round rating steps the axis admits, finest first. The step is chosen from the pixel density
 * (REDESIGN §12.1): the smallest one whose rows are at least `minPx` apart, so zooming out walks
 * 50 → 100 → 200 → 500 → 1000 → 2000 and beyond, and no domain — however tall — runs out of ticks.
 */
export const RATING_LADDER = [1, 2, 5, 10, 25, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];

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
 * The y-axis ladder for either labelling. Rating: one round step chosen from the pixel density,
 * so any visible domain gets evenly spaced nice ticks (the axis is unbounded above). Index: the
 * bounded 0–100 reading keeps the coarse-to-fine admission ladder, because its steps are not
 * evenly spaced in theta.
 */
export function valueTicks(y: YScale, geom: Geom): ValueTick[] {
  const [tLo, tHi] = y.thetaDomain();
  if (!(tHi > tLo)) return [];
  const minPx = geom.compact ? 34 : 30;
  if (y.mode === 'rating') return ratingTicks(tLo, tHi, geom, minPx);
  return indexTicks(y, tLo, tHi, geom, minPx);
}

function ratingTicks(tLo: number, tHi: number, geom: Geom, minPx: number): ValueTick[] {
  const rLo = ratingFromTheta(tLo);
  const rHi = ratingFromTheta(tHi);
  const pxPerUnit = geom.ih / Math.max(1e-9, rHi - rLo);
  let step = RATING_LADDER[RATING_LADDER.length - 1]!;
  for (const s of RATING_LADDER) {
    if (s * pxPerUnit >= minPx) {
      step = s;
      break;
    }
  }
  const lo = Math.ceil(rLo / step - 1e-9) * step;
  const hi = Math.floor(rHi / step + 1e-9) * step;
  const out: ValueTick[] = [];
  if (!(hi >= lo)) return out;
  const count = Math.round((hi - lo) / step) + 1;
  for (let i = 0; i < count && i < 400; i++) {
    const value = lo + i * step;
    out.push({ theta: thetaFromRating(value), label: fmtTickLabel(value) });
  }
  return out;
}

function indexTicks(y: YScale, tLo: number, tHi: number, geom: Geom, minPx: number): ValueTick[] {
  const kept: ValueTick[] = [];
  const pxOf = (theta: number): number => y(indexFromTheta(theta));
  for (const step of INDEX_LADDER) {
    const lo = Math.ceil(indexFromTheta(tLo) / step - 1e-9) * step;
    const hi = Math.floor(indexFromTheta(tHi) / step + 1e-9) * step;
    if (!(hi >= lo)) continue;
    const count = Math.round((hi - lo) / step) + 1;
    if (count > 4000) continue; // pathological zoom, the finer steps will take over
    for (let i = 0; i < count; i++) {
      const value = lo + i * step;
      const theta = thetaFromIndex(value);
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
