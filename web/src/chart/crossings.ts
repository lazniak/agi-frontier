/**
 * The frontier trend fan and the level crossings (REDESIGN §2.2, §4).
 *
 * - `frontierFan` layer: the grey area (announced grey at 12 %) of the trend's 90 % band, with
 *   the yellow dotted median continuing the running-maximum line to the right edge — re-asked
 *   for whatever the current x-domain needs, so it reaches the edge at any zoom.
 * - `crossings` layer: one stroked circle per *predicted* crossing, sitting on the fan median at
 *   its median date, radius from the 68 % window (like a release circle, ink stroke, no fill),
 *   label = the level label (thinned by an 18 px gap), tooltip with median and 68/90 % windows.
 *   Past crossings are small ink ticks on the frontier line, tooltip names the model.
 */
import { area, curveMonotoneX, line } from 'd3-shape';
import { thetaFromIndex, type Crossing, type FanPoint, type FrontierPoint } from '@agi/shared';
import { fanHighTheta, fanLowTheta, fanMidTheta } from '../data';
import { toDate } from './scales';
import { INK, PREDICT, ANNOUNCED, type RenderCtx } from './types';
import type { G, LabelBox } from './layers';

const FAN_OPACITY = 0.12;
const LABEL_GAP = 18;
const MIN_CIRCLE_D = 10;
const MAX_CIRCLE_D = 220;

/** Paths of the frontier trend fan — the fan arrives as plain FanPoints (index-valued today). */
export function frontierFanPaths(r: RenderCtx, fan: FanPoint[]): { areaPath: string; medianPath: string } {
  const { x, y } = r;
  const a = area<FanPoint>()
    .x((p) => x(toDate(p.date)))
    .y0((p) => y.theta(fanLowTheta(p)))
    .y1((p) => y.theta(fanHighTheta(p)))
    .curve(curveMonotoneX);
  const m = line<FanPoint>()
    .x((p) => x(toDate(p.date)))
    .y((p) => y.theta(fanMidTheta(p)))
    .curve(curveMonotoneX);
  return { areaPath: a(fan) ?? '', medianPath: m(fan) ?? '' };
}

export function drawFrontierFan(g: G, r: RenderCtx, fan: FanPoint[]): void {
  if (fan.length < 2 || !r.layerOn('frontierFan')) {
    g.selectAll('*').remove();
    return;
  }
  const paths = frontierFanPaths(r, fan);

  let fill = g.select<SVGPathElement>('path.frontier-fan');
  if (fill.empty()) fill = g.append('path').attr('class', 'frontier-fan').attr('pointer-events', 'none');
  fill.attr('d', paths.areaPath).attr('fill', ANNOUNCED).attr('opacity', FAN_OPACITY);

  let med = g.select<SVGPathElement>('path.frontier-fan-median');
  if (med.empty()) {
    med = g.append('path').attr('class', 'frontier-fan-median').attr('pointer-events', 'none')
      .attr('fill', 'none'); // a line path with the default black fill paints a filled wedge
  }
  med.attr('d', paths.medianPath).attr('stroke', PREDICT);
}

interface CrossingDatum {
  key: string;
  crossing: Crossing;
  cx: number;
  cy: number;
  rd: number;
}

/** Predicted-circle radius rule shared with the release circles: the 68 % window on x. */
export function crossingRadius(c: Crossing, x: (d: Date) => number): number {
  const cx = x(toDate(c.date));
  const x16 = c.p16 ? x(toDate(c.p16)) : cx;
  const x84 = c.p84 ? x(toDate(c.p84)) : cx;
  return Math.min(MAX_CIRCLE_D, Math.max(MIN_CIRCLE_D, Math.abs(x84 - x16))) / 2;
}

/**
 * @param reserved boxes another layer already occupies (the lab end-labels): a crossing label
 * that would land on one is dropped rather than printed over it. The ladder names the same level
 * at the same height in the right-hand gutter, so nothing is lost.
 */
export function drawCrossings(g: G, r: RenderCtx, reserved: readonly LabelBox[] = []): void {
  const { x, y, computed, geom } = r;
  if (!r.layerOn('crossings')) {
    g.selectAll('*').remove();
    return;
  }

  // `computed.crossings` is built from the fitted levels only; the speculative landmarks never
  // reach this layer (REDESIGN §12.1).
  const circles: CrossingDatum[] = [];
  for (const c of computed.crossings) {
    if (c.kind !== 'predicted') continue;
    const cx = x(toDate(c.date));
    if (cx < geom.x0 - 40 || cx > geom.x1 + 40) continue;
    circles.push({
      key: c.level.id,
      crossing: c,
      cx,
      cy: y.theta(medianThetaAt(computed.frontierFan, c.date)),
      rd: crossingRadius(c, x),
    });
  }

  const ringSel = g.selectAll<SVGGElement, CrossingDatum>('g.crossing-g').data(circles, (d) => d.key);
  ringSel.exit().remove();
  const enter = ringSel.enter().append('g').attr('class', 'crossing-g').attr('tabindex', 0).attr('role', 'img');
  enter.append('circle').attr('class', 'crossing-ring').attr('fill', 'none');
  enter.append('circle').attr('class', 'crossing-dot').attr('r', 2);
  enter.append('text').attr('class', 'crossing-label');
  const merged = enter.merge(ringSel as never);
  merged
    .attr('transform', (d) => `translate(${d.cx},${d.cy})`)
    .attr('aria-label', (d) => `${d.crossing.level.label}, predicted ${d.crossing.date}`)
    .on('pointerenter', (ev: PointerEvent, d) => r.io.tip(crossingTooltip(d.crossing), ev))
    .on('pointermove', (ev: PointerEvent) => r.io.tipMove(ev))
    .on('pointerleave', () => r.io.tipHide())
    .on('focus', function (this: SVGGElement, _ev: FocusEvent, d) {
      const box = this.getBoundingClientRect();
      r.io.tip(crossingTooltip(d.crossing), { clientX: box.left + box.width / 2, clientY: box.top });
    })
    .on('blur', () => r.io.tipHide());

  merged
    .select<SVGCircleElement>('circle.crossing-ring')
    .attr('r', (d) => d.rd)
    .attr('stroke', INK)
    .attr('stroke-opacity', 0.75)
    .attr('stroke-dasharray', '3 3');
  merged.select<SVGCircleElement>('circle.crossing-dot').attr('fill', INK);

  // Labels thinned by an 18 px gap, top of the canvas downwards.
  let lastY = Number.NEGATIVE_INFINITY;
  const labelled = new Set<string>();
  for (const d of [...circles].sort((a, b) => a.cy - b.cy)) {
    if (d.cy - lastY < LABEL_GAP) continue;
    lastY = d.cy;
    labelled.add(d.key);
  }
  merged
    .select<SVGTextElement>('text.crossing-label')
    .attr('x', (d) => Math.min(d.rd + 5, Math.max(0, geom.x1 - d.cx - 4)))
    .attr('y', 3.5)
    .text((d) => (labelled.has(d.key) ? shortLevel(d.crossing, r.ctx.benchmarks) : ''))
    // The label lives inside the plot: drop it when it would run into the gutter (the ladder
    // names the same level at the same height there anyway) or over a lab end-label.
    .each(function (d) {
      const room = geom.x1 - d.cx - d.rd - 8;
      const width = this.getComputedTextLength();
      if (room < 30 || width > room) {
        this.textContent = '';
        return;
      }
      const x0 = d.cx + Number(this.getAttribute('x') ?? 0);
      const box: LabelBox = { x0, y0: d.cy - 6, x1: x0 + width, y1: d.cy + 7 };
      if (reserved.some((b) => overlaps(box, b))) this.textContent = '';
    });

  // Past: small ink ticks on the frontier line, only the ones inside the window.
  const past = computed.crossings.filter((c) => {
    if (c.kind !== 'past') return false;
    const px = x(toDate(c.date));
    return px >= geom.x0 && px <= geom.x1;
  });
  const tickSel = g.selectAll<SVGLineElement, Crossing>('line.crossing-tick').data(past, (d) => d.level.id);
  tickSel.exit().remove();
  tickSel
    .enter()
    .append('line')
    .attr('class', 'crossing-tick')
    .attr('stroke', INK)
    .attr('stroke-width', 2.5)
    .merge(tickSel as never)
    .attr('x1', (d) => x(toDate(d.date)) - 3)
    .attr('x2', (d) => x(toDate(d.date)) + 3)
    .attr('y1', (d) => y.theta(frontierThetaAt(computed, d.date)) - 3)
    .attr('y2', (d) => y.theta(frontierThetaAt(computed, d.date)) + 3)
    .on('pointerenter', (ev: PointerEvent, d) => r.io.tip(crossingTooltip(d), ev))
    .on('pointermove', (ev: PointerEvent) => r.io.tipMove(ev))
    .on('pointerleave', () => r.io.tipHide());
}

/** Do two label boxes touch? A 2 px pad keeps two words from reading as one. */
function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.x0 < b.x1 + 2 && a.x1 + 2 > b.x0 && a.y0 < b.y1 + 2 && a.y1 + 2 > b.y0;
}

/** Median theta of the frontier trend fan at a date (nearest sample). */
function medianThetaAt(fan: FanPoint[], date: string): number {
  let best: FanPoint | undefined;
  for (const p of fan) {
    if (best === undefined || Math.abs(days(p.date, date)) < Math.abs(days(best.date, date))) best = p;
  }
  return best ? fanMidTheta(best) : 0;
}

/** Frontier theta at a date: the running maximum as of that date (nearest knot at or before). */
function frontierThetaAt(computed: { frontier: FrontierPoint[] }, date: string): number {
  let best: FrontierPoint | undefined;
  for (const p of computed.frontier) {
    if (p.date <= date) best = p;
    else break;
  }
  const fp = best;
  return fp ? thetaFromIndex(fp.index) : 0;
}

function days(a: string, b: string): number {
  return (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

function shortLevel(c: Crossing, benchmarks?: Map<string, { short: string }>): string {
  const lv = c.level;
  const name = lv.benchmark ? (benchmarks?.get(lv.benchmark)?.short ?? lv.benchmark) : '';
  switch (lv.kind) {
    case 'ceiling':
      return 'Basket ceiling';
    case 'generation':
      return lv.generation === undefined ? 'Basket saturated' : `Gen ${lv.generation} saturated`;
    case 'human':
      return `Human · ${name}`;
    default:
      return `Saturated · ${name}`;
  }
}

export function crossingTooltip(c: Crossing): string {
  const rows: [string, string][] = [['Rating', Math.round(c.level.rating).toString()]];
  if (c.kind === 'past') {
    rows.push(['Reached', c.date]);
    if (c.release_id) rows.push(['By', c.release_id]);
  } else {
    rows.push(['Predicted median', c.date]);
    if (c.p16 && c.p84) rows.push(['68 % window', `${c.p16} – ${c.p84}`]);
    if (c.p05 && c.p95) rows.push(['90 % window', `${c.p05} – ${c.p95}`]);
  }
  const body = rows.map(([k, v]) => `<div class="tt-row"><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  return `<div class="tt-head"><span class="tt-dot" style="background:${INK}"></span>
    <span class="tt-name">${c.level.label}</span></div>
    <dl class="tt-rows">${body}</dl>`;
}
