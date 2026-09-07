/**
 * The level ladder (REDESIGN §2.1, §7.1): hairlines across the plot at each level theta with the
 * label set into the right-hand gutter. Labels are de-duplicated by a 14 px minimum gap — when
 * two levels crowd each other the lower-priority kind yields (`ceiling` > `generation` >
 * `human` > `saturation`). Hovering a label tells the full story: level, benchmark, rating.
 */
import type { Level } from '@agi/shared';
import { fmtDate } from '../ui/format';
import { INK, type RenderCtx } from './types';
import { toDate, type ValueTick } from './scales';
import type { G } from './layers';

const LABEL_GAP = 14;
const KIND_RANK: Record<Level['kind'], number> = { ceiling: 0, generation: 1, human: 2, saturation: 3 };

interface LadderRow {
  level: Level;
  y: number;
  shown: boolean;
}

/** Ascending priority: a crowded label is dropped when a higher-rank label is within the gap. */
export function thinLevels(levels: Level[], pxOf: (level: Level) => number): Level[] {
  const ranked = [...levels].sort((a, b) => pxOf(a) - pxOf(b));
  const kept: Level[] = [];
  for (const lv of ranked) {
    const py = pxOf(lv);
    const clash = kept.find((k) => Math.abs(pxOf(k) - py) < LABEL_GAP);
    if (!clash) {
      kept.push(lv);
      continue;
    }
    if (KIND_RANK[lv.kind] < KIND_RANK[clash.kind]) {
      kept[kept.indexOf(clash)] = lv;
    }
  }
  return kept;
}

export function drawLadder(g: G, r: RenderCtx, yTicks: ValueTick[]): void {
  const { geom, x, y, computed } = r;
  const gutterX = geom.x1 + 6;
  const compact = geom.compact;

  // Horizontal hairlines at the *tick* positions come with the grid; the ladder adds the levels.
  const visible = computed.levels.filter((lv) => {
    const py = y(indexAt(lv));
    return py >= geom.y1 - 1 && py <= geom.y0 + 1;
  });
  const shown = thinLevels(visible, (lv) => y(indexAt(lv)));

  // hairlines — inline stroke so they render before T34's stylesheet lands
  const lines = g.selectAll<SVGLineElement, Level>('line.level-rule').data(shown, (d) => d.id);
  lines.exit().remove();
  lines
    .enter()
    .append('line')
    .merge(lines)
    .attr('class', (d) => `level-rule level-rule--${d.kind}`)
    .attr('x1', geom.x0)
    .attr('x2', geom.x1)
    .attr('y1', (d) => y(indexAt(d)))
    .attr('y2', (d) => y(indexAt(d)))
    .attr('stroke', (d) => (d.kind === 'ceiling' || d.kind === 'generation' ? '#111111' : '#6b6b6b'))
    .attr('stroke-opacity', (d) => (d.kind === 'ceiling' ? 0.35 : 0.22))
    .attr('stroke-width', 1)
    .attr('stroke-dasharray', (d) => (d.kind === 'saturation' ? '2 4' : d.kind === 'human' ? '6 3' : ''))
    .attr('pointer-events', 'none');

  // gutter labels
  const labels = g.selectAll<SVGTextElement, Level>('text.level-label').data(shown, (d) => d.id);
  labels.exit().remove();
  const entered = labels
    .enter()
    .append('text')
    .attr('class', (d) => `level-label level-label--${d.kind}`)
    .attr('tabindex', 0)
    .attr('role', 'img');
  const merged = entered.merge(labels as never);
  // The gutter is ~120 px desktop / 72 px mobile: truncate with an ellipsis — the tooltip and
  // the aria-label carry the full text (Jost 10.5 px averages ~6 px per glyph).
  // Fits the gutter (scales.ts GUTTER_RIGHT*) at Jost 10.5 px ≈ 6.2 px per glyph.
  const maxChars = Math.floor((compact ? 76 : 134) / 6.2);
  merged
    .attr('x', gutterX)
    .attr('y', (d) => y(indexAt(d)) + 3.5)
    .text((d) => {
      const full = compact || d.label.length > maxChars ? shortLabel(d, r.ctx.benchmarks) : d.label;
      return full.length > maxChars ? `${full.slice(0, Math.max(4, maxChars - 1))}…` : full;
    })
    .attr('aria-label', (d) => `${d.label}, rating ${Math.round(d.rating)}`)
    .on('pointerenter', function (ev: PointerEvent, d) {
      r.io.hoverLevel?.(d.id);
      r.io.tip(levelTooltip(computed.crossings, d), ev);
    })
    .on('pointermove', (ev: PointerEvent) => r.io.tipMove(ev))
    .on('pointerleave', function () {
      r.io.hoverLevel?.(null);
      r.io.tipHide();
    })
    .on('focus', function (this: SVGTextElement, _ev: FocusEvent, d) {
      const box = this.getBoundingClientRect();
      r.io.tip(levelTooltip(computed.crossings, d), { clientX: box.left + box.width / 2, clientY: box.top });
    })
    .on('blur', () => r.io.tipHide());

  void x;
  void INK;
  void yTicks;
}

function indexAt(lv: Level): number {
  return indexFromThetaOf(lv.theta);
}

function indexFromThetaOf(theta: number): number {
  // Local to avoid a shared import in three modules; identical maths to frontier-index.
  return (100 / (1 + Math.exp(-theta)));
}

/** Mobile: drop the prose, keep the essence. */
/** Compact ladder label: benchmark short names, never ids. */
export function shortLabel(lv: Level, benchmarks?: Map<string, { short: string }>): string {
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

/** Tooltip: the level plus when the frontier reached / is expected to reach it. */
export function levelTooltip(crossings: { level: Level; kind: string; date: string; p16?: string; p84?: string }[], level: Level): string {
  const xing = crossings.find((c) => c.level.id === level.id);
  const rows: [string, string][] = [
    ['Rating', Math.round(level.rating).toString()],
    ['Kind', level.kind],
  ];
  if (level.benchmark) rows.push(["Benchmark", level.benchmark]);
  if (xing) {
    if (xing.kind === 'past') rows.push(['Reached', fmtDate(xing.date)]);
    else {
      rows.push(['Predicted', fmtDate(xing.date)]);
      if (xing.p16 && xing.p84) rows.push(['68 % window', `${fmtDate(xing.p16)} – ${fmtDate(xing.p84)}`]);
    }
  }
  const body = rows.map(([k, v]) => `<div class="tt-row"><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  return `<div class="tt-head"><span class="tt-dot" style="background:${INK}"></span>
    <span class="tt-name">${level.label}</span></div>
    <dl class="tt-rows">${body}</dl>`;
}
