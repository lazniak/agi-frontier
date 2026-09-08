/**
 * Real-data family ribbons (REDESIGN §12.3): per visible lab, the filled step band between the
 * best and the weakest member of the lab's *current family* through time (`familyRibbon` in
 * shared). "Like the forecast fan, but on real data." Drawn at 14 % opacity, 34 % when the family
 * is focused (classes from the shell, see chart.css), and fading out after `asOf` through a
 * horizontal gradient so the ribbon never pretends to know the future.
 */
import { area, curveStepAfter } from 'd3-shape';
import type { BandPoint } from '@agi/shared';
import { addDays } from '@agi/shared';
import { toDate } from './scales';
import type { RenderCtx } from './types';
import type { G } from './layers';

/** How far past `asOf` the ribbon fades to nothing. */
const FADE_DAYS = 120;

interface Knot {
  d: Date;
  hi: number;
  lo: number;
}

interface RibbonView {
  id: string;
  color: string;
  points: Knot[];
  gradientId: string;
}

export function drawBands(g: G, r: RenderCtx): void {
  const { x, y, computed } = r;
  if (!r.bands || !r.layerOn('ribbons')) {
    g.selectAll('*').remove();
    return;
  }

  const views: RibbonView[] = [];
  for (const v of computed.labViews) {
    if (!r.visible(v.lab.id)) continue;
    const pts = computed.bands.get(v.lab.id) ?? [];
    if (!hasWidth(pts)) continue;
    const knots: Knot[] = pts.map((p) => ({ d: toDate(p.date), hi: p.hiTheta, lo: p.loTheta }));
    // The tail after asOf carries the last family forward and fades to zero over FADE_DAYS.
    const last = knots[knots.length - 1]!;
    knots.push({ d: toDate(addDays(computed.asOf, FADE_DAYS)), hi: last.hi, lo: last.lo });
    views.push({
      id: v.lab.id,
      color: v.lab.color,
      points: knots,
      gradientId: `${r.glowId}-ribbon-${v.lab.id}`,
    });
  }

  // gradients — one per lab, in user space so the fade sits exactly at asOf
  let defs = g.select<SVGDefsElement>('defs');
  if (defs.empty()) defs = g.append('defs');
  const grads = defs.selectAll<SVGLinearGradientElement, RibbonView>('linearGradient').data(views, (d) => d.id);
  grads.exit().remove();
  const gradEnter = grads.enter().append('linearGradient').attr('gradientUnits', 'userSpaceOnUse').attr('y1', 0).attr('y2', 0);
  gradEnter.append('stop').attr('class', 'ribbon-stop-a').attr('offset', '0');
  gradEnter.append('stop').attr('class', 'ribbon-stop-b').attr('offset', '1');
  const gradAll = gradEnter.merge(grads);
  const fadeFrom = x(toDate(computed.asOf));
  const fadeTo = x(toDate(addDays(computed.asOf, FADE_DAYS)));
  gradAll
    .attr('id', (d) => d.gradientId)
    .attr('x1', fadeFrom)
    .attr('x2', Math.max(fadeFrom + 1, fadeTo));
  gradAll.select('stop.ribbon-stop-a').attr('stop-color', (d) => d.color).attr('stop-opacity', 1);
  gradAll.select('stop.ribbon-stop-b').attr('stop-color', (d) => d.color).attr('stop-opacity', 0);

  // y() speaks index at its face value; the ribbon speaks theta, so map through indexFromTheta.
  const shape = area<Knot>()
    .x((p) => x(p.d))
    .y0((p) => y.theta(p.lo))
    .y1((p) => y.theta(p.hi))
    .curve(curveStepAfter);

  const sel = g.selectAll<SVGPathElement, RibbonView>('path.family-band').data(views, (d) => d.id);
  sel.exit().remove();
  sel
    .enter()
    .append('path')
    .attr('class', 'family-band')
    .attr('pointer-events', 'none')
    .merge(sel)
    .attr('data-lab', (d) => d.id)
    .attr('d', (d) => shape(d.points) ?? '')
    .attr('fill', (d) => `url(#${d.gradientId})`);
}

/** A ribbon that is hi === lo everywhere is a line, not a band — skip it. */
function hasWidth(pts: BandPoint[]): boolean {
  return pts.some((p) => p.hiTheta > p.loTheta + 1e-9);
}
