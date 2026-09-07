/**
 * The chart shell: owns the <svg>, its layer stack and the redraw loop.
 * Layers are separate <g> elements in a fixed z-order so `ui/parallax` can offset them.
 */
import { easeCubicOut } from 'd3-ease';
import { select } from 'd3-selection';
import { zoomTransform, ZoomTransform } from 'd3-zoom';
import { frontierFan as frontierFanOf } from '@agi/shared';
import type { FanPoint, ISODate, LabId } from '@agi/shared';
import type { Computed, Ctx } from '../data';
import { CHART_START_RECENT, compute, thetaExtent } from '../data';
import type { Store } from '../state';
import { prefersReducedMotion, svg as mk } from '../dom';
import { drawBands } from './bands';
import { drawBacktest } from './backtest';
import { drawCrossings, drawFrontierFan } from './crossings';
import { drawFans, drawPredictions, spotlightLabs } from './forecast';
import { drawLadder } from './ladder';
import { drawPace } from './pace';
import { attachKeyboardNav, attachScrub, attachZoom } from './interaction';
import {
  drawGrid,
  drawLabels,
  drawLines,
  drawMarkers,
  drawOverlay,
  drawPoints,
  drawStripes,
  drawTicks,
  drawTiers,
  type G,
} from './layers';
import { fromDate, geometry, makeX, makeY, niceThetaExtent, toDate, valueTicks, type Geom, type XScale, type YScale } from './scales';
import type { Interactions, RenderCtx } from './types';

const LAYER_ORDER = [
  'grid',
  'ladder',
  'stripes',
  'bands',
  'frontierFan',
  'fans',
  'lines',
  'points',
  'tiers',
  'markers',
  'crossings',
  'backtest',
  'labels',
  'pace',
  'overlay',
] as const;
export type LayerName = (typeof LAYER_ORDER)[number];

export interface ChartApi {
  render(computed: Computed): void;
  /** Restore the resting domains on both axes. */
  resetZoom(): void;
  /** Fit y (and x to the story range) to the visible data - the "Fit" button. */
  fitView(): void;
  /** Programmatic zoom for keyboard shortcuts: kx multiplies the x zoom, ky the y. */
  zoomBy(kx: number, ky: number): void;
  layers: Record<LayerName, SVGGElement>;
  destroy(): void;
}

export function createChart(host: HTMLElement, ctx: Ctx, store: Store, io: Interactions): ChartApi {
  const reduced = prefersReducedMotion();
  const svgEl = mk('svg', {
    class: 'chart-svg',
    role: 'img',
    'aria-label': 'Frontier Rating over time - flagship model capability by lab, with forecasts',
  });
  host.append(svgEl);

  // Forecast fans and window circles are wide by nature; they must never paint outside the plot.
  const uid = Math.random().toString(36).slice(2, 8);
  const clipId = `agi-plot-${uid}`;
  const glowId = `agi-glow-${uid}`;
  const clipRect = mk('rect');
  const defs = mk('defs');
  const clip = mk('clipPath', { id: clipId });
  clip.append(clipRect);
  defs.append(clip);

  // Soft halo behind the single most likely next release.
  const glow = mk('filter', {
    id: glowId,
    x: '-60%',
    y: '-60%',
    width: '220%',
    height: '220%',
    'color-interpolation-filters': 'sRGB',
  });
  glow.append(mk('feGaussianBlur', { stdDeviation: '3', in: 'SourceGraphic' }));
  defs.append(glow);
  svgEl.append(defs);

  const groups = {} as Record<LayerName, SVGGElement>;
  for (const name of LAYER_ORDER) {
    const g = mk('g', { class: `layer layer-${name}` });
    // Wide fills get clipped to the plot; text and rules may live in the gutters.
    const clipped = name === 'bands' || name === 'frontierFan' || name === 'fans' || name === 'tiers' || name === 'markers' || name === 'crossings' || name === 'backtest';
    if (clipped) g.setAttribute('clip-path', `url(#${clipId})`);
    svgEl.append(g);
    groups[name] = g;
  }
  const sel = (name: LayerName): G => select(groups[name]) as unknown as G;

  let geom: Geom = geometry(host.clientWidth || 960, host.clientHeight || 600);
  let computed: Computed | null = null;
  /** The y domain in theta - the axis' native units, unbounded above. */
  let yDomain: [number, number] = [-1, 4];
  let yTween: { from: [number, number]; to: [number, number]; t0: number } | null = null;
  let frame = 0;
  let drawn = false;
  let scrubDetach: (() => void) | null = null;

  const baseDomain = (): [Date, Date] => [
    toDate(store.get().range === 'recent' ? CHART_START_RECENT : ctx.chartStart),
    toDate(ctx.chartEnd),
  ];

  /**
   * The x scale with the 2-D zoom transform applied. Wheel zooms x (rescaleX), shift+wheel and
   * pinch drive the transform's y half, drag pans both.
   */
  const currentX = (): XScale => {
    const base = makeX(baseDomain(), geom);
    const t: ZoomTransform = zoomTransform(svgEl);
    return t.k === 1 && t.x === 0 ? base : (t.rescaleX(base) as XScale);
  };

  const zoomHandle = attachZoom(svgEl, () => geom, () => schedule());

  /**
   * The resting y-domain: the extent of *all* data as of today (not as of the scrubber, or the
   * axis would breathe while dragging), rounded to quarter-logits - plus the fan highs so the
   * future is visible without a click.
   */
  function defaultYDomain(): [number, number] {
    const all = compute(ctx, ctx.today, { forecast: store.get().forecast });
    // The resting domain fits the *lab* data and its near fans. The frontier trend fan keeps
    // opening with horizon (REDESIGN section 4), so folding it in here would squash the history
    // into a band; the axis is unbounded and the fan may leave the resting window.
    return niceThetaExtent(thetaExtent(all.labViews, { fanMode: store.get().forecast === 'long' ? 'long' : 'near' }));
  }

  function targetYDomain(): [number, number] {
    if (!store.get().fitY || !computed) return defaultYDomain();
    // Fit what the legend is actually showing, not every lab in the dataset.
    const shown = computed.labViews.filter((v) => store.visible(v.lab.id));
    const views = shown.length ? shown : computed.labViews;
    return niceThetaExtent(
      thetaExtent(views, {
        fanMode: store.get().forecast === 'long' ? 'long' : 'near',
        withTiers: store.get().tierView === 'all',
      }),
    );
  }

  /** Tween in theta: the axis' own units, so both labellings animate identically. */
  function lerpDomain(from: [number, number], to: [number, number], e: number): [number, number] {
    return [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e];
  }

  /** The lab the reader is looking at: legend hover, hovered/selected release, solo. */
  function focusLab(): LabId | null {
    const st = store.get();
    if (st.hoverLab) return st.hoverLab;
    const of = (id: string | null): LabId | null => (id ? (ctx.releasesById.get(id)?.lab ?? null) : null);
    return of(st.hover) ?? of(st.selected) ?? st.solo;
  }

  let paceMax = 0;
  function paceScale(): { maxGain: number } {
    if (!paceMax) {
      for (const gain of compute(ctx, ctx.today).gains) paceMax = Math.max(paceMax, gain.gain);
    }
    return { maxGain: paceMax };
  }

  function schedule(): void {
    if (frame) return;
    // Same rationale as the store: rAF is paused in a hidden tab, so fall back to a macrotask.
    const raf =
      typeof document !== 'undefined' && document.hidden
        ? (fn: () => void) => window.setTimeout(fn, 0)
        : (fn: () => void) => requestAnimationFrame(fn);
    frame = raf(() => {
      frame = 0;
      draw();
    });
  }

  /** Frontier trend fans are cheap (OLS over a 365 d window) but not free - memoise by edge. */
  const fanEdgeMemo = new Map<string, FanPoint[]>();

  /**
   * The frontier fan re-asked for the current x-domain right edge (REDESIGN section 4: no fixed
   * horizon). The resting fan ends at today + 3 y; zooming out past that recomputes the shared
   * `frontierFan` to the new edge so the band keeps opening honestly instead of running flat.
   */
  function fanToEdge(c: Computed, edge: Date): FanPoint[] {
    const want = fromDate(edge);
    if (want <= c.fanEnd || c.frontierFan.length === 0) return c.frontierFan;
    const key = `${c.asOf}|${want}`;
    const hit = fanEdgeMemo.get(key);
    if (hit) return hit;
    const fan = frontierFanOf(c.frontier, c.asOf, { toDate: want, stepDays: 7 });
    if (fanEdgeMemo.size > 60) fanEdgeMemo.delete(fanEdgeMemo.keys().next().value!);
    fanEdgeMemo.set(key, fan);
    return fan;
  }

  function draw(): void {
    if (!computed) return;
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w < 2 || h < 2) return;
    drawn = true;
    geom = geometry(w, h);
    svgEl.setAttribute('width', String(w));
    svgEl.setAttribute('height', String(h));
    svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`);

    // y-domain tween ("fit to data")
    if (yTween) {
      const k = reduced ? 1 : Math.min(1, (performance.now() - yTween.t0) / 420);
      const e = easeCubicOut(k);
      yDomain = lerpDomain(yTween.from, yTween.to, e);
      if (k >= 1) yTween = null;
      else schedule();
    }

    clipRect.setAttribute('x', String(geom.x0 - 1));
    clipRect.setAttribute('y', String(geom.y1 - 10));
    clipRect.setAttribute('width', String(geom.iw + 2));
    clipRect.setAttribute('height', String(geom.ih + 12));

    const x = currentX();
    const st = store.get();
    const y = makeY(yDomain, geom, st.yMode);
    const focus = focusLab();
    const r: RenderCtx = {
      ctx,
      computed,
      x,
      y,
      geom,
      asOf: st.asOf,
      today: st.today,
      hover: st.hover,
      selected: st.selected,
      focusLab: focus,
      spotlight: spotlightLabs(computed.labViews, (lab) => store.visible(lab), focus),
      visible: (lab) => store.visible(lab),
      reduced,
      forecast: st.forecast,
      bands: st.bands,
      tierView: st.tierView,
      glowId,
      io,
    };

    const yTicks = valueTicks(y, geom);

    drawGrid(sel('grid'), r);
    drawLadder(sel('ladder'), r, yTicks);
    drawStripes(sel('stripes'), r);
    drawTicks(sel('stripes'), r);
    drawBands(sel('bands'), r);
    drawFrontierFan(sel('frontierFan'), r, fanToEdge(computed, x.domain()[1] ?? toDate(ctx.chartEnd)));
    drawFans(sel('fans'), r);
    drawLines(sel('lines'), r);
    drawPoints(sel('points'), r);
    drawTiers(sel('tiers'), r);
    drawPredictions(sel('markers'), r);
    drawMarkers(sel('markers'), r);
    drawCrossings(sel('crossings'), r);
    drawBacktest(sel('backtest'), r);
    drawLabels(sel('labels'), r);
    drawPace(sel('pace'), r, paceScale());
    const overlay = drawOverlay(sel('overlay'), r);

    if (!scrubDetach && overlay.handle) {
      scrubDetach = attachScrub(overlay.handle, {
        store,
        x: currentX,
        min: minScrub(ctx),
        max: ctx.today,
      });
    }
  }

  const ro = new ResizeObserver(() => schedule());
  ro.observe(host);

  // requestAnimationFrame never fires in a background tab, so a page opened in one would show an
  // empty chart until it is focused. Redraw as soon as the document becomes visible.
  const onVisible = (): void => {
    if (!document.hidden) draw();
  };
  document.addEventListener('visibilitychange', onVisible);

  const detachKeys = attachKeyboardNav(groups.points);

  let lastRange = store.get().range;
  let lastForecast = store.get().forecast;
  const unsubscribe = store.subscribe((channels) => {
    if (channels.has('view') && (store.get().range !== lastRange || store.get().forecast !== lastForecast)) {
      // The base x-domain just changed under the zoom transform; keeping the old one would land
      // the reader somewhere arbitrary. Snap back to the new default window instead.
      lastRange = store.get().range;
      lastForecast = store.get().forecast;
      zoomHandle.reset();
    }
    if (channels.has('view') || channels.has('filters')) {
      const to = targetYDomain();
      if (to[0] !== yDomain[0] || to[1] !== yDomain[1]) {
        yTween = { from: [...yDomain] as [number, number], to, t0: performance.now() };
      }
    }
    if (channels.has('hover') || channels.has('selection') || channels.has('filters') || channels.has('view')) {
      schedule();
    }
  });

  return {
    render(next: Computed): void {
      computed = next;
      // First paint is synchronous so the chart is never blank in a background tab.
      if (!drawn) {
        yDomain = targetYDomain();
        draw();
        return;
      }
      if (store.get().fitY) {
        const to = targetYDomain();
        if (to[0] !== yDomain[0] || to[1] !== yDomain[1]) {
          yTween = { from: [...yDomain] as [number, number], to, t0: performance.now() };
        }
      }
      schedule();
    },
    resetZoom(): void {
      zoomHandle.reset();
      schedule();
    },
    fitView(): void {
      zoomHandle.reset();
      const to = targetYDomain();
      yTween = { from: [...yDomain] as [number, number], to, t0: performance.now() };
      schedule();
    },
    zoomBy(kx: number, ky: number): void {
      const t = zoomTransform(svgEl);
      const k = Math.max(1, Math.min(40, t.k * kx));
      select(svgEl).call(zoomHandle.behavior.transform as never, new ZoomTransform(k, t.x, t.y));
      void ky;
      schedule();
    },
    layers: groups,
    destroy(): void {
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisible);
      detachKeys();
      scrubDetach?.();
      unsubscribe();
      svgEl.remove();
    },
  };
}

/** The scrubber never goes further back than a month before the first release. */
export function minScrub(ctx: Ctx): ISODate {
  const first = ctx.firstDate;
  const d = new Date(`${first}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString().slice(0, 10);
}
