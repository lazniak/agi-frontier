/**
 * The chart's drawing layers. Each function owns one <g> and re-joins its data;
 * the groups stay separate so the gyroscope parallax can move them independently.
 *
 * Focus (REDESIGN §12.2) is *not* painted here: every per-lab element carries `data-lab`, and the
 * shell toggles `is-focus` / `is-dim` on them after each draw (`hover.ts#applyFocus`); `chart.css`
 * animates the opacity and stroke-width. Layers therefore never set an opacity for focus.
 */
import { select, type Selection } from 'd3-selection';
import { curveMonotoneX, curveStepAfter, line } from 'd3-shape';
import { type LeadershipStripe, type ModelRelease } from '@agi/shared';
import type { LabView, SeriesPoint } from '../data';
import { fmtDate, fmtIndex } from '../ui/format';
import { markerTooltip, releaseTooltip, stripeTooltip, tickTooltip } from './tooltip';
import { timeTicks, toDate, valueTicks } from './scales';
import { ANNOUNCED, INK, type RenderCtx } from './types';

export type G = Selection<SVGGElement, unknown, null, undefined>;

const KEY_STRIPE = (s: LeadershipStripe): string => `${s.lab}|${s.from}`;

/* -------------------------------------------------------------------- grid */

export function drawGrid(g: G, r: RenderCtx): void {
  const { geom, x, y } = r;
  const ticks = timeTicks(x, Math.max(3, Math.round(geom.iw / (geom.compact ? 78 : 104))));
  const yTicks = valueTicks(y, geom);

  // horizontal rules — the whole visible range, whatever the zoom (REDESIGN §12.1)
  const rules = g.selectAll<SVGLineElement, { theta: number; label: string }>('line.grid-h').data(yTicks, (d) => d.label);
  rules.exit().remove();
  rules
    .enter()
    .append('line')
    .attr('class', 'grid-line grid-h')
    .merge(rules)
    .attr('x1', geom.x0)
    .attr('x2', geom.x1)
    .attr('y1', (d) => y.theta(d.theta))
    .attr('y2', (d) => y.theta(d.theta));

  // The tick numbers live in the right-hand ladder gutter (drawLadder); the left edge keeps a
  // bare axis without duplicated labels.
  const yLabels = g.selectAll<SVGTextElement, { theta: number; label: string }>('text.grid-y').data(yTicks, (d) => d.label);
  yLabels.exit().remove();
  yLabels
    .enter()
    .append('text')
    .attr('class', 'axis-label grid-y')
    .attr('text-anchor', 'end')
    .merge(yLabels)
    .attr('x', geom.x0 - 10)
    .attr('y', (d) => y.theta(d.theta) + 3.5)
    .text((d) => d.label)
    .each(function () {
      // `text-anchor: end`, so `x` is the label's *right* edge. Zoomed far out the ladder reaches
      // five-digit ratings, which are wider than the left margin on a phone; rather than let the
      // viewport shave the first digit, push such a label right until its left edge clears.
      const len = typeof this.getComputedTextLength === 'function' ? this.getComputedTextLength() : 0;
      const min = len + 3;
      if (geom.x0 - 10 < min) this.setAttribute('x', String(min));
    });

  // vertical rules — the date labels themselves live in the axis strip (chart/axis.ts)
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
  g.selectAll('text.grid-x').remove();

  // Axis caption — above the plot, flush with the y axis, so it never collides with the 100 tick.
  let cap = g.select<SVGTextElement>('text.axis-title');
  if (cap.empty()) cap = g.append('text').attr('class', 'axis-title');
  cap
    .attr('x', geom.x0)
    .attr('y', geom.y1 - 22)
    .attr('text-anchor', 'start')
    .text(
      geom.compact
        ? y.mode === 'rating'
          ? 'Frontier Rating · equal steps, equal odds'
          : 'Frontier Index · 100 is the asymptote'
        : y.mode === 'rating'
          ? 'Frontier Rating · equal steps are equal odds ratios'
          : 'Frontier Index · 100 is the asymptote',
    );

  // What the top of the scale means on the index reading. The rating axis is unbounded — no
  // note, the ladder gutter tells the story instead.
  const sat = g.select<SVGTextElement>('text.saturation-note').empty()
    ? g.append('text').attr('class', 'saturation-note')
    : g.select<SVGTextElement>('text.saturation-note');
  const showSat = !geom.compact && y.mode === 'index' && (y.domain()[1] ?? 0) >= 99;
  sat
    .attr('x', geom.x0 + 7)
    .attr('y', geom.y1 + 14)
    .attr('text-anchor', 'start')
    .attr('display', showSat ? null : 'none')
    .text('Saturation of the basket');
}

/* ----------------------------------------------------------------- stripes */

/** Leadership stripe — lives in the axis strip, first row (strip coordinates). */
export function drawStripes(g: G, r: RenderCtx): void {
  const { geom, x, computed, ctx } = r;
  const bandY = geom.stripeY;
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
    .attr('data-lab', (d) => d.lab)
    .attr('x', (d) => Math.min(x(toDate(d.from)), x(toDate(d.to ?? endISO))))
    .attr('width', (d) => Math.max(2, Math.abs(x(toDate(d.to ?? endISO)) - x(toDate(d.from)))))
    .attr('fill', (d) => ctx.labs.get(d.lab)?.color ?? INK)
    .on('pointerenter', function (ev: PointerEvent, d) {
      r.io.tip(stripeTooltip(ctx, d, endISO), ev);
    })
    .on('pointermove', (ev: PointerEvent) => r.io.tipMove(ev))
    .on('pointerleave', () => r.io.tipHide());
}

/* ------------------------------------------------------------------- ticks */

/**
 * Released flagships with no index score at all (GPT-1, the first Kimi…) have no height, so
 * they are drawn as ticks on the leadership strip. The timeline stays complete even where
 * the basket cannot reach.
 */
export function drawTicks(g: G, r: RenderCtx): void {
  const { geom, x, ctx } = r;
  const bandY = geom.stripeY;
  const items: ModelRelease[] = [];
  for (const v of r.computed.labViews) if (r.visible(v.lab.id)) items.push(...v.unscored);

  const sel = g.selectAll<SVGRectElement, ModelRelease>('rect.release-tick').data(items, (d) => d.id);
  sel.exit().remove();
  sel
    .enter()
    .append('rect')
    .attr('class', 'release-tick')
    .attr('width', 2)
    .attr('height', 12)
    .attr('rx', 1)
    .attr('tabindex', 0)
    .attr('role', 'button')
    .merge(sel)
    .attr('data-lab', (d) => d.lab)
    .attr('x', (d) => x(toDate(d.date)) - 1)
    .attr('y', bandY - 3)
    .attr('fill', (d) => ctx.labs.get(d.lab)?.color ?? INK)
    .attr('aria-label', (d) => `${d.name}, ${ctx.labs.get(d.lab)?.name ?? d.lab}, released ${fmtDate(d.date)}, no index score. Activate for sources.`)
    .on('pointerenter', function (ev: PointerEvent, d) {
      r.io.tip(tickTooltip(ctx, d), ev);
    })
    .on('pointermove', (ev: PointerEvent) => r.io.tipMove(ev))
    .on('pointerleave', () => r.io.tipHide())
    .on('focus', function (this: SVGRectElement, _ev: FocusEvent, d) {
      const box = this.getBoundingClientRect();
      r.io.tip(tickTooltip(ctx, d), { clientX: box.left + box.width / 2, clientY: box.top });
    })
    .on('blur', () => r.io.tipHide())
    .on('click', (_ev: PointerEvent, d) => r.io.openAudit(d.id))
    .on('keydown', (ev: KeyboardEvent, d) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        r.io.openAudit(d.id);
      }
    });
}

/* ------------------------------------------------------------------- lines */

export function drawLines(g: G, r: RenderCtx): void {
  const { x, y, computed } = r;
  const path = line<SeriesPoint>()
    .x((d) => x(toDate(d.release.date)))
    .y((d) => y(d.mi.index))
    .curve(curveMonotoneX);

  // A lab line joins qualified releases and nothing else (METHODOLOGY §3). Running it through a
  // provisional point would invent a dive the index never measured — those points stay hollow and
  // off the line. Fewer than two qualified releases means no line at all, just markers.
  const data = computed.labViews.filter((v) => v.qualified.length > 1 && r.visible(v.lab.id));
  const sel = g.selectAll<SVGPathElement, LabView>('path.lab-line').data(data, (d) => d.lab.id);
  sel.exit().remove();
  sel
    .enter()
    .append('path')
    .attr('class', 'lab-line')
    .merge(sel)
    .attr('data-lab', (d) => d.lab.id)
    .attr('d', (d) => path(d.qualified) ?? '')
    .attr('stroke', (d) => d.lab.color)
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

  // The dotted continuation beyond "now" is the frontier trend fan's median, drawn yellow by
  // chart/crossings.ts (frontier-fan-median) on top of the grey band - not duplicated here.
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

  // A provisional release (fewer than MIN_QUALIFIED_SCORES index benchmarks) is drawn hollow:
  // white fill, the lab's colour as the 1.5px stroke. The lab line still runs through it.
  const colorOf = (d: SeriesPoint): string => ctx.labs.get(d.release.lab)?.color ?? INK;

  merged
    .attr('class', (d) =>
      `lab-point${d.mi.qualified ? '' : ' lab-point--provisional'}${d.mi.release_id === r.selected ? ' is-selected' : ''}`,
    )
    .attr('data-id', (d) => d.mi.release_id)
    .attr('data-lab', (d) => d.release.lab)
    .attr('cx', (d) => x(toDate(d.release.date)))
    .attr('cy', (d) => y(d.mi.index))
    .attr('fill', (d) => (d.mi.qualified ? colorOf(d) : '#fff'))
    .attr('stroke', (d) => (d.mi.qualified ? '#fff' : colorOf(d)))
    .attr('aria-label', (d) =>
      `${d.release.name}, ${ctx.labs.get(d.release.lab)?.name ?? d.release.lab}, released ${fmtDate(d.release.date)}, rating ${Math.round(d.mi.rating)}, index ${fmtIndex(d.mi.index)}${
        d.mi.qualified ? '' : ', provisional'
      }. Activate for sources.`,
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

/**
 * Announced / rumored / cancelled models have no scores, so their height is *indicative*: the
 * lab's own capability trend at that date. A future date takes the k = 1 prediction, a past one
 * the last qualified index the lab had before it; a lab with no trend at all falls back to the
 * frontier. Never the lab line — the tooltip says so, and the marker is drawn hollow and grey.
 */
function markerLevel(r: RenderCtx, rel: ModelRelease): number {
  const view = r.computed.byLab.get(rel.lab);
  const announced = view?.forecast?.next.find((p) => p.release_id === rel.id);
  if (announced) return announced.index;

  if (view) {
    if (rel.date > r.computed.asOf) {
      const next = view.predictions.find((p) => p.k === 1) ?? view.forecast?.next[0];
      if (next) return next.index;
    }
    // Last qualified index strictly before the marker's own date.
    for (let i = view.qualified.length - 1; i >= 0; i--) {
      const p = view.qualified[i]!;
      if (p.release.date <= rel.date) return p.mi.index;
    }
    if (view.lastQualified) return view.lastQualified.mi.index;
  }

  const frontierBefore = [...r.computed.frontier].reverse().find((p) => p.date <= rel.date);
  const lastFrontier = frontierBefore ?? r.computed.frontier[r.computed.frontier.length - 1];
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
    .attr('data-lab', (d) => d.lab)
    .attr(
      'aria-label',
      (d) =>
        `${d.name}, ${ctx.labs.get(d.lab)?.name ?? d.lab}, ${d.status}, ${fmtDate(d.date)}. No scores — its height on the index is indicative.`,
    )
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
  /** Where the label is drawn after de-confliction. */
  y: number;
  /** Where the lab's line actually ends — the leader line goes back to this. */
  anchorY: number;
}

/** Minimum vertical distance between two end-labels. */
const LABEL_GAP = 13;
/** Beyond this displacement a label needs a leader line to stay attached to its line. */
const LEADER_MIN = 6;

/**
 * The pixel box a placed end-label occupies. Handed to `chart/crossings.ts`, which labels the
 * same crowded strip of canvas — the last releases hug the NOW rule and so do the crossings, so
 * "OPENAI" and "Saturated · SWE-bench" would otherwise print on top of each other.
 */
export interface LabelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Draws the lab end-labels and their leaders; returns the boxes they ended up occupying. */
export function drawLabels(g: G, r: RenderCtx): LabelBox[] {
  const { geom, x, y, computed } = r;
  if (!geom.endLabels) {
    g.selectAll('text.lab-label').remove();
    g.selectAll('line.lab-leader').remove();
    return [];
  }

  const raw: EndLabel[] = [];
  for (const v of computed.labViews) {
    // The label belongs to the line, so it follows the last *qualified* release; a lab with no
    // line at all still gets one, parked on its newest point.
    const at = v.lastQualified ?? v.last;
    if (!r.visible(v.lab.id) || !at) continue;
    const yy = y(at.mi.index);
    raw.push({
      id: v.lab.id,
      short: v.lab.short,
      color: v.lab.color,
      x: x(toDate(at.release.date)),
      y: yy,
      anchorY: yy,
    });
  }

  // Push overlapping labels apart, keeping their vertical order: forward pass opens the gaps,
  // then a backward pass from the bottom edge and a final forward pass from the top keep the
  // whole stack inside the plot however many labs are on.
  raw.sort((a, b) => a.y - b.y);
  const top = geom.y1 + 5;
  const bottom = geom.y0 - 3;
  const spread = (): void => {
    for (let i = 1; i < raw.length; i++) {
      const prev = raw[i - 1]!;
      const cur = raw[i]!;
      if (cur.y - prev.y < LABEL_GAP) cur.y = prev.y + LABEL_GAP;
    }
  };
  spread();
  const lastLabel = raw[raw.length - 1];
  if (lastLabel && lastLabel.y > bottom) {
    lastLabel.y = bottom;
    for (let i = raw.length - 2; i >= 0; i--) {
      const below = raw[i + 1]!;
      const cur = raw[i]!;
      if (below.y - cur.y < LABEL_GAP) cur.y = below.y - LABEL_GAP;
    }
  }
  const firstLabel = raw[0];
  if (firstLabel && firstLabel.y < top) {
    firstLabel.y = top;
    spread();
  }

  const textX = (d: EndLabel): number => Math.min(d.x + 11, geom.x1 + 8);

  const leaders = raw.filter((d) => Math.abs(d.y - d.anchorY) > LEADER_MIN);
  const lines = g.selectAll<SVGLineElement, EndLabel>('line.lab-leader').data(leaders, (d) => d.id);
  lines.exit().remove();
  lines
    .enter()
    .append('line')
    .attr('class', 'lab-leader')
    .merge(lines)
    .attr('data-lab', (d) => d.id)
    .attr('x1', (d) => d.x + 3)
    .attr('y1', (d) => d.anchorY)
    .attr('x2', (d) => textX(d) - 2)
    .attr('y2', (d) => d.y)
    .attr('stroke', (d) => d.color);

  const sel = g.selectAll<SVGTextElement, EndLabel>('text.lab-label').data(raw, (d) => d.id);
  sel.exit().remove();
  const labels = sel.enter().append('text').attr('class', 'lab-label').merge(sel);
  labels
    .attr('data-lab', (d) => d.id)
    .attr('x', textX)
    .attr('y', (d) => d.y + 4)
    .attr('fill', (d) => d.color)
    .text((d) => d.short);

  // 11.5 px uppercase Jost with 0.09em tracking runs about 8 px per character — the fallback
  // when the platform cannot measure (no layout engine in a test DOM).
  const boxes: LabelBox[] = [];
  labels.each(function (d) {
    const w = typeof this.getComputedTextLength === 'function' ? this.getComputedTextLength() : d.short.length * 8;
    const left = textX(d);
    const baseline = d.y + 4;
    boxes.push({ x0: left - 2, y0: baseline - 10, x1: left + w + 2, y1: baseline + 4 });
  });
  return boxes;
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
  rule.attr('x1', nowX).attr('x2', nowX).attr('y1', geom.y1 - 6).attr('y2', geom.y0 + geom.m.bottom);

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

/* ------------------------------------------------------------------- tiers */

/**
 * Mid and small releases (REDESIGN §3): small hollow markers in the lab colour, never on the
 * line, same audit/tooltip interactions as the flagship points. Drawn only when the store's
 * tier view is `all`.
 */
export function drawTiers(g: G, r: RenderCtx): void {
  const { x, y, computed, ctx } = r;
  if (r.tierView !== 'all') {
    g.selectAll('*').remove();
    return;
  }
  const pts: SeriesPoint[] = [];
  for (const v of computed.labViews) if (r.visible(v.lab.id)) pts.push(...v.tiers);

  const sel = g.selectAll<SVGCircleElement, SeriesPoint>('circle.tier-point').data(pts, (d) => d.mi.release_id);
  sel.exit().remove();
  const merged = sel
    .enter()
    .append('circle')
    .attr('r', 2.5)
    .attr('tabindex', 0)
    .attr('role', 'button')
    .merge(sel);

  const colorOf = (d: SeriesPoint): string => ctx.labs.get(d.release.lab)?.color ?? INK;
  merged
    .attr('class', (d) => `tier-point${d.mi.release_id === r.selected ? ' is-selected' : ''}`)
    .attr('data-id', (d) => d.mi.release_id)
    .attr('data-lab', (d) => d.release.lab)
    .attr('cx', (d) => x(toDate(d.release.date)))
    .attr('cy', (d) => y(d.mi.index))
    .attr('fill', '#fff')
    .attr('stroke', (d) => colorOf(d))
    .attr('stroke-width', 1.25)
    .attr('aria-label', (d) =>
      `${d.release.name}, ${ctx.labs.get(d.release.lab)?.name ?? d.release.lab}, ${(d.release.tier ?? 'flagship')} tier, released ${fmtDate(d.release.date)}, rating ${Math.round(d.mi.rating)}, index ${fmtIndex(d.mi.index)}. Activate for sources.`,
    )
    .on('pointerenter', function (ev: PointerEvent, d) {
      r.io.tip(releaseTooltip(ctx, d), ev);
    })
    .on('pointermove', (ev: PointerEvent) => r.io.tipMove(ev))
    .on('pointerleave', () => r.io.tipHide())
    .on('focus', function (this: SVGCircleElement, _ev: FocusEvent, d) {
      const box = this.getBoundingClientRect();
      r.io.tip(releaseTooltip(ctx, d), { clientX: box.left + box.width / 2, clientY: box.top });
    })
    .on('blur', () => r.io.tipHide())
    .on('click', (_ev: PointerEvent, d) => r.io.openAudit(d.mi.release_id))
    .on('keydown', (ev: KeyboardEvent, d) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        r.io.openAudit(d.mi.release_id);
      }
    });
}
