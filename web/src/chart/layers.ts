/**
 * The chart's drawing layers. Each function owns one <g> and re-joins its data;
 * the groups stay separate so the gyroscope parallax can move them independently.
 */
import { select, type Selection } from 'd3-selection';
import { curveMonotoneX, curveStepAfter, line } from 'd3-shape';
import type { LeadershipStripe, ModelRelease } from '@agi/shared';
import type { LabView, SeriesPoint } from '../data';
import { fmtDate, fmtIndex } from '../ui/format';
import { markerTooltip, releaseTooltip, stripeTooltip } from './tooltip';
import { timeTicks, toDate, valueTicks } from './scales';
import { ANNOUNCED, INK, type RenderCtx } from './types';

export type G = Selection<SVGGElement, unknown, null, undefined>;

const KEY_STRIPE = (s: LeadershipStripe): string => `${s.lab}|${s.from}`;

/* -------------------------------------------------------------------- grid */

export function drawGrid(g: G, r: RenderCtx): void {
  const { geom, x, y } = r;
  const ticks = timeTicks(x, Math.max(3, Math.round(geom.iw / (geom.compact ? 78 : 104))));
  const yTicks = valueTicks(y, geom.compact ? 4 : 6);

  // horizontal rules
  const rules = g.selectAll<SVGLineElement, number>('line.grid-h').data(yTicks, (d) => d);
  rules.exit().remove();
  rules
    .enter()
    .append('line')
    .attr('class', 'grid-line grid-h')
    .merge(rules)
    .attr('x1', geom.x0)
    .attr('x2', geom.x1)
    .attr('y1', (d) => y(d))
    .attr('y2', (d) => y(d));

  const yLabels = g.selectAll<SVGTextElement, number>('text.grid-y').data(yTicks, (d) => d);
  yLabels.exit().remove();
  yLabels
    .enter()
    .append('text')
    .attr('class', 'axis-label grid-y')
    .attr('text-anchor', 'end')
    .merge(yLabels)
    .attr('x', geom.x0 - 10)
    .attr('y', (d) => y(d) + 3.5)
    .text((d) => String(Math.round(d)));

  // vertical rules + date labels
  const cols = g.selectAll<SVGLineElement, { date: Date }>('line.grid-v').data(ticks, (d) => String(d.date.getTime()));
  cols.exit().remove();
  cols
    .enter()
    .append('line')
    .merge(cols)
    .attr('class', (d) => `grid-line grid-v${d.major ? ' grid-line--year' : ''}`)
    .attr('x1', (d) => x(d.date))
    .attr('x2', (d) => x(d.date))
    .attr('y1', geom.y1)
    .attr('y2', geom.y0);

  const xLabels = g.selectAll<SVGTextElement, { date: Date }>('text.grid-x').data(ticks, (d) => String(d.date.getTime()));
  xLabels.exit().remove();
  xLabels
    .enter()
    .append('text')
    .attr('text-anchor', 'middle')
    .merge(xLabels)
    .attr('class', (d) => `axis-label grid-x${d.major ? ' axis-label--major' : ''}`)
    .attr('x', (d) => x(d.date))
    .attr('y', geom.y0 + 30)
    .text((d) => d.label);

  // axis caption
  let cap = g.select<SVGTextElement>('text.axis-title');
  if (cap.empty()) cap = g.append('text').attr('class', 'axis-title');
  cap
    .attr('x', 2)
    .attr('y', geom.y1 - 11)
    .attr('text-anchor', 'start')
    .text('Frontier Index');
}

/* ----------------------------------------------------------------- stripes */

export function drawStripes(g: G, r: RenderCtx): void {
  const { geom, x, computed, ctx } = r;
  const bandY = geom.y0 + 12;
  const endISO = computed.asOf;
  const data = computed.stripes.filter((s) => r.visible(s.lab));

  const sel = g.selectAll<SVGRectElement, LeadershipStripe>('rect.stripe').data(data, KEY_STRIPE);
  sel.exit().remove();
  sel
    .enter()
    .append('rect')
    .attr('class', 'stripe')
    .attr('rx', 3)
    .attr('height', 6)
    .merge(sel)
    .attr('y', bandY)
    .attr('x', (d) => Math.min(x(toDate(d.from)), x(toDate(d.to ?? endISO))))
    .attr('width', (d) => Math.max(2, Math.abs(x(toDate(d.to ?? endISO)) - x(toDate(d.from)))))
    .attr('fill', (d) => ctx.labs.get(d.lab)?.color ?? INK)
    .attr('opacity', 0.75)
    .on('pointerenter', function (ev: PointerEvent, d) {
      r.io.tip(stripeTooltip(ctx, d, endISO), ev);
    })
    .on('pointermove', (ev: PointerEvent) => r.io.tipMove(ev))
    .on('pointerleave', () => r.io.tipHide());
}

/* ------------------------------------------------------------------- lines */

export function drawLines(g: G, r: RenderCtx): void {
  const { x, y, computed, ctx } = r;
  const path = line<SeriesPoint>()
    .x((d) => x(toDate(d.release.date)))
    .y((d) => y(d.mi.index))
    .curve(curveMonotoneX);

  const data = computed.labViews.filter((v) => v.points.length > 1);
  const sel = g.selectAll<SVGPathElement, LabView>('path.lab-line').data(data, (d) => d.lab.id);
  sel.exit().remove();
  sel
    .enter()
    .append('path')
    .attr('class', 'lab-line')
    .merge(sel)
    .attr('d', (d) => path(d.points) ?? '')
    .attr('stroke', (d) => d.lab.color)
    .attr('opacity', (d) => (r.visible(d.lab.id) ? 1 : 0.07))
    .attr('pointer-events', 'none');

  // running-maximum envelope, drawn as a step function
  const step = line<{ d: Date; v: number }>()
    .x((p) => x(p.d))
    .y((p) => y(p.v))
    .curve(curveStepAfter);

  const knots = computed.frontier.map((p) => ({ d: toDate(p.date), v: p.index }));
  const last = computed.frontier[computed.frontier.length - 1];
  if (last) knots.push({ d: toDate(computed.asOf), v: last.index });

  let env = g.select<SVGPathElement>('path.frontier-line');
  if (env.empty()) env = g.append('path').attr('class', 'frontier-line').attr('pointer-events', 'none');
  env.attr('d', knots.length ? (step(knots) ?? '') : '');

  // dotted continuation beyond "now", following the leading lab's fan median
  const leaderId = computed.rankings[0]?.lab;
  const leader = leaderId ? computed.byLab.get(leaderId) : undefined;
  let running = last?.index ?? 0;
  const future = (leader?.fan ?? [])
    .filter((p) => p.date >= computed.asOf)
    .map((p) => {
      running = Math.max(running, p.mid);
      return { d: toDate(p.date), v: running };
    });

  let fut = g.select<SVGPathElement>('path.frontier-future');
  if (fut.empty()) fut = g.append('path').attr('class', 'frontier-future').attr('pointer-events', 'none');
  const smooth = line<{ d: Date; v: number }>()
    .x((p) => x(p.d))
    .y((p) => y(p.v))
    .curve(curveStepAfter);
  fut.attr('d', future.length > 1 ? (smooth(future) ?? '') : '');

  void ctx;
}

/* ------------------------------------------------------------------ points */

export function drawPoints(g: G, r: RenderCtx): void {
  const { x, y, computed, ctx } = r;
  const pts: SeriesPoint[] = [];
  for (const v of computed.labViews) if (r.visible(v.lab.id)) pts.push(...v.points);

  // whiskers first so points sit on top
  const active = pts.filter((p) => p.mi.release_id === r.hover || p.mi.release_id === r.selected);
  const wh = g.selectAll<SVGLineElement, SeriesPoint>('line.whisker').data(active, (d) => d.mi.release_id);
  wh.exit().remove();
  wh
    .enter()
    .append('line')
    .attr('class', 'whisker')
    .merge(wh)
    .attr('x1', (d) => x(toDate(d.release.date)))
    .attr('x2', (d) => x(toDate(d.release.date)))
    .attr('y1', (d) => y(d.mi.indexLow))
    .attr('y2', (d) => y(d.mi.indexHigh))
    .attr('stroke', (d) => ctx.labs.get(d.release.lab)?.color ?? INK)
    .attr('pointer-events', 'none');

  const sel = g.selectAll<SVGCircleElement, SeriesPoint>('circle.lab-point').data(pts, (d) => d.mi.release_id);
  sel.exit().remove();
  const merged = sel
    .enter()
    .append('circle')
    .attr('r', 4)
    .attr('tabindex', 0)
    .attr('role', 'button')
    .merge(sel);

  merged
    .attr('class', (d) => `lab-point${d.mi.release_id === r.selected ? ' is-selected' : ''}`)
    .attr('data-id', (d) => d.mi.release_id)
    .attr('data-lab', (d) => d.release.lab)
    .attr('cx', (d) => x(toDate(d.release.date)))
    .attr('cy', (d) => y(d.mi.index))
    .attr('fill', (d) => ctx.labs.get(d.release.lab)?.color ?? INK)
    .attr('aria-label', (d) =>
      `${d.release.name}, ${ctx.labs.get(d.release.lab)?.name ?? d.release.lab}, released ${fmtDate(d.release.date)}, Frontier Index ${fmtIndex(d.mi.index)}. Activate for sources.`,
    )
    .on('pointerenter', function (ev: PointerEvent, d) {
      r.io.hoverRelease(d.mi.release_id);
      r.io.tip(releaseTooltip(ctx, d), ev);
    })
    .on('pointerleave', () => {
      r.io.hoverRelease(null);
      r.io.tipHide();
    })
    .on('focus', function (this: SVGCircleElement, _ev: FocusEvent, d) {
      const box = this.getBoundingClientRect();
      r.io.hoverRelease(d.mi.release_id);
      r.io.tip(releaseTooltip(ctx, d), { clientX: box.left + box.width / 2, clientY: box.top });
    })
    .on('blur', () => {
      r.io.hoverRelease(null);
      r.io.tipHide();
    })
    .on('click', (_ev: PointerEvent, d) => r.io.openAudit(d.mi.release_id))
    .on('keydown', (ev: KeyboardEvent, d) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        r.io.openAudit(d.mi.release_id);
      }
    });
}

/* ----------------------------------------------------------------- markers */

/** Announced / rumored / cancelled models have no index — park them on the lab's own level. */
function markerLevel(r: RenderCtx, rel: ModelRelease): number {
  const view = r.computed.byLab.get(rel.lab);
  const announced = view?.forecast?.next.find((p) => p.release_id === rel.id);
  if (announced) return announced.index;
  if (view?.last) return view.last.mi.index;
  const lastFrontier = r.computed.frontier[r.computed.frontier.length - 1];
  return lastFrontier ? lastFrontier.index : 50;
}

export function drawMarkers(g: G, r: RenderCtx): void {
  const { x, y, ctx } = r;
  const items: ModelRelease[] = [];
  for (const v of r.computed.labViews) if (r.visible(v.lab.id)) items.push(...v.markers);

  const sel = g.selectAll<SVGGElement, ModelRelease>('g.marker-g').data(items, (d) => d.id);
  sel.exit().remove();
  const enter = sel.enter().append('g').attr('class', 'marker-g').attr('tabindex', 0).attr('role', 'button');
  enter.append('circle').attr('class', 'marker');
  enter.append('path').attr('class', 'marker-x');

  const merged = enter.merge(sel);
  merged
    .attr('transform', (d) => `translate(${x(toDate(d.date))},${y(markerLevel(r, d))})`)
    .attr('data-id', (d) => d.id)
    .attr('aria-label', (d) => `${d.name}, ${ctx.labs.get(d.lab)?.name ?? d.lab}, ${d.status}, ${fmtDate(d.date)}`)
    .on('pointerenter', function (ev: PointerEvent, d) {
      r.io.tip(markerTooltip(ctx, d), ev);
    })
    .on('pointerleave', () => r.io.tipHide())
    .on('focus', function (this: SVGGElement, _ev: FocusEvent, d) {
      const box = this.getBoundingClientRect();
      r.io.tip(markerTooltip(ctx, d), { clientX: box.left + box.width / 2, clientY: box.top });
    })
    .on('blur', () => r.io.tipHide())
    .on('click', (_ev: PointerEvent, d) => r.io.openAudit(d.id))
    .on('keydown', (ev: KeyboardEvent, d) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        r.io.openAudit(d.id);
      }
    });

  merged
    .select<SVGCircleElement>('circle.marker')
    .attr('r', (d) => (d.status === 'cancelled' ? 0 : 5))
    .attr('class', (d) => `marker${d.status === 'rumored' ? ' marker--rumored' : ''}`)
    .attr('stroke', ANNOUNCED);

  merged
    .select<SVGPathElement>('path.marker-x')
    .attr('d', (d) => (d.status === 'cancelled' ? 'M-4.5,-4.5 L4.5,4.5 M4.5,-4.5 L-4.5,4.5' : ''))
    .attr('class', 'marker marker--cancelled')
    .attr('stroke', ANNOUNCED);
}

/* ------------------------------------------------------------------ labels */

interface EndLabel {
  id: string;
  short: string;
  color: string;
  x: number;
  y: number;
}

export function drawLabels(g: G, r: RenderCtx): void {
  const { geom, x, y, computed } = r;
  if (geom.compact) {
    g.selectAll('text.lab-label').remove();
    return;
  }

  const raw: EndLabel[] = [];
  for (const v of computed.labViews) {
    if (!r.visible(v.lab.id) || !v.last) continue;
    raw.push({
      id: v.lab.id,
      short: v.lab.short,
      color: v.lab.color,
      x: x(toDate(v.last.release.date)),
      y: y(v.last.mi.index),
    });
  }

  // Push overlapping labels apart so ten labs stay readable at the line ends.
  raw.sort((a, b) => a.y - b.y);
  const MIN_GAP = 15;
  for (let i = 1; i < raw.length; i++) {
    const prev = raw[i - 1]!;
    const cur = raw[i]!;
    if (cur.y - prev.y < MIN_GAP) cur.y = prev.y + MIN_GAP;
  }
  const overflow = (raw[raw.length - 1]?.y ?? 0) - geom.y0;
  if (overflow > 0) for (const l of raw) l.y -= overflow;

  const sel = g.selectAll<SVGTextElement, EndLabel>('text.lab-label').data(raw, (d) => d.id);
  sel.exit().remove();
  sel
    .enter()
    .append('text')
    .attr('class', 'lab-label')
    .merge(sel)
    .attr('x', (d) => Math.min(d.x + 11, geom.x1 + 8))
    .attr('y', (d) => d.y + 4)
    .attr('fill', (d) => d.color)
    .text((d) => d.short);
}

/* ----------------------------------------------------------------- overlay */

export interface OverlayRefs {
  handle: SVGCircleElement;
}

/** Future tint, the "now" rule and its draggable handle. Returns the handle for the drag binding. */
export function drawOverlay(g: G, r: RenderCtx): OverlayRefs {
  const { geom, x, asOf, today } = r;
  const nowX = x(toDate(asOf));
  const scrubbed = asOf !== today;

  let tint = g.select<SVGRectElement>('rect.future-tint');
  if (tint.empty()) tint = g.append('rect').attr('class', 'future-tint').attr('pointer-events', 'none');
  const tintX = Math.max(geom.x0, Math.min(geom.x1, nowX));
  tint.attr('x', tintX).attr('y', geom.y1).attr('width', Math.max(0, geom.x1 - tintX)).attr('height', geom.ih);

  let rule = g.select<SVGLineElement>('line.now-line');
  if (rule.empty()) rule = g.append('line').attr('class', 'now-line').attr('pointer-events', 'none');
  rule.attr('x1', nowX).attr('x2', nowX).attr('y1', geom.y1 - 6).attr('y2', geom.y0 + 22);

  let label = g.select<SVGTextElement>('text.now-label');
  if (label.empty()) label = g.append('text').attr('class', 'now-label').attr('pointer-events', 'none');
  const text = geom.compact
    ? (scrubbed ? fmtDate(asOf) : fmtDate(today))
    : (scrubbed ? `As of ${fmtDate(asOf)}` : `Now · ${fmtDate(today)}`);
  // 10px uppercase Jost with 0.16em tracking runs about 7.4 px per character; flip the label
  // to the left of the rule as soon as it would not fit before the right edge.
  const approxWidth = text.length * 7.4;
  const flip = nowX + 12 + approxWidth > geom.x1 + geom.m.right - 6;
  label
    .attr('class', `now-label${scrubbed ? ' now-label--scrubbed' : ''}`)
    .attr('x', nowX + (flip ? -12 : 12))
    .attr('y', geom.y1 - 10)
    .attr('text-anchor', flip ? 'end' : 'start')
    .text(text);

  let handle = g.select<SVGCircleElement>('circle.now-handle');
  if (handle.empty()) {
    handle = g
      .append('circle')
      .attr('class', 'now-handle')
      .attr('r', 7)
      .attr('tabindex', 0)
      .attr('role', 'slider')
      .attr('aria-label', 'Time scrubber — drag to recompute the page as of another date');
  }
  handle.attr('cx', nowX).attr('cy', geom.y1 - 6).attr('aria-valuetext', fmtDate(asOf));

  let grip = g.select<SVGPathElement>('path.now-handle-grip');
  if (grip.empty()) grip = g.append('path').attr('class', 'now-handle-grip').attr('pointer-events', 'none');
  grip.attr('d', `M${nowX - 2.2},${geom.y1 - 9} L${nowX - 2.2},${geom.y1 - 3} M${nowX + 2.2},${geom.y1 - 9} L${nowX + 2.2},${geom.y1 - 3}`);

  // keep the handle above everything else in its layer
  const node = handle.node();
  if (node && node.parentNode) node.parentNode.appendChild(node);
  const gripNode = grip.node();
  if (gripNode && gripNode.parentNode) gripNode.parentNode.appendChild(gripNode);

  return { handle: node as SVGCircleElement };
}

/** Utility used by the chart shell to (re)create a layer group in a fixed z-order. */
export function ensureLayer(svgEl: SVGSVGElement, name: string): G {
  const existing = select(svgEl).select<SVGGElement>(`g.layer-${name}`);
  if (!existing.empty()) return existing;
  return select(svgEl).append('g').attr('class', `layer layer-${name}`);
}
