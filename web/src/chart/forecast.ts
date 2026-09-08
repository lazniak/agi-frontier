/**
 * Forecast layer: the yellow capability fans, the dashed medians and one *release lens* per
 * predicted release (REDESIGN §12.4) — a shape whose half-thickness at date t is `h · p(t)`, the
 * release-date density from `releaseDensity`, so the lens is thickest where the launch is
 * likeliest. The fill darkens toward the mode, the 68 % window is a stronger inner outline, the
 * 90 % window the outer edge, and a 1.5 px tick marks the median. As `asOf` advances the
 * conditional law narrows and the lens shrinks, exactly like the old circle did.
 *
 * The fans are drawn to whatever the current x-domain needs (recomputed on zoom/pan, memoised by
 * `(lab, asOf, toDate)`), and the chain depth follows the store's forecast mode — `next` draws
 * k = 1 per lab with the spotlight logic, `long` draws the chain (up to 24) with `chainOpacity`.
 *
 * Ten labs forecast into the same months, so non-spotlight labs get a *whisker* — a thin bar
 * from the 16th to the 84th percentile date at the lab's expected theta, with a dot on the
 * median. Same information, a tenth of the ink.
 */
import { area, curveMonotoneX, line } from 'd3-shape';
import { ratingFromTheta } from '@agi/shared';
import type { DensitySample, FanPoint, LabId, PredictedRelease } from '@agi/shared';
import { densityKey, fanHighTheta, fanLowTheta, fanMidTheta, type LabView } from '../data';
import { predictionTooltip } from './tooltip';
import { toDate } from './scales';
import { ANNOUNCED, PREDICT, chainOpacity, type LensShape, type RenderCtx } from './types';
import type { G } from './layers';

const FAN_OPACITY = 0.14;
/** Half-thickness of a lens at its mode, in px: half the 68 % rating window, clamped. */
const LENS_H_MIN = 6;
const LENS_H_MAX = 42;
/** Gradient opacity at the tails and at the mode (REDESIGN §12.4). */
const LENS_TAIL_OPACITY = 0.1;
const LENS_MODE_OPACITY = 0.55;
/** How many labs get the full fan + lens when nothing is focused. */
export const SPOTLIGHT_COUNT = 3;

const DAY_MS = 86_400_000;

interface LensSample {
  x: number;
  p: number;
}

interface LensDatum {
  key: string;
  labId: LabId;
  pred: PredictedRelease;
  /** Density samples in px along time (2nd–98th percentile). */
  samples: LensSample[];
  cx: number;
  cy: number;
  /** Half-thickness at the mode. */
  h: number;
  x05: number;
  x16: number;
  x84: number;
  x95: number;
  /** Where the density peaks, as a 0–1 offset along the sampled window (gradient stop). */
  modeOffset: number;
  colour: string;
  opacity: number;
  /** The single most likely next release gets a soft halo. */
  lead: boolean;
  p30: number;
  p90: number;
  gradientId: string;
}

interface WhiskerDatum {
  key: string;
  labId: LabId;
  pred: PredictedRelease;
  x1: number;
  x2: number;
  cx: number;
  y: number;
  colour: string;
  opacity: number;
  p30: number;
  p90: number;
}

/** Ensure a named sub-group exists. First-call order is the paint order. */
function sub(g: G, cls: string, attrs: Record<string, string> = {}): G {
  let s = g.select<SVGGElement>(`g.${cls}`);
  if (s.empty()) s = g.append('g').attr('class', cls);
  for (const [k, v] of Object.entries(attrs)) s.attr(k, v);
  return s as unknown as G;
}

/**
 * Which labs are drawn in full. The `SPOTLIGHT_COUNT` visible labs with the highest P(30 d),
 * always joined by the focused lab; when few labs are on, all of them.
 */
export function spotlightLabs(views: LabView[], visible: (lab: LabId) => boolean, focus: LabId | null): Set<LabId> {
  const candidates = views.filter((v) => visible(v.lab.id) && v.forecast && v.predictions.some((p) => p.k === 1));
  const out = new Set<LabId>();
  if (candidates.length <= SPOTLIGHT_COUNT + 1) {
    for (const v of candidates) out.add(v.lab.id);
  } else {
    [...candidates]
      .sort((a, b) => b.forecast!.p30 - a.forecast!.p30 || a.lab.id.localeCompare(b.lab.id))
      .slice(0, SPOTLIGHT_COUNT)
      .forEach((v) => out.add(v.lab.id));
  }
  if (focus && candidates.some((v) => v.lab.id === focus)) out.add(focus);
  return out;
}

export function drawFans(g: G, r: RenderCtx): void {
  const { x, y, computed } = r;
  if (!r.layerOn('fans')) {
    g.selectAll('*').remove();
    return;
  }

  const band = area<FanPoint>()
    .x((d) => x(toDate(d.date)))
    .y0((d) => y.theta(fanLowTheta(d)))
    .y1((d) => y.theta(fanHighTheta(d)))
    .curve(curveMonotoneX);

  const mid = line<FanPoint>()
    .x((d) => x(toDate(d.date)))
    .y((d) => y.theta(fanMidTheta(d)))
    .curve(curveMonotoneX);

  // The next-release view keeps the short fan; the long view lets it run to the x-domain edge.
  const fanOf = (v: LabView): FanPoint[] => (r.forecast === 'long' ? v.fan : v.fanNear);
  const views = computed.labViews.filter((v) => r.spotlight.has(v.lab.id) && fanOf(v).length > 1);

  // Fans stay untouched by the focus (REDESIGN §12.2) — no data-lab here on purpose.
  const fillHost = sub(g, 'fan-fills', { opacity: String(FAN_OPACITY), 'pointer-events': 'none' });
  const fans = fillHost.selectAll<SVGPathElement, LabView>('path.fan').data(views, (d) => d.lab.id);
  fans.exit().remove();
  fans
    .enter()
    .append('path')
    .attr('class', 'fan')
    .merge(fans)
    .attr('d', (d) => band(fanOf(d)) ?? '')
    .attr('fill', (d) => (announcedLed(d) ? ANNOUNCED : PREDICT));

  const medHost = sub(g, 'fan-medians', { 'pointer-events': 'none' });
  const meds = medHost.selectAll<SVGPathElement, LabView>('path.fan-median').data(views, (d) => d.lab.id);
  meds.exit().remove();
  meds
    .enter()
    .append('path')
    .attr('class', 'fan-median')
    .merge(meds)
    .attr('d', (d) => mid(fanOf(d)) ?? '')
    .attr('stroke', (d) => (announcedLed(d) ? ANNOUNCED : PREDICT))
    .attr('opacity', 0.8);
}

function announcedLed(v: LabView): boolean {
  return v.predictions[0]?.source === 'announced';
}

/** Density samples → px along time; `day` is fractional so few-day windows stay smooth. */
function toLensSamples(samples: DensitySample[], x: (d: Date) => number): LensSample[] {
  return samples.map((s) => ({ x: x(new Date(s.day * DAY_MS)), p: s.p }));
}

/** Linear interpolation of the density at a pixel position (0 outside the sampled window). */
function pAt(samples: LensSample[], px: number): number {
  if (samples.length === 0) return 0;
  if (px <= samples[0]!.x) return px === samples[0]!.x ? samples[0]!.p : 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if (px <= b.x) {
      const t = b.x === a.x ? 0 : (px - a.x) / (b.x - a.x);
      return a.p + (b.p - a.p) * t;
    }
  }
  return 0;
}

/** The samples inside [xa, xb], with interpolated samples at both edges so the outline closes there. */
function sliceSamples(samples: LensSample[], xa: number, xb: number): LensSample[] {
  const lo = Math.min(xa, xb);
  const hi = Math.max(xa, xb);
  const out: LensSample[] = [{ x: lo, p: pAt(samples, lo) }];
  for (const s of samples) if (s.x > lo && s.x < hi) out.push(s);
  out.push({ x: hi, p: pAt(samples, hi) });
  return out;
}

/**
 * Draw the release lenses and whiskers. Returns the lens footprints for the smart hover.
 */
export function drawPredictions(g: G, r: RenderCtx): LensShape[] {
  const { x, y, computed, ctx } = r;
  if (!r.layerOn('lens')) {
    g.selectAll('*').remove();
    return [];
  }
  const lenses: LensDatum[] = [];
  const whiskers: WhiskerDatum[] = [];
  const dom = x.domain();
  const xLo = dom[0] ?? new Date(0);
  const xHi = dom[1] ?? new Date(0);

  // "Most likely next": the highest P(30 d) among the labs currently drawn. Its k = 1 lens
  // carries a halo, so the eye lands on the release the model actually expects first.
  let leadLab: string | null = null;
  let leadP30 = -1;
  for (const v of computed.labViews) {
    if (!r.visible(v.lab.id) || !v.forecast) continue;
    if (!v.predictions.some((p) => p.k === 1)) continue;
    if (v.forecast.p30 > leadP30) {
      leadP30 = v.forecast.p30;
      leadLab = v.lab.id;
    }
  }

  for (const v of computed.labViews) {
    if (!r.visible(v.lab.id) || !v.forecast) continue;
    const spot = r.spotlight.has(v.lab.id);
    for (const pred of v.predictions) {
      // `next`: one release ahead per lab (the chain reads as noise in that view). `long`: the
      // full chain, spotlight labs as lenses, the rest as whiskers.
      if (pred.k > 1 && r.forecast === 'next') continue;
      if (pred.k > 1 && !(spot || r.forecast === 'next')) continue;
      // Filter to the visible x-domain, not to a fixed horizon — the zoom decides (REDESIGN §4).
      if (pred.medianDate < isoOf(xLo) || pred.medianDate > isoOf(xHi)) continue;
      const announced = pred.source === 'announced';
      const colour = announced ? ANNOUNCED : PREDICT;
      const x16 = x(toDate(pred.p16Date));
      const x84 = x(toDate(pred.p84Date));
      const cx = x(toDate(pred.medianDate));
      const cy = y.theta(pred.theta);
      const opacity = chainOpacity(pred.k);
      const density = computed.densities.get(densityKey(v.lab.id, pred.k)) ?? [];
      if (spot && density.length >= 2) {
        const samples = toLensSamples(density, x);
        // h: half the 68 % rating window in px, clamped so a lens is never a hairline nor a wall.
        const yLo = y.theta(pred.thetaLow ?? pred.theta);
        const yHi = y.theta(pred.thetaHigh ?? pred.theta);
        const h = Math.min(LENS_H_MAX, Math.max(LENS_H_MIN, Math.abs(yLo - yHi) / 2));
        let mode = samples[0]!;
        for (const s of samples) if (s.p > mode.p) mode = s;
        const first = samples[0]!.x;
        const lastX = samples[samples.length - 1]!.x;
        const span = Math.max(1e-6, lastX - first);
        lenses.push({
          key: `${v.lab.id}|${pred.k}`,
          labId: v.lab.id,
          pred,
          samples,
          cx,
          cy,
          h,
          x05: x(toDate(pred.p05Date)),
          x16,
          x84,
          x95: x(toDate(pred.p95Date)),
          modeOffset: Math.min(1, Math.max(0, (mode.x - first) / span)),
          colour,
          opacity,
          lead: pred.k === 1 && v.lab.id === leadLab,
          p30: v.forecast.p30,
          p90: v.forecast.p90,
          gradientId: `${r.glowId}-lens-${v.lab.id}-${pred.k}`,
        });
      } else {
        whiskers.push({
          key: `${v.lab.id}|${pred.k}`,
          labId: v.lab.id,
          pred,
          x1: Math.min(x16, x84),
          x2: Math.max(x16, x84),
          cx,
          y: cy,
          colour,
          opacity: 0.55 * opacity,
          p30: v.forecast.p30,
          p90: v.forecast.p90,
        });
      }
    }
  }

  const key = (d: { key: string }): string => d.key;
  const tip = (d: LensDatum | WhiskerDatum, ev: PointerEvent): void => {
    r.io.tip(predictionTooltip(ctx, d.labId, d.pred, d.p30, d.p90), ev);
  };
  const tipAt = (d: LensDatum | WhiskerDatum, node: Element): void => {
    const box = node.getBoundingClientRect();
    r.io.tip(predictionTooltip(ctx, d.labId, d.pred, d.p30, d.p90), {
      clientX: box.left + box.width / 2,
      clientY: box.top,
    });
  };
  // The rating conversion lives in shared/ (CLAUDE.md: never duplicate the maths). This string is
  // the accessible name of every lens and whisker, so a hard-coded 173.72 here would drift out of
  // step with the scale the moment shared/ changed it.
  const label = (d: LensDatum | WhiskerDatum): string =>
    `Predicted ${ctx.labs.get(d.labId)?.short ?? d.labId} flagship number ${d.pred.k}, median ${d.pred.medianDate}, 68 percent window ${d.pred.p16Date} to ${d.pred.p84Date}, expected rating ${Math.round(ratingFromTheta(d.pred.theta))}`;

  // 0 — whiskers of the labs outside the spotlight (under everything else)
  const whHost = sub(g, 'pred-whiskers');
  const wh = whHost.selectAll<SVGGElement, WhiskerDatum>('g.pred-whisker').data(whiskers, key);
  wh.exit().remove();
  const whEnter = wh.enter().append('g').attr('class', 'pred-whisker').attr('tabindex', 0).attr('role', 'button');
  whEnter.append('line').attr('class', 'pred-whisker__bar');
  whEnter.append('line').attr('class', 'pred-whisker__cap pred-whisker__cap--a');
  whEnter.append('line').attr('class', 'pred-whisker__cap pred-whisker__cap--b');
  whEnter.append('circle').attr('class', 'pred-whisker__dot').attr('r', 2.6);
  whEnter.append('line').attr('class', 'pred-whisker__hit');
  const whAll = whEnter.merge(wh);
  whAll
    .attr('data-lab', (d) => d.labId)
    .attr('opacity', (d) => d.opacity)
    .attr('aria-label', label)
    .on('pointerenter', (ev: PointerEvent, d) => {
      r.io.hoverLab(d.labId);
      tip(d, ev);
    })
    .on('pointermove', (ev: PointerEvent) => r.io.tipMove(ev))
    .on('pointerleave', () => {
      r.io.hoverLab(null);
      r.io.tipHide();
    })
    .on('focus', function (this: SVGGElement, _ev: FocusEvent, d) {
      r.io.hoverLab(d.labId);
      tipAt(d, this);
    })
    .on('blur', () => {
      r.io.hoverLab(null);
      r.io.tipHide();
    });
  whAll
    .select<SVGLineElement>('line.pred-whisker__bar')
    .attr('x1', (d) => d.x1)
    .attr('x2', (d) => d.x2)
    .attr('y1', (d) => d.y)
    .attr('y2', (d) => d.y)
    .attr('stroke', (d) => d.colour);
  whAll
    .select<SVGLineElement>('line.pred-whisker__cap--a')
    .attr('x1', (d) => d.x1)
    .attr('x2', (d) => d.x1)
    .attr('y1', (d) => d.y - 3)
    .attr('y2', (d) => d.y + 3)
    .attr('stroke', (d) => d.colour);
  whAll
    .select<SVGLineElement>('line.pred-whisker__cap--b')
    .attr('x1', (d) => d.x2)
    .attr('x2', (d) => d.x2)
    .attr('y1', (d) => d.y - 3)
    .attr('y2', (d) => d.y + 3)
    .attr('stroke', (d) => d.colour);
  whAll
    .select<SVGCircleElement>('circle.pred-whisker__dot')
    .attr('cx', (d) => d.cx)
    .attr('cy', (d) => d.y)
    .attr('fill', (d) => d.colour);
  whAll
    .select<SVGLineElement>('line.pred-whisker__hit')
    .attr('x1', (d) => d.x1 - 4)
    .attr('x2', (d) => d.x2 + 4)
    .attr('y1', (d) => d.y)
    .attr('y2', (d) => d.y);

  // 1 — the lenses: one group per prediction, gradient + fill + outlines + median tick + hit
  const lensShape = (d: LensDatum): ((s: LensSample[]) => string | null) =>
    area<LensSample>()
      .x((s) => s.x)
      .y0((s) => d.cy + d.h * s.p)
      .y1((s) => d.cy - d.h * s.p)
      .curve(curveMonotoneX);

  const lensHost = sub(g, 'pred-lenses');
  const ls = lensHost.selectAll<SVGGElement, LensDatum>('g.pred-lens').data(lenses, key);
  ls.exit().remove();
  const lsEnter = ls.enter().append('g').attr('class', 'pred-lens');
  const grad = lsEnter.append('linearGradient').attr('gradientUnits', 'userSpaceOnUse').attr('y1', 0).attr('y2', 0);
  grad.append('stop').attr('class', 'lens-stop-a').attr('offset', '0');
  grad.append('stop').attr('class', 'lens-stop-m');
  grad.append('stop').attr('class', 'lens-stop-b').attr('offset', '1');
  lsEnter.append('path').attr('class', 'pred-lens__halo').attr('fill', 'none');
  lsEnter.append('path').attr('class', 'pred-lens__fill').attr('stroke', 'none');
  lsEnter.append('path').attr('class', 'pred-lens__edge90').attr('fill', 'none');
  lsEnter.append('path').attr('class', 'pred-lens__edge68').attr('fill', 'none');
  lsEnter.append('line').attr('class', 'pred-lens__median');
  lsEnter.append('path').attr('class', 'pred-lens__hit').attr('tabindex', 0).attr('role', 'button');
  const lsAll = lsEnter.merge(ls);
  lsAll.attr('data-lab', (d) => d.labId).attr('opacity', (d) => d.opacity);

  lsAll
    .select<SVGLinearGradientElement>('linearGradient')
    .attr('id', (d) => d.gradientId)
    .attr('x1', (d) => d.samples[0]!.x)
    .attr('x2', (d) => d.samples[d.samples.length - 1]!.x);
  lsAll.select('stop.lens-stop-a').attr('stop-color', (d) => d.colour).attr('stop-opacity', LENS_TAIL_OPACITY);
  lsAll
    .select('stop.lens-stop-m')
    .attr('offset', (d) => String(d.modeOffset))
    .attr('stop-color', (d) => d.colour)
    .attr('stop-opacity', LENS_MODE_OPACITY);
  lsAll.select('stop.lens-stop-b').attr('stop-color', (d) => d.colour).attr('stop-opacity', LENS_TAIL_OPACITY);

  lsAll
    .select<SVGPathElement>('path.pred-lens__halo')
    .attr('d', (d) => (d.lead ? (lensShape(d)(sliceSamples(d.samples, d.x16, d.x84)) ?? '') : ''))
    .attr('stroke', (d) => d.colour)
    .attr('filter', `url(#${r.glowId})`);
  // The fill stops at the 90 % window, not at the sampled 2nd–98th percentile: §12.4 calls the
  // 90 % outline "the outer edge", and a paler tail poking out past it reads as a third band.
  lsAll
    .select<SVGPathElement>('path.pred-lens__fill')
    .attr('d', (d) => lensShape(d)(sliceSamples(d.samples, d.x05, d.x95)) ?? '')
    .attr('fill', (d) => `url(#${d.gradientId})`);
  lsAll
    .select<SVGPathElement>('path.pred-lens__edge90')
    .attr('d', (d) => lensShape(d)(sliceSamples(d.samples, d.x05, d.x95)) ?? '')
    .attr('stroke', (d) => d.colour);
  lsAll
    .select<SVGPathElement>('path.pred-lens__edge68')
    .attr('d', (d) => lensShape(d)(sliceSamples(d.samples, d.x16, d.x84)) ?? '')
    .attr('stroke', (d) => d.colour);
  lsAll
    .select<SVGLineElement>('line.pred-lens__median')
    .attr('x1', (d) => d.cx)
    .attr('x2', (d) => d.cx)
    .attr('y1', (d) => d.cy - Math.max(3, d.h * pAt(d.samples, d.cx)))
    .attr('y2', (d) => d.cy + Math.max(3, d.h * pAt(d.samples, d.cx)))
    .attr('stroke', (d) => d.colour);

  // The hit path is the lens itself, invisible, thickened by a fat transparent stroke so a thin
  // lens is still reachable — and it carries the keyboard focus and the aria label.
  lsAll
    .select<SVGPathElement>('path.pred-lens__hit')
    .attr('d', (d) => lensShape(d)(d.samples) ?? '')
    .attr('aria-label', label)
    .on('pointerenter', (ev: PointerEvent, d) => {
      r.io.hoverLab(d.labId);
      tip(d, ev);
    })
    .on('pointermove', (ev: PointerEvent) => r.io.tipMove(ev))
    .on('pointerleave', () => {
      r.io.hoverLab(null);
      r.io.tipHide();
    })
    .on('focus', function (this: SVGPathElement, _ev: FocusEvent, d) {
      r.io.hoverLab(d.labId);
      tipAt(d, this);
    })
    .on('blur', () => {
      r.io.hoverLab(null);
      r.io.tipHide();
    });

  return lenses.map((d) => ({
    lab: d.labId,
    cx: d.cx,
    cy: d.cy,
    rx: Math.max(1, (d.samples[d.samples.length - 1]!.x - d.samples[0]!.x) / 2),
    ry: d.h,
  }));
}

/** UTC day of a scale-domain Date. */
function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}
