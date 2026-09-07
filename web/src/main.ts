/**
 * AGI Frontier — entry point.
 *
 * Load one JSON bundle, compute everything with `@agi/shared`, render the chart and the panels,
 * and keep them in sync with the time scrubber.
 */
import '@fontsource-variable/jost';
import './styles/base.css';
import './styles/layout.css';
import './styles/chart.css';
import './styles/ui.css';

import { easeCubicInOut } from 'd3-ease';
import { addDays, daysBetween } from '@agi/shared';
import type { ISODate } from '@agi/shared';

import { createChart, minScrub } from './chart';
import { Tooltip } from './chart/tooltip';
import { buildLegend } from './chart/interaction';
import type { Interactions } from './chart/types';
import { compute, loadBundle, makeCtx, type Computed, type Ctx } from './data';
import { announce, maybe, prefersReducedMotion, qs } from './dom';
import { Store } from './state';
import { renderChanges } from './ui/changes';
import { Drawer } from './ui/drawer';
import { fmtDate } from './ui/format';
import { renderNotice, renderStamp, renderStats, renderWorkerHealth } from './ui/intro';
import { initParallax } from './ui/parallax';
import { renderRankings } from './ui/rankings';
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

  const store = new Store({ asOf: ctx.today, today: ctx.today, minDate: minScrub(ctx) });
  const tooltip = new Tooltip();
  const drawer = new Drawer(ctx, store);

  const io: Interactions = {
    tip: (html, at) => tooltip.show(html, at.clientX, at.clientY),
    tipMove: (at) => tooltip.move(at.clientX, at.clientY),
    tipHide: () => tooltip.hide(),
    hoverRelease: (id) => store.setHover(id),
    openAudit: (id) => store.select(id),
  };

  const canvas = qs('[data-chart-canvas]');
  const chart = createChart(canvas, ctx, store, io);

  renderStamp(ctx);
  renderWorkerHealth(ctx);
  renderChanges(ctx);
  buildLegend(ctx, store);

  /* ----------------------------------------------------------- scrubber UI */
  const scrub = qs<HTMLInputElement>('#scrub');
  const scrubOut = qs('[data-scrub-value]');
  const todayBtn = qs<HTMLButtonElement>('[data-today]');
  const span = Math.max(1, daysBetween(store.get().minDate, ctx.today));
  scrub.min = '0';
  scrub.max = String(span);
  scrub.value = String(span);
  scrub.addEventListener('input', () => {
    stopTween();
    store.setAsOf(addDays(store.get().minDate, Number(scrub.value)));
  });

  /* ------------------------------------------------------------- controls */
  const fitBtn = qs<HTMLButtonElement>('[data-fit]');
  fitBtn.addEventListener('click', () => {
    const on = fitBtn.getAttribute('aria-pressed') !== 'true';
    fitBtn.setAttribute('aria-pressed', String(on));
    store.setFitY(on);
    announce(on ? 'Y axis fitted to the visible data' : 'Y axis reset to 0 to 100');
  });
  qs<HTMLButtonElement>('[data-reset-zoom]').addEventListener('click', () => {
    chart.resetZoom();
    announce('Zoom reset');
  });
  todayBtn.addEventListener('click', () => tweenAsOf(store.get().asOf, ctx.today));

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

  /* --------------------------------------------------------------- render */
  let last: Computed | null = null;

  function renderAll(): void {
    const asOf = store.get().asOf;
    const c = compute(ctx, asOf);
    last = c;

    if (status) status.hidden = true;
    chart.render(c);
    renderStats(ctx, c);
    renderNotice(ctx, c);
    renderWatch(ctx, c, (id) => store.select(id));
    renderRankings(ctx, c, (id) => store.select(id));
    drawer.sync(c);

    const scrubbed = asOf !== ctx.today;
    todayBtn.hidden = !scrubbed;
    scrubOut.textContent = scrubbed ? fmtDate(asOf) : 'today';
    scrub.value = String(daysBetween(store.get().minDate, asOf));
    scrub.setAttribute('aria-valuetext', scrubbed ? fmtDate(asOf) : `today, ${fmtDate(asOf)}`);
    document.documentElement.dataset.scrubbed = String(scrubbed);
  }

  store.subscribe((channels) => {
    if (channels.has('asOf')) renderAll();
    else if (channels.has('selection') && last) drawer.sync(last);
  });

  renderAll();

  /* -------------------------------------------------------------- parallax */
  initParallax(chart.layers, canvas);
}

void boot();
