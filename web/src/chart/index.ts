/**
 * The chart shell (REDESIGN §12.1): owns the plot <svg>, the time-axis strip <svg> under it, the
 * legend dock, the layer stack and the redraw loop. Layers are separate <g> elements in a fixed
 * z-order so `ui/parallax` can offset them; the stripe and pace groups live in the strip SVG.
 *
 * The view is a `View2D` — independent x/y zoom plus a translation over the resting scales —
 * driven by `interaction.ts` (drag, pinch, modifier + wheel) and by `ChartApi.zoomBy(kx, ky)`.
 * The resting y-domain (`yDomain`, theta) is what "fit" and "reset" tween; the view sits on top.
 */
import { easeCubicOut } from 'd3-ease';
import { scaleLinear } from 'd3-scale';
import { select } from 'd3-selection';
import { frontierFan as frontierFanOf, thetaFromRating } from '@agi/shared';
import type { FanPoint, ISODate, LabId } from '@agi/shared';
import type { Computed, Ctx, LabView } from '../data';
import { CHART_START_RECENT, compute, thetaExtent } from '../data';
import type { Store } from '../state';
import { maybe, prefersReducedMotion, svg as mk } from '../dom';
import { drawTimeAxis } from './axis';
import { drawBands } from './bands';
import { drawBacktest } from './backtest';
import { drawCrossings, drawFrontierFan } from './crossings';
import { drawFans, drawPredictions, spotlightLabs } from './forecast';
import { applyFocus, createHoverController, type FamilyGeometry } from './hover';
import { attachKeyboardNav, attachScrub, attachView, createHint } from './interaction';
import { drawLadder } from './ladder';
import { buildLegendDock, createLayerState, type LayerState } from './legend';
import { drawPace } from './pace';
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
import {
  fromDate,
  geometry,
  makeX,
  makeY,
  niceThetaExtent,
  toDate,
  valueTicks,
  viewThetaDomain,
  viewX,
  clampK,
  type Geom,
  type View2D,
  type XScale,
  type YScale,
} from './scales';
import type { Interactions, LayerToggle, LensShape, RenderCtx } from './types';

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

/** Layers whose groups live in the time-axis strip SVG rather than the plot. */
const STRIP_LAYERS: ReadonlySet<LayerName> = new Set<LayerName>(['stripes', 'pace']);

export interface ChartApi {
  render(computed: Computed): void;
  /** Restore the resting domains on both axes. */
  resetZoom(): void;
  /** Fit both axes to the visible data, fans and lenses - the "Fit" button. */
  fitView(): void;
  /** Programmatic zoom: kx multiplies the x zoom, ky the y — independently (REDESIGN §12.1). */
  zoomBy(kx: number, ky: number): void;
  layers: Record<LayerName, SVGGElement>;
  destroy(): void;
  /** v3 additions — optional layers toggled by the legend dock (`LayerToggle`). */
  setLayerVisible(layer: LayerToggle, on: boolean): void;
  layerVisible(layer: LayerToggle): boolean;
  /** The current 2-D view (identity = resting). Exposed for tests and shortcuts. */
  view(): View2D;
  /** The family currently in focus (pin, smart hover, legend hover, hovered release, solo). */
  focusLab(): LabId | null;
}

export function createChart(host: HTMLElement, ctx: Ctx, store: Store, io: Interactions): ChartApi {
  const reduced = prefersReducedMotion();
  // `role="group"`, not `role="img"`: both SVGs hold keyboard-focusable children (release points,
  // markers, lenses, release ticks). Under `img` those children are presentational, so a focused
  // point would be announced with the whole chart's label instead of its own.
  const svgEl = mk('svg', {
    class: 'chart-svg',
    role: 'group',
    'aria-label': 'Frontier Rating over time - flagship model capability by lab, with forecasts',
  });
  host.append(svgEl);
  const hint = createHint(host);

  // The time-axis strip: a sibling container after the canvas (index.html ships it; created when
  // an older page lacks it), holding the second SVG that shares the x scale and the view.
  let stripHost = host.parentElement?.querySelector<HTMLElement>('[data-chart-axis]') ?? maybe('[data-chart-axis]');
  if (!stripHost) {
    stripHost = document.createElement('div');
    stripHost.className = 'chart-axis';
    stripHost.setAttribute('data-chart-axis', '');
    host.after(stripHost);
  }
  const stripEl = mk('svg', {
    class: 'chart-axis-svg',
    role: 'group',
    'aria-label': 'Time axis, frontier leadership and the pace strip',
  });
  stripHost.append(stripEl);

  // Forecast fans and lenses are wide by nature; they must never paint outside the plot.
  const uid = Math.random().toString(36).slice(2, 8);
  const clipId = `agi-plot-${uid}`;
  const stripClipId = `agi-strip-${uid}`;
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

  const stripClipRect = mk('rect');
  const stripDefs = mk('defs');
  const stripClip = mk('clipPath', { id: stripClipId });
  stripClip.append(stripClipRect);
  stripDefs.append(stripClip);
  stripEl.append(stripDefs);
  const axisG = mk('g', { class: 'layer layer-axis' });
  stripEl.append(axisG);

  const groups = {} as Record<LayerName, SVGGElement>;
  for (const name of LAYER_ORDER) {
    const g = mk('g', { class: `layer layer-${name}` });
    if (STRIP_LAYERS.has(name)) {
      if (name === 'stripes') g.setAttribute('clip-path', `url(#${stripClipId})`);
      stripEl.append(g);
    } else {
      // Wide fills and the data marks get clipped to the plot; text and rules may live in the
      // gutters. With an unbounded rating axis a panned line would otherwise run over the caption.
      const clipped =
        name === 'bands' ||
        name === 'frontierFan' ||
        name === 'fans' ||
        name === 'lines' ||
        name === 'points' ||
        name === 'tiers' ||
        name === 'markers' ||
        name === 'crossings' ||
        name === 'backtest';
      if (clipped) g.setAttribute('clip-path', `url(#${clipId})`);
      svgEl.append(g);
    }
    groups[name] = g;
  }
  const sel = (name: LayerName): G => select(groups[name]) as unknown as G;
  const axisSel = (): G => select(axisG) as unknown as G;

  const layers: LayerState = createLayerState(store);

  let geom: Geom = geometry(host.clientWidth || 960, host.clientHeight || 600, { pace: layers.on('pace') });
  let computed: Computed | null = null;
  /** The resting y domain in theta - the axis' native units, unbounded above. */
  let yDomain: [number, number] = [-1, 4];
  let yTween: { from: [number, number]; to: [number, number]; t0: number } | null = null;
  let frame = 0;
  let drawn = false;
  let scrubDetach: (() => void) | null = null;
  /** Pixel geometry of every visible family after the last draw — the smart hover reads it. */
  let families: FamilyGeometry[] = [];
  let lastFocus: LabId | null | undefined;

  const baseDomain = (): [Date, Date] => [
    toDate(store.get().range === 'recent' ? CHART_START_RECENT : ctx.chartStart),
    toDate(ctx.chartEnd),
  ];

  /** Where rating 0 sits in the resting y scale — the floor the view may never lift above the plot. */
  const floorPx = (): number => scaleLinear().domain(yDomain).range([geom.y0, geom.y1]).clamp(false)(thetaFromRating(0));

  const view = attachView(svgEl, {
    getGeom: () => geom,
    floorPx,
    onChange: () => schedule(),
    onClick: (px, py) => hover.click(px, py),
    onPlainWheel: () => hint.show(),
  });

  /** The x scale seen through the view. */
  const currentX = (): XScale => viewX(makeX(baseDomain(), geom), view.view());
  /** The y scale seen through the view. */
  const currentY = (): YScale => makeY(viewThetaDomain(yDomain, geom, view.view()), geom, store.get().yMode);

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

  /** The lab views the legend is actually showing (every lab when all are hidden). */
  function shownViews(): LabView[] {
    if (!computed) return [];
    const shown = computed.labViews.filter((v) => store.visible(v.lab.id));
    return shown.length ? shown : computed.labViews;
  }

  function targetYDomain(): [number, number] {
    if (!store.get().fitY || !computed) return defaultYDomain();
    // Fit what the legend is actually showing, not every lab in the dataset.
    return niceThetaExtent(
      thetaExtent(shownViews(), {
        fanMode: store.get().forecast === 'long' ? 'long' : 'near',
        withTiers: store.get().tierView === 'all',
      }),
    );
  }

  /**
   * The date window the visible data occupies: first point to the end of the fans and the
   * lenses' 95th percentile (REDESIGN §12.1: fit fits both axes).
   */
  function targetXDomain(): [Date, Date] | null {
    const views = shownViews();
    let lo: ISODate | null = null;
    let hi: ISODate | null = null;
    const take = (d: ISODate): void => {
      if (lo === null || d < lo) lo = d;
      if (hi === null || d > hi) hi = d;
    };
    for (const v of views) {
      for (const p of v.points) take(p.release.date);
      const fan = store.get().forecast === 'long' ? v.fan : v.fanNear;
      const last = fan[fan.length - 1];
      if (last) take(last.date);
      for (const pred of v.predictions) {
        if (pred.k > 1 && store.get().forecast === 'next') continue;
        take(pred.p95Date);
      }
    }
    if (lo === null || hi === null || hi <= lo) return null;
    const a = toDate(lo).getTime();
    const b = toDate(hi).getTime();
    const pad = (b - a) * 0.04;
    return [new Date(a - pad), new Date(b + pad)];
  }

  /** Tween in theta: the axis' own units, so both labellings animate identically. */
  function lerpDomain(from: [number, number], to: [number, number], e: number): [number, number] {
    return [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e];
  }

  /**
   * The lab the reader is looking at: pin, smart/legend hover, hovered/selected release, solo.
   *
   * A lab that is switched off in the legend never holds the focus. Otherwise pinning a family
   * and then hiding it (or resting the pointer on a hidden lab's chip) would dim every *visible*
   * family with nothing left in focus — the chart reads as "all faded" for no visible reason.
   */
  function focusLab(): LabId | null {
    const st = store.get();
    if (st.pinnedLab && store.visible(st.pinnedLab)) return st.pinnedLab;
    if (st.hoverLab && store.visible(st.hoverLab)) return st.hoverLab;
    const of = (id: string | null): LabId | null => (id ? (ctx.releasesById.get(id)?.lab ?? null) : null);
    const rel = of(st.hover) ?? of(st.selected);
    if (rel && store.visible(rel)) return rel;
    return st.solo;
  }

  const hover = createHoverController({
    geometry: () => families,
    current: () => focusLab(),
    pinned: () => store.get().pinnedLab,
    setFocus: (lab) => store.setHoverLab(lab),
    pin: (lab) => {
      store.pinLab(lab);
      // A fresh pin also becomes the hover focus, so releasing the pointer keeps the family lit.
      if (lab && store.get().pinnedLab === lab) store.setHoverLab(lab);
    },
  });

  const onPointerMove = (ev: PointerEvent): void => {
    if (ev.pointerType !== 'mouse' && ev.pointerType !== 'pen') return;
    const rect = svgEl.getBoundingClientRect();
    hover.move(ev.clientX - rect.left, ev.clientY - rect.top);
  };
  const onPointerLeave = (): void => hover.leave();
  /**
   * Esc unpins the family (REDESIGN §12.2 "click again or Esc unpins").
   *
   * Contract with `ui/shortcuts.ts`, which binds Esc on the document too: this handler is
   * registered first, so it sees the key first. **When it actually unpins it consumes the
   * event** — `preventDefault()` plus `stopPropagation()` — and `shortcuts.ts` returns early on
   * `ev.defaultPrevented`, so its "no pin left, reset the zoom" branch cannot run on the same
   * keystroke. When nothing is pinned this handler leaves the event completely untouched and
   * shortcuts.ts resets the zoom as it should. One Esc = one step, either way.
   *
   * A native `<dialog>` (the shortcut sheet) owns Escape ahead of us: cancelling it with
   * `preventDefault()` would trap the reader inside, so the pin waits for the next press.
   */
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.defaultPrevented || ev.key !== 'Escape' || !store.get().pinnedLab) return;
    if (document.querySelector('dialog[open]')) return;
    // Esc drops the pin *and* the hover focus the pin carried, so the family goes quiet at once;
    // the next pointer move decides afresh.
    store.setPinLab(null);
    store.setHoverLab(null);
    ev.preventDefault();
    ev.stopPropagation();
  };
  svgEl.addEventListener('pointermove', onPointerMove);
  svgEl.addEventListener('pointerleave', onPointerLeave);
  document.addEventListener('keydown', onKeyDown);

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

  /** Pixel geometry of the visible families for the smart hover (REDESIGN §12.2). */
  function familyGeometry(r: RenderCtx, lenses: LensShape[]): FamilyGeometry[] {
    const out: FamilyGeometry[] = [];
    for (const v of r.computed.labViews) {
      if (!r.visible(v.lab.id)) continue;
      const polyline: [number, number][] = v.qualified.map((p) => [r.x(toDate(p.release.date)), r.y(p.mi.index)]);
      const points: [number, number][] = v.points.map((p) => [r.x(toDate(p.release.date)), r.y(p.mi.index)]);
      if (r.tierView === 'all') for (const p of v.tiers) points.push([r.x(toDate(p.release.date)), r.y(p.mi.index)]);
      const own = lenses.filter((l) => l.lab === v.lab.id);
      if (polyline.length === 0 && points.length === 0 && own.length === 0) continue;
      out.push({ lab: v.lab.id, polyline, points, lenses: own });
    }
    return out;
  }

  function draw(): void {
    if (!computed) return;
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w < 2 || h < 2) return;
    drawn = true;
    geom = geometry(w, h, { pace: layers.on('pace') });
    svgEl.setAttribute('width', String(w));
    svgEl.setAttribute('height', String(h));
    svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
    stripEl.setAttribute('width', String(w));
    stripEl.setAttribute('height', String(geom.stripH));
    stripEl.setAttribute('viewBox', `0 0 ${w} ${geom.stripH}`);

    // y-domain tween ("fit to data")
    if (yTween) {
      const k = reduced ? 1 : Math.min(1, (performance.now() - yTween.t0) / 420);
      const e = easeCubicOut(k);
      yDomain = lerpDomain(yTween.from, yTween.to, e);
      if (k >= 1) yTween = null;
      else schedule();
    }

    clipRect.setAttribute('x', String(geom.x0 - 1));
    clipRect.setAttribute('y', String(geom.y1 - 8));
    clipRect.setAttribute('width', String(geom.iw + 2));
    clipRect.setAttribute('height', String(geom.ih + 8 + geom.m.bottom));
    stripClipRect.setAttribute('x', String(geom.x0 - 1));
    stripClipRect.setAttribute('y', '0');
    stripClipRect.setAttribute('width', String(geom.iw + 2));
    stripClipRect.setAttribute('height', String(geom.stripH));

    const x = currentX();
    const st = store.get();
    const y = currentY();
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
      pinnedLab: st.pinnedLab,
      spotlight: spotlightLabs(computed.labViews, (lab) => store.visible(lab), focus),
      visible: (lab) => store.visible(lab),
      layerOn: (layer) => layers.on(layer),
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
    drawBands(sel('bands'), r);
    drawFrontierFan(sel('frontierFan'), r, fanToEdge(computed, x.domain()[1] ?? toDate(ctx.chartEnd)));
    drawFans(sel('fans'), r);
    drawLines(sel('lines'), r);
    drawPoints(sel('points'), r);
    drawTiers(sel('tiers'), r);
    const lenses = drawPredictions(sel('markers'), r);
    drawMarkers(sel('markers'), r);
    // The lab end-labels are placed *before* the crossings so a crossing label can step out of
    // their way (they pile up against NOW, where the crossings are). Paint order is fixed by
    // LAYER_ORDER, not by the order these are called in.
    const endLabels = drawLabels(sel('labels'), r);
    drawCrossings(sel('crossings'), r, endLabels);
    drawBacktest(sel('backtest'), r);
    const overlay = drawOverlay(sel('overlay'), r);

    // the strip: axis rows, leadership stripe + ticks, pace
    drawTimeAxis(axisSel(), r);
    drawStripes(sel('stripes'), r);
    drawTicks(sel('stripes'), r);
    drawPace(sel('pace'), r, paceScale());

    families = familyGeometry(r, lenses);
    // Called after every draw so nodes a data join has just entered (crossings and lenses come
    // and go with the zoom) pick the state up — but `applyFocus` only walks the whole tree when
    // the focus itself changed, so panning and pinching cost nothing here.
    applyFocus(svgEl, focus);
    applyFocus(stripEl, focus);
    if (focus !== lastFocus) {
      lastFocus = focus;
      host.classList.toggle('has-focus', focus !== null);
      dock?.sync();
    }

    if (!scrubDetach && overlay.handle) {
      scrubDetach = attachScrub(overlay.handle, {
        store,
        x: currentX,
        min: minScrub(ctx),
        max: ctx.today,
      });
    }
  }

  // The legend dock (REDESIGN §12.1) — built here so the page needs no extra wiring; the host
  // is optional so a stripped-down page (paper, tests) still gets a chart.
  const dockHost = maybe('[data-legend-dock]');
  const dock = dockHost ? buildLegendDock(dockHost, { ctx, store, layers, focus: focusLab }) : null;
  const unsubLayers = layers.subscribe(() => schedule());

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
      // The base x-domain just changed under the view; keeping the old one would land the reader
      // somewhere arbitrary. Snap back to the new default window instead.
      lastRange = store.get().range;
      lastForecast = store.get().forecast;
      view.reset();
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
      view.reset();
      const to = targetYDomain();
      if (to[0] !== yDomain[0] || to[1] !== yDomain[1]) {
        yTween = { from: [...yDomain] as [number, number], to, t0: performance.now() };
      }
      schedule();
    },
    fitView(): void {
      // y: the resting domain tweens to the data; x: the view zooms the base scale onto the
      // occupied date window (both axes fit, REDESIGN §12.1).
      const to = targetYDomain();
      yTween = { from: [...yDomain] as [number, number], to, t0: performance.now() };
      const dom = targetXDomain();
      if (dom) {
        const base = makeX(baseDomain(), geom);
        const a = base(dom[0]);
        const b = base(dom[1]);
        const kx = clampK(geom.iw / Math.max(1, b - a));
        view.set({ kx, ky: 1, tx: geom.x0 - a * kx, ty: 0 });
      } else {
        view.reset();
      }
      schedule();
    },
    zoomBy(kx: number, ky: number): void {
      view.zoomBy(kx, ky);
      schedule();
    },
    layers: groups,
    setLayerVisible(layer, on): void {
      layers.set(layer, on);
    },
    layerVisible(layer): boolean {
      return layers.on(layer);
    },
    view: () => view.view(),
    focusLab,
    destroy(): void {
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('keydown', onKeyDown);
      svgEl.removeEventListener('pointermove', onPointerMove);
      svgEl.removeEventListener('pointerleave', onPointerLeave);
      detachKeys();
      scrubDetach?.();
      unsubscribe();
      unsubLayers();
      hover.destroy();
      view.destroy();
      hint.destroy();
      dock?.destroy();
      svgEl.remove();
      stripEl.remove();
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
