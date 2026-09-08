/**
 * The time-axis strip (REDESIGN §12.1): a second SVG pinned to the stage's bottom edge, drawn
 * from the same x scale and view as the plot, so the plot can pan vertically without the dates
 * leaving the screen. Rows, top to bottom: the leadership stripe and release ticks (drawn by
 * `layers.ts` into the same SVG), the tick marks and date labels, then the pace strip.
 */
import { timeTicks, toDate, type TimeTick } from './scales';
import type { RenderCtx } from './types';
import type { G } from './layers';

/** Tick marks: short rules between the stripe row and the labels. */
const TICK_TOP = 13;
const TICK_H = 5;

export function drawTimeAxis(g: G, r: RenderCtx): void {
  const { geom, x } = r;
  const ticks = timeTicks(x, Math.max(3, Math.round(geom.iw / (geom.compact ? 78 : 104))));

  // the axis rule along the strip's top edge — the plot's floor
  let rule = g.select<SVGLineElement>('line.axis-rule');
  if (rule.empty()) rule = g.append('line').attr('class', 'axis-rule').attr('pointer-events', 'none');
  rule.attr('x1', geom.x0).attr('x2', geom.x1).attr('y1', 0.5).attr('y2', 0.5);

  const marks = g.selectAll<SVGLineElement, TimeTick>('line.axis-tick').data(ticks, (d) => String(d.date.getTime()));
  marks.exit().remove();
  marks
    .enter()
    .append('line')
    .merge(marks)
    .attr('class', (d) => `axis-tick${d.major ? ' axis-tick--major' : ''}`)
    .attr('x1', (d) => x(d.date))
    .attr('x2', (d) => x(d.date))
    .attr('y1', TICK_TOP)
    .attr('y2', TICK_TOP + TICK_H);

  const labels = g.selectAll<SVGTextElement, TimeTick>('text.axis-x').data(ticks, (d) => String(d.date.getTime()));
  labels.exit().remove();
  labels
    .enter()
    .append('text')
    .attr('text-anchor', 'middle')
    .merge(labels)
    .attr('class', (d) => `axis-label axis-x${d.major ? ' axis-label--major' : ''}`)
    .attr('x', (d) => x(d.date))
    .attr('y', geom.axisLabelY)
    .text((d) => d.label);

  // the "now" rule continues through the strip so the two SVGs read as one timeline
  const nowX = x(toDate(r.asOf));
  let now = g.select<SVGLineElement>('line.axis-now');
  if (now.empty()) now = g.append('line').attr('class', 'axis-now').attr('pointer-events', 'none');
  now
    .attr('x1', nowX)
    .attr('x2', nowX)
    .attr('y1', 0)
    .attr('y2', geom.axisH)
    .attr('display', nowX >= geom.x0 && nowX <= geom.x1 ? null : 'none');
}
