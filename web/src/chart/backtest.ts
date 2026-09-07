/**
 * Backtest overlay (REDESIGN §5): visible only while the page is scrubbed into the past. For
 * each lab row that has both a prediction and an actual release: the predicted circle (already
 * drawn by the forecast layer) joined by a hairline to the actual release — a solid ink dot at
 * its true date and theta, even though that date is "in the future" of the scrubbed asOf.
 * Colour: green inside the 68 % window, amber inside 90 %, red outside.
 */
import type { BacktestRow } from '@agi/shared';
import { indexFromTheta } from '@agi/shared';
import { fmtDate, fmtDays } from '../ui/format';
import { toDate } from './scales';
import { INK, type RenderCtx } from './types';
import { crossingRadius } from './crossings';
import type { Crossing } from '@agi/shared';
import type { G } from './layers';

const IN68 = '#2E7D32';
const IN90 = '#C77700';
const OUTSIDE = '#C62828';

const EN = '–';

export function drawBacktest(g: G, r: RenderCtx): void {
  const { x, y, computed, geom } = r;
  const rows = computed.backtest.rows;
  if (!rows || !rows.length) {
    g.selectAll('*').remove();
    return;
  }

  interface Link {
    row: BacktestRow;
    px: number; // predicted median x
    py: number; // predicted theta y
    ax: number; // actual x
    ay: number; // actual y
    rd: number; // predicted circle radius
    color: string;
  }

  const links: Link[] = [];
  for (const row of rows) {
    if (!row.predictedMedian || !row.actual || row.predictedTheta === null || row.actual.theta === null) continue;
    const px = x(toDate(row.predictedMedian));
    const ax = x(toDate(row.actual.date));
    if (ax < geom.x0 - 20 || ax > geom.x1 + 20) continue;
    const color = row.in68 === true ? IN68 : row.in90 === true ? IN90 : OUTSIDE;
    // The predicted circle: same 68 %-window radius rule, centred on the predicted theta.
    const fake: Crossing = {
      level: { id: `bt:${row.lab}:${row.asOf}`, kind: 'generation', label: row.lab, theta: 0, rating: 0 },
      kind: 'predicted',
      date: row.predictedMedian,
      ...(row.p16 ? { p16: row.p16 } : {}),
      ...(row.p84 ? { p84: row.p84 } : {}),
    };
    links.push({
      row,
      px,
      py: y(indexFromTheta(row.predictedTheta)),
      ax,
      ay: y(indexFromTheta(row.actual.theta ?? 0)),
      rd: crossingRadius(fake, x),
      color,
    });
  }

  const key = (d: Link): string => `${d.row.lab}|${d.row.asOf}`;

  // hairlines under everything
  const lineSel = g.selectAll<SVGLineElement, Link>('line.bt-link').data(links, key);
  lineSel.exit().remove();
  lineSel
    .enter()
    .append('line')
    .attr('class', 'bt-link')
    .merge(lineSel as never)
    .attr('x1', (d) => d.px)
    .attr('y1', (d) => d.py)
    .attr('x2', (d) => d.ax)
    .attr('y2', (d) => d.ay)
    .attr('stroke', (d) => d.color)
    .attr('stroke-width', 1)
    .attr('stroke-opacity', 0.7)
    .attr('stroke-dasharray', '2 3')
    .attr('pointer-events', 'none');

  // the actual release: a solid ink-ringed dot in the verdict colour
  const dotSel = g.selectAll<SVGCircleElement, Link>('circle.bt-actual').data(links, key);
  dotSel.exit().remove();
  const dEnter = dotSel
    .enter()
    .append('circle')
    .attr('class', 'bt-actual')
    .attr('r', 4)
    .attr('tabindex', 0)
    .attr('role', 'img');
  dEnter
    .merge(dotSel as never)
    .attr('cx', (d) => d.ax)
    .attr('cy', (d) => d.ay)
    .attr('fill', (d) => d.color)
    .attr('stroke', INK)
    .attr('stroke-width', 1)
    .attr('aria-label', (d) => btLabel(d.row))
    .on('pointerenter', (ev: PointerEvent, d) => r.io.tip(btTooltip(d.row), ev))
    .on('pointermove', (ev: PointerEvent) => r.io.tipMove(ev))
    .on('pointerleave', () => r.io.tipHide())
    .on('focus', function (this: SVGCircleElement, _ev: FocusEvent, d) {
      const box = this.getBoundingClientRect();
      r.io.tip(btTooltip(d.row), { clientX: box.left + box.width / 2, clientY: box.top });
    })
    .on('blur', () => r.io.tipHide());
}

function btLabel(row: BacktestRow): string {
  const hit = row.in68 === true ? 'inside the 68 % window' : row.in90 === true ? 'inside the 90 % window' : 'outside the 90 % window';
  const err = row.errorDays === null ? 'no error' : `${fmtDays(Math.abs(row.errorDays))} ${row.errorDays >= 0 ? 'late' : 'early'}`;
  return `${row.lab}: predicted ${row.predictedMedian ?? '?'}, released ${row.actual?.date ?? '?'}, ${err}, ${hit}`;
}

function btTooltip(row: BacktestRow): string {
  const hit = row.in68 === true ? IN68 : row.in90 === true ? IN90 : OUTSIDE;
  const rows: [string, string][] = [
    ['Predicted median', row.predictedMedian ? fmtDate(row.predictedMedian) : 'none'],
    ['Actual release', row.actual ? fmtDate(row.actual.date) : 'none yet'],
  ];
  if (row.errorDays !== null) {
    rows.push(['Error', `${fmtDays(Math.abs(row.errorDays))} ${row.errorDays >= 0 ? 'late' : 'early'}`]);
  }
  if (row.thetaError !== null) {
    rows.push(['Rating error', Math.round(row.thetaError * 173.72).toString()]);
  }
  if (row.p16 && row.p84) {
    rows.push(['68 % window', `${fmtDate(row.p16)} ${EN} ${fmtDate(row.p84)}`]);
  }
  const body = rows.map(([k, v]) => `<div class="tt-row"><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  return `<div class="tt-head"><span class="tt-dot" style="background:${hit}"></span>
    <span class="tt-name">${row.lab} — backtest as of ${fmtDate(row.asOf)}</span></div>
    <dl class="tt-rows">${body}</dl>
    <p class="tt-hint">Green = inside 68 %, amber = inside 90 %, red = outside</p>`;
}
