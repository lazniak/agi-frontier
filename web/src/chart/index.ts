/**
 * The chart shell: owns the <svg>, its layer stack and the redraw loop.
 * Layers are separate <g> elements in a fixed z-order so `ui/parallax` can offset them.
 */
import { easeCubicOut } from 'd3-ease';
import { interpolateNumber } from 'd3-interpolate';
import { select } from 'd3-selection';
import { zoomTransform, type ZoomTransform } from 'd3-zoom';
import type { ISODate } from '@agi/shared';
import type { Computed, Ctx } from '../data';
import { CHART_START, extentOfViews } from '../data';
import type { Store } from '../state';
import { prefersReducedMotion, svg as mk } from '../dom';
import { drawFans, drawPredictions } from './forecast';
import { attachKeyboardNav, attachScrub, attachZoom } from './interaction';
import {
  drawGrid,
  drawLabels,
  drawLines,
  drawMarkers,
  drawOverlay,
  drawPoints,
  drawStripes,
  type G,
} from './layers';
import { geometry, makeX, makeY, niceExtent, toDate, type Geom, type XScale } from './scales';
import type { Interactions, RenderCtx } from './types';

const LAYER_ORDER = ['grid', 'stripes', 'fans', 'lines', 'points', 'markers', 'labels', 'overlay'] as const;
export type LayerName = (typeof LAYER_ORDER)[number];

export interface ChartApi {
  render(computed: Computed): void;
  resetZoom(): void;
  layers: Record<LayerName, SVGGElement>;
  destroy(): void;
}

export function createChart(host: HTMLElement, ctx: Ctx, store: Store, io: Interactions): ChartApi {
  const reduced = prefersReducedMotion();
  const svgEl = mk('svg', { class: 'chart-svg', role: 'img', 'aria-label': 'Frontier Index over time' });
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

  // Soft halo behind the single most likely next release. A blur wide enough to read needs a
  // filter region well outside the shape's own box, or Chrome clips the halo to the circle.
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
    if (name === 'fans' || name === 'markers') g.setAttribute('clip-path', `url(#${clipId})`);
    svgEl.append(g);
    groups[name] = g;
  }
  const sel = (name: LayerName): G => select(groups[name]) as unknown as G;

  let geom: Geom = geometry(host.clientWidth || 960, host.clientHeight || 600);
  let computed: Computed | null = null;
  let yDomain: [number, number] = [0, 100];
  let yTween: { from: [number, number]; to: [number, number]; t0: number } | null = null;
  let frame = 0;
  let drawn = false;
  let scrubDetach: (() => void) | null = null;

  const baseDomain = (): [Date, Date] => [
    toDate(CHART_START),
    toDate(store.get().longRange ? ctx.chartEnd : ctx.chartEndNear),
  ];

  const currentX = (): XScale => {
    const base = makeX(baseDomain(), geom);
    const t: ZoomTransform = zoomTransform(svgEl);
    return t.k === 1 && t.x === 0 ? base : (t.rescaleX(base) as XScale);
  };

  const zoomHandle = attachZoom(svgEl, () => geom, () => schedule());

  function targetYDomain(): [number, number] {
    if (!store.get().fitY || !computed) return [0, 100];
    // Fit what the legend is actually showing, not every lab in the dataset.
    const shown = computed.labViews.filter((v) => store.visible(v.lab.id));
    return niceExtent(extentOfViews(shown.length ? shown : computed.labViews, store.get().longRange));
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
      yDomain = [
        interpolateNumber(yTween.from[0], yTween.to[0])(e),
        interpolateNumber(yTween.from[1], yTween.to[1])(e),
      ];
      if (k >= 1) yTween = null;
      else schedule();
    }

    clipRect.setAttribute('x', String(geom.x0 - 1));
    clipRect.setAttribute('y', String(geom.y1 - 10));
    clipRect.setAttribute('width', String(geom.iw + 2));
    clipRect.setAttribute('height', String(geom.ih + 12));

    const x = currentX();
    const y = makeY(yDomain, geom);
    const st = store.get();
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
      visible: (lab) => store.visible(lab),
      reduced,
      longRange: st.longRange,
      glowId,
      io,
    };

    drawGrid(sel('grid'), r);
    drawStripes(sel('stripes'), r);
    drawFans(sel('fans'), r);
    drawLines(sel('lines'), r);
    drawPoints(sel('points'), r);
    drawPredictions(sel('markers'), r);
    drawMarkers(sel('markers'), r);
    drawLabels(sel('labels'), r);
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

  let lastLongRange = store.get().longRange;
  const unsubscribe = store.subscribe((channels) => {
    if (channels.has('view') && store.get().longRange !== lastLongRange) {
      // The base x-domain just changed under the zoom transform; keeping the old one would land
      // the reader somewhere arbitrary. Snap back to the new default window instead.
      lastLongRange = store.get().longRange;
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
