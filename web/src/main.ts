/**
 * AGI Frontier — entry point.
 *
 * Load one JSON bundle, compute everything with `@agi/shared`, render the chart and the panels,
 * and keep them in sync with the time scrubber and the control bar. The store has two channels
 * that matter here: `asOf` (recompute the world) and `view` (the same world, drawn differently)
 * — both end in `renderAll`, which is cheap because `compute` memoises per (asOf, forecast).
 */
import '@fontsource-variable/jost';
import './styles/base.css';
import './styles/layout.css';
import './styles/chart.css';
import './styles/ui.css';
import './styles/controls.css';
import './styles/panels.css';

import { easeCubicInOut } from 'd3-ease';
import { addDays, daysBetween } from '@agi/shared';
import type { ISODate } from '@agi/shared';

import { createChart, minScrub } from './chart';
import { Tooltip } from './chart/tooltip';
import { buildLegend } from './chart/interaction';
import type { Interactions } from './chart/types';
import { compute, loadBundle, makeCtx, type Computed, type Ctx } from './data';
import { announce, maybe, prefersReducedMotion, qs, qsa } from './dom';
import { Store } from './state';
import { renderBacktest } from './ui/backtest';
import { renderChanges } from './ui/changes';
import { createControlBar } from './ui/controls';
import { Drawer } from './ui/drawer';
import { fmtDate } from './ui/format';
import { renderNotice, renderStamp, renderStats, renderWorkerHealth } from './ui/intro';
import { renderLifetimes } from './ui/lifetimes';
import { initParallax } from './ui/parallax';
import { readView, writeView } from './ui/persist';
import { initProgress } from './ui/progress';
import { initRankingsFilter, renderRankings } from './ui/rankings';
import { renderResearcher } from './ui/researcher';
import { attachShortcuts, createShortcutSheet } from './ui/shortcuts';
import { renderStages } from './ui/stages';
import { createTour, maybeAutoStart } from './ui/tour';
import { renderWatch } from './ui/watch';

const status = maybe('[data-chart-status]');

function fail(message: string): void {
  if (status) {
    status.hidden = false;
    status.textContent = message;
    status.style.textTransform = 'none';
    status.style.letterSpacing = '0.02em';
    status.style.padding = '0 24px';
    status.style.textAlign = 'center';
  }
  // eslint-disable-next-line no-console
  console.error(`[AGI Frontier] ${message}`);
}

async function boot(): Promise<void> {
  let ctx: Ctx;
  try {
    ctx = makeCtx(await loadBundle());
  } catch (err) {
    fail(`Could not load /latest.json — ${(err as Error).message}`);
    return;
  }

  const view = readView();
  const store = new Store({
    asOf: ctx.today,
    today: ctx.today,
    minDate: minScrub(ctx),
    yMode: view.yMode,
    range: view.range,
    forecast: view.forecast,
    bands: view.bands,
    tierView: view.tierView,
  });
  const tooltip = new Tooltip();
  const drawer = new Drawer(ctx, store);

  /**
   * Hovering a rung of the chart's ladder — or a row of the Stages column — marks the matching
   * row on the other side. Neither side owns the state, so it lives here as one class toggle.
   */
  let hoveredLevel: string | null = null;
  const hoverLevel = (id: string | null): void => {
    if (hoveredLevel === id) return;
    hoveredLevel = id;
    for (const node of qsa<HTMLElement>('[data-level-id]')) {
      node.classList.toggle('is-level-hover', id !== null && node.dataset.levelId === id);
    }
  };

  const io: Interactions = {
    tip: (html, at) => tooltip.show(html, at.clientX, at.clientY),
    tipMove: (at) => tooltip.move(at.clientX, at.clientY),
    tipHide: () => tooltip.hide(),
    hoverRelease: (id) => store.setHover(id),
    hoverLab: (id) => store.setHoverLab(id),
    openAudit: (id) => store.select(id),
    hoverLevel,
  };

  const canvas = qs('[data-chart-canvas]');
  const chart = createChart(canvas, ctx, store, io);

  renderStamp(ctx);
  renderWorkerHealth(ctx);
  renderChanges(ctx);
  renderResearcher(ctx);
  buildLegend(ctx, store);
  initRankingsFilter(store);
  initProgress(ctx);

  /* ----------------------------------------------------------- scrubber UI */
  const scrub = qs<HTMLInputElement>('#scrub');
  const scrubOut = qs('[data-scrub-value]');
  const span = Math.max(1, daysBetween(store.get().minDate, ctx.today));
  scrub.min = '0';
  scrub.max = String(span);
  scrub.value = String(span);
  scrub.addEventListener('input', () => {
    stopTween();
    store.setAsOf(addDays(store.get().minDate, Number(scrub.value)));
  });

  /* ------------------------------------------------- asOf tween (smooth UX) */
  let tween = 0;
  const stopTween = (): void => {
    if (tween) cancelAnimationFrame(tween);
    tween = 0;
  };
  function tweenAsOf(from: ISODate, to: ISODate): void {
    stopTween();
    if (prefersReducedMotion()) {
      store.setAsOf(to);
      return;
    }
    const total = daysBetween(from, to);
    const t0 = performance.now();
    const step = (): void => {
      const k = Math.min(1, (performance.now() - t0) / 480);
      store.setAsOf(addDays(from, Math.round(total * easeCubicInOut(k))));
      tween = k < 1 ? requestAnimationFrame(step) : 0;
    };
    tween = requestAnimationFrame(step);
  }

  /* ------------------------------------------------------ controls + keys */
  const sheet = createShortcutSheet();
  const controls = createControlBar({
    ctx,
    store,
    fit: () => {
      store.setFitY(true);
      chart.fitView();
    },
    reset: () => {
      store.setFitY(false);
      chart.resetZoom();
    },
    // +/− zoom both axes (REDESIGN §12.1); the chart decides the centre.
    zoom: (k) => chart.zoomBy(k, k),
    backToToday: () => tweenAsOf(store.get().asOf, ctx.today),
    help: () => sheet.open(),
  });

  attachShortcuts({
    store,
    sheet,
    fit: () => {
      store.setFitY(true);
      chart.fitView();
    },
    reset: () => {
      store.setFitY(false);
      chart.resetZoom();
    },
    zoom: (k) => chart.zoomBy(k, k),
  });

  /* ---------------------------------------------------------------- tour */
  const tour = createTour();
  maybe<HTMLButtonElement>('[data-tour-open]')?.addEventListener('click', () => tour.start());

  /* --------------------------------------------------------------- render */
  let last: Computed | null = null;

  function renderAll(): void {
    const st = store.get();
    const c = compute(ctx, st.asOf, { forecast: st.forecast });
    last = c;

    if (status) status.hidden = true;
    chart.render(c);
    renderStats(ctx, c);
    renderNotice(ctx, c);
    renderStages(ctx, c, { onSelect: (id) => store.select(id), hoverLevel });
    renderBacktest(ctx, c);
    renderWatch(ctx, c, (id) => store.select(id));
    renderRankings(ctx, c, store, (id) => store.select(id));
    renderLifetimes(ctx, c);
    drawer.sync(c);
    controls.sync();

    const scrubbed = st.asOf !== ctx.today;
    scrubOut.textContent = scrubbed ? fmtDate(st.asOf) : 'today';
    scrub.value = String(daysBetween(st.minDate, st.asOf));
    scrub.setAttribute('aria-valuetext', scrubbed ? fmtDate(st.asOf) : `today, ${fmtDate(st.asOf)}`);
    document.documentElement.dataset.scrubbed = String(scrubbed);
  }

  store.subscribe((channels) => {
    if (channels.has('view')) {
      const st = store.get();
      writeView({
        yMode: st.yMode,
        range: st.range,
        forecast: st.forecast,
        bands: st.bands,
        tierView: st.tierView,
      });
    }
    if (channels.has('asOf') || channels.has('view')) renderAll();
    else if (channels.has('selection') && last) drawer.sync(last);
  });

  renderAll();
  announce('The frontier is loaded. Press question mark for keyboard shortcuts.');

  /* -------------------------------------------------------------- parallax */
  initParallax(chart.layers, canvas);

  // The tour points at circles and rungs the chart has to have drawn first.
  maybeAutoStart(tour);
}

void boot();
