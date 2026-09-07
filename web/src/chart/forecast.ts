/**
 * Forecast layer: the yellow capability fan, the dashed median path and one circle per
 * predicted release whose *diameter* is the 16th–84th percentile window on the time axis.
 *
 * Ten labs mean ten overlapping fans. Translucent shapes stacked on each other would add up
 * to a solid yellow block and destroy every reading, so the fills are drawn opaque inside a
 * group that carries the opacity: the *union* of all fans then sits at exactly the documented
 * 14 %, however many labs are on. Strokes stay outside that group, so each predicted release
 * still reads as its own ring.
 */
import { area, curveMonotoneX, line } from 'd3-shape';
import type { FanPoint, PredictedRelease } from '@agi/shared';
import type { LabView } from '../data';
import { predictionTooltip } from './tooltip';
import { toDate } from './scales';
import { ANNOUNCED, PREDICT, chainOpacity, type RenderCtx } from './types';
import type { G } from './layers';

/** A prediction circle can never be a dot nor swallow the chart. */
const MIN_D = 8;
const MAX_D = 160;
const FAN_OPACITY = 0.14;
const CIRCLE_FILL_OPACITY = 0.1;

interface CircleDatum {
  key: string;
  labId: string;
  pred: PredictedRelease;
  cx: number;
  cy: number;
  r: number;
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

  const views = computed.labViews.filter((v) => r.visible(v.lab.id) && v.fan.length > 1);

  const fillHost = sub(g, 'fan-fills', { opacity: String(FAN_OPACITY), 'pointer-events': 'none' });
  const fans = fillHost.selectAll<SVGPathElement, LabView>('path.fan').data(views, (d) => d.lab.id);
  fans.exit().remove();
  fans
    .enter()
    .append('path')
    .attr('class', 'fan')
    .merge(fans)
    .attr('d', (d) => band(d.fan) ?? '')
    .attr('fill', (d) => (announcedLed(d) ? ANNOUNCED : PREDICT));

  const medHost = sub(g, 'fan-medians', { 'pointer-events': 'none' });
  const meds = medHost.selectAll<SVGPathElement, LabView>('path.fan-median').data(views, (d) => d.lab.id);
  meds.exit().remove();
  meds
    .enter()
    .append('path')
    .attr('class', 'fan-median')
    .merge(meds)
    .attr('d', (d) => mid(d.fan) ?? '')
    .attr('stroke', (d) => (announcedLed(d) ? ANNOUNCED : PREDICT))
    .attr('opacity', 0.8);
}

export function drawPredictions(g: G, r: RenderCtx): void {
  const { x, y, computed, ctx } = r;
  // On a narrow chart a 160 px circle would swallow the plot, so cap against the width too.
  const maxD = Math.min(MAX_D, Math.max(MIN_D * 3, r.geom.iw * 0.16));
  const data: CircleDatum[] = [];

  for (const v of computed.labViews) {
    if (!r.visible(v.lab.id) || !v.forecast) continue;
    for (const pred of v.predictions) {
      const spanPx = Math.abs(x(toDate(pred.p84Date)) - x(toDate(pred.p16Date)));
      const announced = pred.source === 'announced';
      data.push({
        key: `${v.lab.id}|${pred.k}`,
        labId: v.lab.id,
        pred,
        cx: x(toDate(pred.medianDate)),
        cy: y(pred.index),
        r: Math.min(maxD, Math.max(MIN_D, spanPx)) / 2,
        colour: announced ? ANNOUNCED : PREDICT,
        opacity: chainOpacity(pred.k),
        p30: v.forecast.p30,
        p90: v.forecast.p90,
      });
    }
  }

  const key = (d: CircleDatum): string => d.key;

  // 1 — fills, union-capped by the group opacity
  const fillHost = sub(g, 'pred-fills', { opacity: String(CIRCLE_FILL_OPACITY), 'pointer-events': 'none' });
  const fills = fillHost.selectAll<SVGCircleElement, CircleDatum>('circle').data(data, key);
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

  // 2 — the rings themselves
  const ringHost = sub(g, 'pred-rings', { 'pointer-events': 'none' });
  const rings = ringHost.selectAll<SVGCircleElement, CircleDatum>('circle.pred-circle').data(data, key);
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

  // 3 — the median date itself
  const dotHost = sub(g, 'pred-dots', { 'pointer-events': 'none' });
  const dots = dotHost.selectAll<SVGCircleElement, CircleDatum>('circle').data(data, key);
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

  // 4 — an invisible fat ring carries hover and focus, so the discs never swallow the
  //     pointer and every window stays individually reachable by keyboard.
  const hitHost = sub(g, 'pred-hits', { fill: 'none', stroke: 'transparent', 'stroke-width': '14' });
  const hits = hitHost.selectAll<SVGCircleElement, CircleDatum>('circle').data(data, key);
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
    .attr('aria-label', (d) =>
      `Predicted ${ctx.labs.get(d.labId as never)?.short ?? d.labId} flagship number ${d.pred.k}, median ${d.pred.medianDate}, 68 percent window ${d.pred.p16Date} to ${d.pred.p84Date}, expected index ${d.pred.index.toFixed(1)}`,
    )
    .on('pointerenter', function (ev: PointerEvent, d) {
      r.io.tip(predictionTooltip(ctx, d.labId, d.pred, d.p30, d.p90), ev);
    })
    .on('pointermove', (ev: PointerEvent) => r.io.tipMove(ev))
    .on('pointerleave', () => r.io.tipHide())
    .on('focus', function (this: SVGCircleElement, _ev: FocusEvent, d) {
      const box = this.getBoundingClientRect();
      r.io.tip(predictionTooltip(ctx, d.labId, d.pred, d.p30, d.p90), {
        clientX: box.left + box.width / 2,
        clientY: box.top,
      });
    })
    .on('blur', () => r.io.tipHide());
}
