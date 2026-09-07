/**
 * The pace strip under the plot: one bar per calendar quarter, its height the frontier's gain in
 * that quarter measured in *logits* (latent ability), not index points.
 *
 * This is the answer to "is it really moving this fast?". On the 0–100 index the frontier looks
 * like it is flattening out near the top, but that is the sigmoid, not the models: in latent
 * ability the steps are as large as ever. The bars make that visible without a formula.
 */
import { ratingFromTheta, type FrontierGain, type PaceRegime } from '@agi/shared';
import { fmtDate } from '../ui/format';
import { paceTooltip, eraTooltip } from './tooltip';
import { toDate } from './scales';
import { INK, type RenderCtx } from './types';
import type { G } from './layers';

/** Bars are scaled against this so the strip does not re-scale while the scrubber moves. */
export interface PaceScale {
  maxGain: number;
}

/** Regime → grey step: darker = faster. */
const ERA_GREYS: Record<PaceRegime, string> = {
  dormant: '#f2f2f2',
  climb: '#e2e2e2',
  acceleration: '#cfcfcf',
  takeoff: '#b9b9b9',
};

export function drawPace(g: G, r: RenderCtx, scale: PaceScale): void {
  const { geom, x, computed } = r;
  if (!geom.paceH) {
    g.selectAll('*').remove();
    return;
  }
  const top = geom.paceTop;
  const bottom = geom.paceTop + geom.paceH;
  const maxGain = Math.max(scale.maxGain, 1e-6);
  const barH = (gain: number): number => Math.max(gain > 0 ? 1.5 : 0, (gain / maxGain) * (geom.paceH - 14));

  // baseline
  let base = g.select<SVGLineElement>('line.pace-base');
  if (base.empty()) base = g.append('line').attr('class', 'pace-base').attr('pointer-events', 'none');
  base.attr('x1', geom.x0).attr('x2', geom.x1).attr('y1', bottom).attr('y2', bottom);

  // era shading behind the bars: one rounded rect per pace regime (REDESIGN §2.3)
  const eras = computed.eras;
  const eraSel = g.selectAll<SVGRectElement, (typeof eras)[number]>('rect.pace-era').data(eras, (d) => d.start);
  eraSel.exit().remove();
  const eraEnter = eraSel
    .enter()
    .append('rect')
    .attr('class', 'pace-era')
    .attr('y', top)
    .attr('rx', 2)
    .attr('tabindex', 0)
    .attr('role', 'img');
  eraEnter
    .merge(eraSel)
    .attr('x', (d) => Math.max(geom.x0, Math.min(x(toDate(d.start)), x(toDate(d.end ?? computed.asOf)))))
    .attr('width', (d) => {
      const a = Math.max(geom.x0, Math.min(x(toDate(d.start)), x(toDate(d.end ?? computed.asOf))));
      const b = Math.min(geom.x1, Math.max(x(toDate(d.start)), x(toDate(d.end ?? computed.asOf))));
      return Math.max(0, b - a);
    })
    .attr('height', Math.max(0, geom.paceH - 2))
    .attr('fill', (d) => ERA_GREYS[d.regime])
    .attr('aria-label', (d) => `${d.regime} era: mean ${d.meanPace.toFixed(1)} logits per year`)
    .on('pointerenter', (ev: PointerEvent, d) => r.io.tip(eraTooltip(d), ev))
    .on('pointermove', (ev: PointerEvent) => r.io.tipMove(ev))
    .on('pointerleave', () => r.io.tipHide())
    .on('focus', function (this: SVGRectElement, _ev: FocusEvent, d) {
      const box = this.getBoundingClientRect();
      r.io.tip(eraTooltip(d), { clientX: box.left + box.width / 2, clientY: box.top });
    })
    .on('blur', () => r.io.tipHide());

  // the projected era: a hatched tail after the scrubbed date, regime of the current trend
  const proj = computed.projectedEra;
  let tail = g.select<SVGRectElement>('rect.pace-projected');
  if (!proj) {
    tail.remove();
  } else {
    if (tail.empty()) tail = g.append('rect').attr('class', 'pace-projected').attr('pointer-events', 'none');
    const from = x(toDate(computed.asOf));
    tail
      .attr('x', Math.min(geom.x1, Math.max(geom.x0, from)))
      .attr('y', top)
      .attr('width', Math.max(0, Math.min(geom.x1, geom.x1) - Math.min(geom.x1, Math.max(geom.x0, from))))
      .attr('height', Math.max(0, geom.paceH - 2))
      .attr('fill', ERA_GREYS[proj])
      .attr('fill-opacity', 0.5)
      .attr('stroke', '#9a9a9a')
      .attr('stroke-width', 0.75)
      .attr('stroke-dasharray', '3 3');
  }

  // caption, top-left — same voice as the axis title
  let cap = g.select<SVGTextElement>('text.pace-title');
  if (cap.empty()) cap = g.append('text').attr('class', 'axis-title pace-title').attr('pointer-events', 'none');
  cap
    .attr('x', geom.x0)
    .attr('y', top - 6)
    .text(geom.compact ? 'Pace · gain per quarter' : 'Pace · frontier gain per quarter, in latent ability (logits)');

  // trailing-year summary, top-right
  let sum = g.select<SVGTextElement>('text.pace-summary');
  if (sum.empty()) sum = g.append('text').attr('class', 'pace-summary').attr('pointer-events', 'none');
  const pace = computed.pace;
  const summary = !pace
    ? ''
    : pace.doublingDays && pace.doublingDays < 3650
      ? `${pace.logitsPerYear >= 0 ? '+' : '−'}${Math.abs(pace.logitsPerYear).toFixed(1)} logits / yr · odds double every ${(pace.doublingDays / 30.4375).toFixed(1)} months`
      : `${pace.logitsPerYear >= 0 ? '+' : '−'}${Math.abs(pace.logitsPerYear).toFixed(1)} logits / yr`;
  sum
    .attr('x', geom.x1)
    .attr('y', top - 6)
    .attr('text-anchor', 'end')
    .attr('display', geom.compact ? 'none' : null)
    .text(summary);

  const bars = g.selectAll<SVGRectElement, FrontierGain>('rect.pace-bar').data(computed.gains, (d) => d.start);
  bars.exit().remove();
  bars
    .enter()
    .append('rect')
    .attr('class', 'pace-bar')
    .attr('tabindex', 0)
    .attr('role', 'img')
    .merge(bars)
    .attr('x', (d) => Math.max(geom.x0, Math.min(x(toDate(d.start)), x(toDate(d.end))) + 1))
    .attr('width', (d) => {
      const a = Math.max(geom.x0, Math.min(x(toDate(d.start)), x(toDate(d.end))) + 1);
      const b = Math.min(geom.x1, Math.max(x(toDate(d.start)), x(toDate(d.end))) - 1);
      return Math.max(0, b - a);
    })
    .attr('y', (d) => bottom - barH(d.gain))
    .attr('height', (d) => barH(d.gain))
    .attr('fill', INK)
    .attr('aria-label', (d) => `Quarter from ${fmtDate(d.start)}: frontier gained ${d.gain.toFixed(2)} logits in ${d.steps} steps`)
    .on('pointerenter', (ev: PointerEvent, d) => r.io.tip(paceTooltip(d), ev))
    .on('pointermove', (ev: PointerEvent) => r.io.tipMove(ev))
    .on('pointerleave', () => r.io.tipHide())
    .on('focus', function (this: SVGRectElement, _ev: FocusEvent, d) {
      const box = this.getBoundingClientRect();
      r.io.tip(paceTooltip(d), { clientX: box.left + box.width / 2, clientY: box.top });
    })
    .on('blur', () => r.io.tipHide());

  // the "now" rule continues through the strip so the two read as one timeline
  const nowX = x(toDate(r.asOf));
  let rule = g.select<SVGLineElement>('line.pace-now');
  if (rule.empty()) rule = g.append('line').attr('class', 'pace-now').attr('pointer-events', 'none');
  rule
    .attr('x1', nowX)
    .attr('x2', nowX)
    .attr('y1', top - 2)
    .attr('y2', bottom)
    .attr('display', nowX >= geom.x0 && nowX <= geom.x1 ? null : 'none');
}
