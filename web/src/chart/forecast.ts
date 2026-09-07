/**
 * Forecast layer: the yellow capability fan, the dashed median path and one circle per
 * predicted release whose *diameter* is the 16th–84th percentile window on the time axis.
 *
 * Ten labs forecast into the same three months, so ten fans and ten circles land in one
 * corner and cancel each other out. The layer therefore draws two tiers:
 *
 *  - **spotlight** labs (the three with the highest P(30 d), plus whichever lab the reader is
 *    looking at) get the full treatment — fan, dashed median, window circle;
 *  - every other lab gets a *whisker*: a thin bar from the 16th to the 84th percentile date at
 *    the lab's expected index, with a dot on the median. Same information, a tenth of the ink.
 *
 * Fills are drawn opaque inside a group that carries the opacity, so the union of all fans
 * sits at exactly the documented 14 % however many are on. Strokes stay outside that group.
 */
import { area, curveMonotoneX, line } from 'd3-shape';
import type { FanPoint, LabId, PredictedRelease } from '@agi/shared';
import type { LabView } from '../data';
import { predictionTooltip } from './tooltip';
import { toDate } from './scales';
import { ANNOUNCED, DIM_LINE, PREDICT, chainOpacity, type RenderCtx } from './types';
import type { G } from './layers';

/** A prediction circle can never be a dot nor swallow the chart. */
const MIN_D = 8;
const MAX_D = 160;
const FAN_OPACITY = 0.14;
const CIRCLE_FILL_OPACITY = 0.1;
/** How many labs get the full fan + circle when nothing is focused. */
export const SPOTLIGHT_COUNT = 3;

interface CircleDatum {
  key: string;
  labId: LabId;
  pred: PredictedRelease;
  cx: number;
  cy: number;
  r: number;
  colour: string;
  opacity: number;
  /** The single most likely next release gets a soft halo. */
  lead: boolean;
  p30: number;
  p90: number;
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

function announcedLed(v: LabView): boolean {
  return v.predictions[0]?.source === 'announced';
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

/** Opacity multiplier for a lab while another one is the focus. */
function focusMul(r: RenderCtx, lab: LabId): number {
  return r.focusLab && r.focusLab !== lab ? DIM_LINE / 0.8 : 1;
}

export function drawFans(g: G, r: RenderCtx): void {
  const { x, y, computed } = r;

  const band = area<FanPoint>()
    .x((d) => x(toDate(d.date)))
    .y0((d) => y(d.low))
    .y1((d) => y(d.high))
    .curve(curveMonotoneX);

  const mid = line<FanPoint>()
    .x((d) => x(toDate(d.date)))
    .y((d) => y(d.mid))
    .curve(curveMonotoneX);

  // The default view draws a fan only as far as the lab's own next release (p95 + 30 days).
  const fanOf = (v: LabView): typeof v.fan => (r.longRange ? v.fan : v.fanNear);
  // Fans belong to the spotlight only; the whiskers of the other labs carry their timing.
  const views = computed.labViews.filter((v) => r.spotlight.has(v.lab.id) && fanOf(v).length > 1);

  const fillHost = sub(g, 'fan-fills', { opacity: String(FAN_OPACITY), 'pointer-events': 'none' });
  const fans = fillHost.selectAll<SVGPathElement, LabView>('path.fan').data(views, (d) => d.lab.id);
  fans.exit().remove();
  fans
    .enter()
    .append('path')
    .attr('class', 'fan')
    .merge(fans)
    .attr('d', (d) => band(fanOf(d)) ?? '')
    .attr('fill', (d) => (announcedLed(d) ? ANNOUNCED : PREDICT))
    .attr('opacity', (d) => focusMul(r, d.lab.id));

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
    .attr('opacity', (d) => 0.8 * focusMul(r, d.lab.id));
}

export function drawPredictions(g: G, r: RenderCtx): void {
  const { x, y, computed, ctx } = r;
  // On a narrow chart a 160 px circle would swallow the plot, so cap against both axes.
  const maxD = Math.min(MAX_D, r.geom.ih * 0.6, Math.max(MIN_D * 3, r.geom.iw * 0.16));
  const circles: CircleDatum[] = [];
  const whiskers: WhiskerDatum[] = [];

  // "Most likely next": the highest P(30 d) among the labs currently drawn. Its k = 1 circle
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
      // Default view: one release ahead. The chain beyond it lands in the same fortnight for
      // every lab and reads as noise; the long-range toggle brings it back, spotlight only.
      if (pred.k > 1 && !(r.longRange && spot)) continue;
      const announced = pred.source === 'announced';
      const colour = announced ? ANNOUNCED : PREDICT;
      const x16 = x(toDate(pred.p16Date));
      const x84 = x(toDate(pred.p84Date));
      const cx = x(toDate(pred.medianDate));
      const cy = y(pred.index);
      const opacity = chainOpacity(pred.k) * focusMul(r, v.lab.id);
      if (spot) {
        circles.push({
          key: `${v.lab.id}|${pred.k}`,
          labId: v.lab.id,
          pred,
          cx,
          cy,
          r: Math.min(maxD, Math.max(MIN_D, Math.abs(x84 - x16))) / 2,
          colour,
          opacity,
          lead: pred.k === 1 && v.lab.id === leadLab,
          p30: v.forecast.p30,
          p90: v.forecast.p90,
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
  const tip = (d: CircleDatum | WhiskerDatum, ev: PointerEvent): void => {
    r.io.tip(predictionTooltip(ctx, d.labId, d.pred, d.p30, d.p90), ev);
  };
  const tipAt = (d: CircleDatum | WhiskerDatum, node: Element): void => {
    const box = node.getBoundingClientRect();
    r.io.tip(predictionTooltip(ctx, d.labId, d.pred, d.p30, d.p90), {
      clientX: box.left + box.width / 2,
      clientY: box.top,
    });
  };
  const label = (d: CircleDatum | WhiskerDatum): string =>
    `Predicted ${ctx.labs.get(d.labId)?.short ?? d.labId} flagship number ${d.pred.k}, median ${d.pred.medianDate}, 68 percent window ${d.pred.p16Date} to ${d.pred.p84Date}, expected index ${d.pred.index.toFixed(1)}`;

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

  // 1 — the halo behind the most likely next release
  const glowHost = sub(g, 'pred-glow', { 'pointer-events': 'none' });
  const glows = glowHost.selectAll<SVGCircleElement, CircleDatum>('circle').data(circles.filter((d) => d.lead), key);
  glows.exit().remove();
  glows
    .enter()
    .append('circle')
    .attr('class', 'pred-glow')
    .attr('fill', 'none')
    .merge(glows)
    .attr('cx', (d) => d.cx)
    .attr('cy', (d) => d.cy)
    .attr('r', (d) => d.r)
    .attr('stroke', (d) => d.colour)
    .attr('filter', `url(#${r.glowId})`);

  // 2 — fills, union-capped by the group opacity
  const fillHost = sub(g, 'pred-fills', { opacity: String(CIRCLE_FILL_OPACITY), 'pointer-events': 'none' });
  const fills = fillHost.selectAll<SVGCircleElement, CircleDatum>('circle').data(circles, key);
  fills.exit().remove();
  fills
    .enter()
    .append('circle')
    .attr('stroke', 'none')
    .merge(fills)
    .attr('cx', (d) => d.cx)
    .attr('cy', (d) => d.cy)
    .attr('r', (d) => d.r)
    .attr('fill', (d) => d.colour)
    .attr('fill-opacity', (d) => d.opacity);

  // 3 — the rings themselves
  const ringHost = sub(g, 'pred-rings', { 'pointer-events': 'none' });
  const rings = ringHost.selectAll<SVGCircleElement, CircleDatum>('circle.pred-circle').data(circles, key);
  rings.exit().remove();
  rings
    .enter()
    .append('circle')
    .attr('class', 'pred-circle')
    .attr('fill', 'none')
    .merge(rings)
    .attr('cx', (d) => d.cx)
    .attr('cy', (d) => d.cy)
    .attr('r', (d) => d.r)
    .attr('stroke', (d) => d.colour)
    .attr('stroke-opacity', (d) => d.opacity);

  // 4 — the median date itself
  const dotHost = sub(g, 'pred-dots', { 'pointer-events': 'none' });
  const dots = dotHost.selectAll<SVGCircleElement, CircleDatum>('circle').data(circles, key);
  dots.exit().remove();
  dots
    .enter()
    .append('circle')
    .attr('r', 1.8)
    .merge(dots)
    .attr('cx', (d) => d.cx)
    .attr('cy', (d) => d.cy)
    .attr('fill', (d) => d.colour)
    .attr('opacity', (d) => Math.max(0.5, d.opacity));

  // 5 — an invisible fat ring carries hover and focus, so the discs never swallow the
  //     pointer and every window stays individually reachable by keyboard.
  const hitHost = sub(g, 'pred-hits', { fill: 'none', stroke: 'transparent', 'stroke-width': '14' });
  const hits = hitHost.selectAll<SVGCircleElement, CircleDatum>('circle').data(circles, key);
  hits.exit().remove();
  hits
    .enter()
    .append('circle')
    .attr('tabindex', 0)
    .attr('role', 'button')
    .attr('pointer-events', 'stroke')
    .merge(hits)
    .attr('cx', (d) => d.cx)
    .attr('cy', (d) => d.cy)
    .attr('r', (d) => d.r)
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
    .on('focus', function (this: SVGCircleElement, _ev: FocusEvent, d) {
      r.io.hoverLab(d.labId);
      tipAt(d, this);
    })
    .on('blur', () => {
      r.io.hoverLab(null);
      r.io.tipHide();
    });
}
