/**
 * Family bands (REDESIGN §3): per visible lab, the filled area between the flagship theta
 * (`hiTheta`) and the smallest current tier (`loTheta`) of its lineup, as a step-after path in
 * the lab colour at 10 % opacity. Skipped when the band is off or hi === lo everywhere (a lab
 * with a single tier has no band, just its line). Fades after `asOf`.
 */
import { area, curveStepAfter } from 'd3-shape';
import type { BandPoint } from '@agi/shared';
import { indexFromTheta } from '@agi/shared';
import { toDate } from './scales';
import type { RenderCtx } from './types';
import type { G } from './layers';

const BAND_OPACITY = 0.1;
const FUTURE_FADE_OPACITY = 0.04;

interface BandView {
  id: string;
  color: string;
  points: { d: Date; hi: number; lo: number }[];
  /** True when the whole band sits in the announced future of the scrubbed date. */
  future: boolean;
}

export function drawBands(g: G, r: RenderCtx): void {
  const { x, y, computed } = r;
  if (!r.bands) {
    g.selectAll('*').remove();
    return;
  }

  const views: BandView[] = [];
  for (const v of computed.labViews) {
    if (!r.visible(v.lab.id)) continue;
    // TODO(T31): LabView.band is filled by lineupBand; while it is empty the drawing is a no-op.
    const pts = v.band.length ? v.band : (computed.bands.get(v.lab.id) ?? []);
    if (!hasWidth(pts)) continue;
    views.push({
      id: v.lab.id,
      color: v.lab.color,
      points: pts.map((p) => ({ d: toDate(p.date), hi: p.hiTheta, lo: p.loTheta })),
      future: pts[0]!.date >= computed.asOf,
    });
  }

  // y() speaks index at its face value; the band speaks theta, so map through indexFromTheta.
  const shape = area<{ d: Date; hi: number; lo: number }>()
    .x((p) => x(p.d))
    .y0((p) => y(indexFromTheta(p.lo)))
    .y1((p) => y(indexFromTheta(p.hi)))
    .curve(curveStepAfter);

  const sel = g.selectAll<SVGPathElement, BandView>('path.family-band').data(views, (d) => d.id);
  sel.exit().remove();
  sel
    .enter()
    .append('path')
    .attr('class', 'family-band')
    .merge(sel)
    .attr('d', (d) => shape(d.points) ?? '')
    .attr('fill', (d) => d.color)
    .attr('opacity', (d) => (d.future ? FUTURE_FADE_OPACITY : BAND_OPACITY))
    .attr('pointer-events', 'none');
}

/** A band that is hi === lo everywhere is a line, not a band — skip it. */
function hasWidth(pts: BandPoint[]): boolean {
  return pts.some((p) => p.hiTheta > p.loTheta + 1e-9);
}
