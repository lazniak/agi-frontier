/**
 * The level ladder (REDESIGN §2.1, §7.1, §12.1): hairlines across the plot at each level theta
 * with the label set into the right-hand gutter. Labels are de-duplicated by a 14 px minimum gap
 * — when two levels crowd each other the lower-priority kind yields (`speculative` > `ceiling` >
 * `generation` > `human` > `saturation`). Hovering a label tells the full story: level,
 * benchmark, rating.
 *
 * Above the basket ceiling the ladder also carries the four *speculative* landmarks
 * (`Computed.speculativeLevels`) in a distinct dotted grey style. Every one of their labels and
 * tooltips carries the word "speculative"; they never enter crossings, stages or eras.
 */
import type { Level } from '@agi/shared';
import { fmtDate } from '../ui/format';
import { ANNOUNCED, INK, type RenderCtx } from './types';
import { type ValueTick } from './scales';
import type { G } from './layers';

const LABEL_GAP = 14;
const KIND_RANK: Record<Level['kind'], number> = { speculative: -1, ceiling: 0, generation: 1, human: 2, saturation: 3 };

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
  const { geom, y, computed } = r;
  if (!r.layerOn('ladder')) {
    g.selectAll('*').remove();
    return;
  }
  const gutterX = geom.x1 + 6;
  const compact = geom.compact;

  // Horizontal hairlines at the *tick* positions come with the grid; the ladder adds the levels
  // — the fitted ones and, far above them, the speculative landmarks (REDESIGN §12.1).
  const all = [...computed.levels, ...computed.speculativeLevels];
  const visible = all.filter((lv) => {
    const py = y.theta(lv.theta);
    return py >= geom.y1 - 1 && py <= geom.y0 + 1;
  });
  const shown = thinLevels(visible, (lv) => y.theta(lv.theta));

  // hairlines — inline stroke so they render before the stylesheet lands
  const lines = g.selectAll<SVGLineElement, Level>('line.level-rule').data(shown, (d) => d.id);
  lines.exit().remove();
  lines
    .enter()
    .append('line')
    .merge(lines)
    .attr('class', (d) => `level-rule level-rule--${d.kind}`)
    .attr('x1', geom.x0)
    .attr('x2', geom.x1)
    .attr('y1', (d) => y.theta(d.theta))
    .attr('y2', (d) => y.theta(d.theta))
    .attr('stroke', (d) => (d.kind === 'speculative' ? ANNOUNCED : d.kind === 'ceiling' || d.kind === 'generation' ? INK : '#6b6b6b'))
    .attr('stroke-opacity', (d) => (d.kind === 'speculative' ? 0.7 : d.kind === 'ceiling' ? 0.35 : 0.22))
    .attr('stroke-width', 1)
    .attr('stroke-dasharray', (d) =>
      d.kind === 'speculative' ? '1.5 5' : d.kind === 'saturation' ? '2 4' : d.kind === 'human' ? '6 3' : '',
    )
    .attr('pointer-events', 'none');

  // gutter labels
  const labels = g.selectAll<SVGTextElement, Level>('text.level-label').data(shown, (d) => d.id);
  labels.exit().remove();
  const entered = labels
    .enter()
    .append('text')
    .attr('tabindex', 0)
    .attr('role', 'img');
  const merged = entered.merge(labels as never);
  // The label must end before the host's edge (the chart is full-bleed, so on a phone that edge
  // is the viewport): measure the rendered text instead of guessing a glyph width, fall back
  // from the full label to the short one, and only then trim with an ellipsis. The tooltip and
  // the aria-label carry the full text.
  const maxW = Math.max(24, geom.width - gutterX - 14);
  merged
    .attr('class', (d) => `level-label level-label--${d.kind}`)
    .attr('x', gutterX)
    .attr('y', (d) => y.theta(d.theta) + 3.5)
    .each(function (d) {
      // Benchmark first, so an ellipsis eats the suffix and never the name. Speculative rungs put
      // the word "speculative" first for the same reason — it must survive the trim.
      const candidates =
        d.kind === 'speculative'
          ? speculativeLabels(d)
          : compact
            ? [compactLabel(d, r.ctx.benchmarks), nameOnly(d, r.ctx.benchmarks)]
            : [nameFirstLabel(d, r.ctx.benchmarks)];
      fitText(this, candidates, maxW);
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

  void yTicks;
}

/**
 * Set the first candidate that fits `maxW` px, else the last one trimmed with an ellipsis.
 * `getComputedTextLength` is 0 while the SVG is not rendered — then the first candidate stays.
 */
function fitText(el: SVGTextElement, candidates: string[], maxW: number): void {
  for (const c of candidates) {
    el.textContent = c;
    if (el.getComputedTextLength() <= maxW) return;
  }
  let t = candidates[candidates.length - 1] ?? '';
  while (t.length > 3 && el.getComputedTextLength() > maxW) {
    t = t.slice(0, -1);
    el.textContent = `${t.trimEnd()}…`;
  }
}

/**
 * Gutter labels for the speculative landmarks, longest first. "Speculative" leads every
 * candidate so the ellipsis can only eat the description, never the warning (REDESIGN §12.1).
 */
export function speculativeLabels(lv: Level): string[] {
  switch (lv.id) {
    case 'spec-10x':
      return ['Speculative · 10× the basket odds', 'Speculative · 10×'];
    case 'spec-100x':
      return ['Speculative · 100× the basket odds', 'Speculative · 100×'];
    case 'spec-all':
      return ['Speculative · every benchmark saturated', 'Speculative · all saturated'];
    case 'spec-singularity':
      return ['Speculative · technological singularity', 'Speculative · singularity'];
    default:
      return [`Speculative · ${lv.label}`, 'Speculative'];
  }
}

/** Desktop fallback: "<benchmark> saturated" — the benchmark survives an ellipsis. */
export function nameFirstLabel(lv: Level, benchmarks?: Map<string, { short: string }>): string {
  const name = lv.benchmark ? (benchmarks?.get(lv.benchmark)?.short ?? lv.benchmark) : '';
  switch (lv.kind) {
    case 'ceiling':
      return 'Basket ceiling';
    case 'generation':
      return lv.generation === undefined ? 'Basket saturated' : `Gen ${lv.generation} saturated`;
    case 'human':
      return `${name} · human`;
    case 'speculative':
      return speculativeLabels(lv)[0] ?? lv.label;
    default:
      return `${name} saturated`;
  }
}

/** Last resort on a phone: the bare benchmark name (the rung style says which kind it is). */
function nameOnly(lv: Level, benchmarks?: Map<string, { short: string }>): string {
  const name = lv.benchmark ? (benchmarks?.get(lv.benchmark)?.short ?? lv.benchmark) : '';
  return name || compactLabel(lv, benchmarks);
}

/** Phone ladder label: the dashed rung already says "level", so just name it. */
export function compactLabel(lv: Level, benchmarks?: Map<string, { short: string }>): string {
  const name = lv.benchmark ? (benchmarks?.get(lv.benchmark)?.short ?? lv.benchmark) : '';
  switch (lv.kind) {
    case 'ceiling':
      return 'Ceiling';
    case 'generation':
      return lv.generation === undefined ? 'Saturated' : `Gen ${lv.generation}`;
    case 'human':
      return `${name} · human`;
    case 'speculative':
      return speculativeLabels(lv)[1] ?? 'Speculative';
    default:
      return name;
  }
}

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
    case 'speculative':
      return speculativeLabels(lv)[0] ?? lv.label;
    default:
      return `Saturated · ${name}`;
  }
}

/** Tooltip: the level plus when the frontier reached / is expected to reach it. */
export function levelTooltip(crossings: { level: Level; kind: string; date: string; p16?: string; p84?: string }[], level: Level): string {
  const speculative = level.kind === 'speculative';
  const xing = speculative ? undefined : crossings.find((c) => c.level.id === level.id);
  const rows: [string, string][] = [
    ['Rating', Math.round(level.rating).toString()],
    ['Kind', speculative ? 'speculative landmark' : level.kind],
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
  const note = speculative
    ? `<p class="tt-note">Speculative: a landmark for the scale, not a measurement. It is not derived from data and never enters the crossings, the stages or the eras.</p>`
    : '';
  return `<div class="tt-head"><span class="tt-dot" style="background:${speculative ? ANNOUNCED : INK}"></span>
    <span class="tt-name">${level.label}</span></div>
    <dl class="tt-rows">${body}</dl>${note}`;
}
