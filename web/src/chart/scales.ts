/** Geometry, scales and the editorial tick ladder for the frontier chart. */
import { scaleLinear, scaleTime, type ScaleLinear, type ScaleTime } from 'd3-scale';
import type { ISODate } from '@agi/shared';

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
}

export type XScale = ScaleTime<number, number>;
export type YScale = ScaleLinear<number, number>;

const DAY = 86_400_000;

/** Below this the right-hand gutter cannot hold a lab name without eating the plot. */
const END_LABEL_MIN_WIDTH = 560;

export function geometry(width: number, height: number): Geom {
  const compact = width < 720;
  const endLabels = width >= END_LABEL_MIN_WIDTH;
  const m: Margins = {
    // The "Frontier Index" caption sits above the plot, clear of the 100 tick and the scrubber.
    top: compact ? 32 : 38,
    right: endLabels ? (compact ? 76 : 96) : 20,
    bottom: compact ? 58 : 66,
    left: compact ? 38 : 54,
  };
  const iw = Math.max(10, width - m.left - m.right);
  const ih = Math.max(10, height - m.top - m.bottom);
  return {
    width,
    height,
    m,
    iw,
    ih,
    x0: m.left,
    x1: m.left + iw,
    y0: m.top + ih,
    y1: m.top,
    compact,
    endLabels,
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

export function makeY(domain: [number, number], geom: Geom): YScale {
  return scaleLinear().domain(domain).range([geom.y0, geom.y1]).clamp(false);
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
    const step = spanDays > 7000 ? 2 : 1;
    for (let y = a.getUTCFullYear(); y <= b.getUTCFullYear() + 1; y += step) {
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

export function valueTicks(y: YScale, count: number): number[] {
  const dom = y.domain();
  const lo = dom[0] ?? 0;
  const hi = dom[1] ?? 100;
  if (lo === 0 && hi === 100) return [0, 20, 40, 60, 80, 100];
  return y.ticks(count);
}

/** Nice, stable bounds so "fit to data" never lands on ragged numbers. */
export function niceExtent([lo, hi]: [number, number]): [number, number] {
  if (!(hi > lo)) return [0, 100];
  const step = hi - lo > 40 ? 10 : hi - lo > 16 ? 5 : 2;
  return [Math.max(0, Math.floor(lo / step) * step), Math.min(100, Math.ceil(hi / step) * step)];
}
