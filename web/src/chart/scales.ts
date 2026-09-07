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
}

export type XScale = ScaleTime<number, number>;
export type YScale = ScaleLinear<number, number>;

const DAY = 86_400_000;

export function geometry(width: number, height: number): Geom {
  const compact = width < 720;
  const m: Margins = {
    top: compact ? 20 : 28,
    right: compact ? 20 : 96,
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

  // Thin out if the ladder still crowds the axis.
  if (out.length > maxTicks) {
    const keep = Math.ceil(out.length / maxTicks);
    return out.filter((t, i) => t.major || i % keep === 0);
  }
  return out;
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
