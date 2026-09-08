/**
 * Pointer and wheel gestures on the chart (REDESIGN §12.1), the draggable "now" scrubber, the
 * keyboard traversal of the points and the (legacy) lab legend.
 *
 * The 2-D view is our own `View2D` instead of d3-zoom's transform, because the reader must be
 * able to zoom time and rating *independently* (Ctrl+wheel vs Shift+wheel) and d3-zoom carries a
 * single `k`. The gesture set is small enough to own: drag pans both axes, pinch zooms both,
 * modifier + wheel zooms about the pointer, and a plain wheel is left to the page.
 */
import type { ISODate, LabId } from '@agi/shared';
import type { Ctx } from '../data';
import type { Store } from '../state';
import { announce, el, maybe, qs, qsa } from '../dom';
import { fmtDate } from '../ui/format';
import { constrainView, fromDate, isIdentity, VIEW_IDENTITY, zoomAbout, type Geom, type View2D, type XScale } from './scales';

const DAY = 86_400_000;

/* -------------------------------------------------------------------- view */

export interface ViewHandle {
  /** The current view (identity = the resting scales). */
  view(): View2D;
  /** Replace the view; it is constrained (`constrainView`) before `onChange` fires. */
  set(v: View2D): void;
  /** Back to the resting view. */
  reset(): void;
  /** Multiply the zoom per axis about a pixel point (default: the plot centre). */
  zoomBy(fx: number, fy: number, at?: { x: number; y: number }): void;
  destroy(): void;
}

export interface ViewOptions {
  getGeom: () => Geom;
  /** Where rating 0 sits in the *base* y scale — the floor the view may never lift above the plot. */
  floorPx: () => number;
  onChange: (v: View2D) => void;
  /** A click on the plot that was not a drag and did not land on an interactive element. */
  onClick?: (px: number, py: number, ev: PointerEvent) => void;
  /** The first plain wheel over the canvas (the page scrolled) — show the hint once. */
  onPlainWheel?: () => void;
}

/** A press that moves less than this is a click, not a pan. */
const CLICK_SLOP = 3;
/** Wheel sensitivity: one notch of a mouse wheel (≈100 px) zooms by ×1.22. */
const WHEEL_GAIN = 0.002;

/** Elements whose own click must not double as a pin/unpin of a family. */
const INTERACTIVE = '.now-handle, [tabindex], button, a, [role="button"], [role="slider"]';

interface Press {
  id: number;
  x: number;
  y: number;
}

export function attachView(svgEl: SVGSVGElement, opts: ViewOptions): ViewHandle {
  let view: View2D = { ...VIEW_IDENTITY };
  const pointers = new Map<number, Press>();
  let start: { view: View2D; x: number; y: number } | null = null;
  let pinch: { view: View2D; dist: number; cx: number; cy: number } | null = null;
  let dragging = false;

  const local = (ev: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = svgEl.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  };

  const commit = (v: View2D): void => {
    view = constrainView(v, opts.getGeom(), opts.floorPx());
    opts.onChange(view);
  };

  /* wheel — plain scrolls the page; modifiers zoom (REDESIGN §12.1) */
  const onWheel = (ev: WheelEvent): void => {
    const ctrl = ev.ctrlKey || ev.metaKey;
    if (!ctrl && !ev.shiftKey) {
      opts.onPlainWheel?.();
      return; // the page scrolls
    }
    ev.preventDefault();
    // Shift+wheel arrives as deltaX on some platforms; lines → pixels for the odd trackpad.
    let d = ev.deltaY !== 0 ? ev.deltaY : ev.deltaX;
    if (ev.deltaMode === 1) d *= 16;
    else if (ev.deltaMode === 2) d *= 120;
    const f = Math.exp(-d * WHEEL_GAIN);
    const p = local(ev);
    const fx = ctrl ? f : 1;
    const fy = ev.shiftKey ? f : 1;
    commit(zoomAbout(view, fx, fy, p.x, p.y));
  };

  /* pointers — drag pans, two fingers pinch */
  const onDown = (ev: PointerEvent): void => {
    const target = ev.target as Element | null;
    if (target && typeof target.closest === 'function' && target.closest('.now-handle')) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    const p = local(ev);
    pointers.set(ev.pointerId, { id: ev.pointerId, x: p.x, y: p.y });
    if (pointers.size === 1) {
      start = { view: { ...view }, x: p.x, y: p.y };
      dragging = false;
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = {
        view: { ...view },
        dist: Math.max(1, Math.hypot(b!.x - a!.x, b!.y - a!.y)),
        cx: (a!.x + b!.x) / 2,
        cy: (a!.y + b!.y) / 2,
      };
      dragging = true;
      svgEl.parentElement?.classList.add('is-panning');
    }
  };

  const onMove = (ev: PointerEvent): void => {
    const press = pointers.get(ev.pointerId);
    if (!press) return;
    const p = local(ev);
    press.x = p.x;
    press.y = p.y;
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.max(1, Math.hypot(b!.x - a!.x, b!.y - a!.y));
      const cx = (a!.x + b!.x) / 2;
      const cy = (a!.y + b!.y) / 2;
      const f = dist / pinch.dist;
      const zoomed = zoomAbout(pinch.view, f, f, pinch.cx, pinch.cy);
      commit({ ...zoomed, tx: zoomed.tx + (cx - pinch.cx), ty: zoomed.ty + (cy - pinch.cy) });
      return;
    }
    if (!start || pointers.size !== 1) return;
    const dx = p.x - start.x;
    const dy = p.y - start.y;
    if (!dragging) {
      if (Math.hypot(dx, dy) < CLICK_SLOP) return;
      dragging = true;
      try {
        svgEl.setPointerCapture(ev.pointerId);
      } catch {
        /* capture is best-effort */
      }
      svgEl.parentElement?.classList.add('is-panning');
    }
    ev.preventDefault();
    commit({ ...start.view, tx: start.view.tx + dx, ty: start.view.ty + dy });
  };

  const onUp = (ev: PointerEvent): void => {
    const press = pointers.get(ev.pointerId);
    if (!press) return;
    pointers.delete(ev.pointerId);
    try {
      svgEl.releasePointerCapture(ev.pointerId);
    } catch {
      /* not captured */
    }
    if (pointers.size === 0) {
      const wasClick = !dragging && ev.type === 'pointerup';
      svgEl.parentElement?.classList.remove('is-panning');
      if (wasClick && opts.onClick) {
        const target = ev.target as Element | null;
        const interactive = target && typeof target.closest === 'function' && target.closest(INTERACTIVE);
        if (!interactive) opts.onClick(press.x, press.y, ev);
      }
      start = null;
      pinch = null;
      dragging = false;
    } else if (pointers.size === 1) {
      // One finger lifted from a pinch: continue as a plain pan from here.
      const rest = [...pointers.values()][0]!;
      pinch = null;
      start = { view: { ...view }, x: rest.x, y: rest.y };
    }
  };

  svgEl.addEventListener('wheel', onWheel, { passive: false });
  svgEl.addEventListener('pointerdown', onDown);
  svgEl.addEventListener('pointermove', onMove);
  svgEl.addEventListener('pointerup', onUp);
  svgEl.addEventListener('pointercancel', onUp);
  // `pan-y` (also in chart.css): a one-finger vertical swipe scrolls the page, while horizontal
  // drags and two-finger pinches — gestures the browser is not allowed to claim — reach us.
  svgEl.style.touchAction = svgEl.style.touchAction || 'pan-y';

  return {
    view: () => view,
    set: commit,
    reset: () => {
      if (isIdentity(view)) {
        opts.onChange(view);
        return;
      }
      commit({ ...VIEW_IDENTITY });
    },
    zoomBy: (fx, fy, at) => {
      const g = opts.getGeom();
      const p = at ?? { x: g.x0 + g.iw / 2, y: g.y1 + g.ih / 2 };
      commit(zoomAbout(view, fx, fy, p.x, p.y));
    },
    destroy: () => {
      svgEl.removeEventListener('wheel', onWheel);
      svgEl.removeEventListener('pointerdown', onDown);
      svgEl.removeEventListener('pointermove', onMove);
      svgEl.removeEventListener('pointerup', onUp);
      svgEl.removeEventListener('pointercancel', onUp);
    },
  };
}

/* -------------------------------------------------------------------- hint */

export const HINT_KEY = 'agi:chart-hint';
const HINT_MS = 4000;
export const HINT_TEXT = 'Ctrl + Shift + scroll to zoom · drag to pan · + / − buttons';

/**
 * The one-time wheel hint (REDESIGN §12.1): shown for four seconds the first time a plain wheel
 * rolls over the canvas, then remembered in localStorage so it never nags. Storage is best-effort.
 *
 * The node starts *empty*. A live region announces a change of its content, not of its classes,
 * so shipping the sentence in the DOM and only toggling `is-visible` meant screen-reader users
 * never heard the hint — while the invisible text was still read out of context when traversing
 * the canvas. Writing the text in `show()` and clearing it afterwards makes the announcement real.
 */
export function createHint(host: HTMLElement): { show(): void; destroy(): void } {
  const node = el('div', { class: 'chart-hint', role: 'status', 'aria-live': 'polite' });
  host.append(node);
  let timer = 0;
  let seen = false;
  try {
    seen = localStorage.getItem(HINT_KEY) === '1';
  } catch {
    seen = false;
  }
  return {
    show(): void {
      if (seen) return;
      seen = true;
      try {
        localStorage.setItem(HINT_KEY, '1');
      } catch {
        /* storage unavailable — the hint simply shows again next time */
      }
      node.textContent = HINT_TEXT;
      node.classList.add('is-visible');
      timer = window.setTimeout(() => {
        node.classList.remove('is-visible');
        // Emptied only after the fade, or the pill would go blank while still on screen.
        timer = window.setTimeout(() => {
          node.textContent = '';
        }, 400);
      }, HINT_MS);
    },
    destroy(): void {
      if (timer) window.clearTimeout(timer);
      node.remove();
    },
  };
}

/* ----------------------------------------------------------------- scrubber */

export interface ScrubOptions {
  store: Store;
  x: () => XScale;
  min: ISODate;
  max: ISODate;
}

/** Pointer-drag on the "now" handle. Keyboard users get the range input under the chart. */
export function attachScrub(handle: SVGCircleElement, opts: ScrubOptions): () => void {
  const { store, x } = opts;
  let dragging = false;

  const toISO = (clientX: number): ISODate => {
    const svgEl = handle.ownerSVGElement;
    const rect = (svgEl ?? handle).getBoundingClientRect();
    const d = x().invert(clientX - rect.left);
    const iso = fromDate(new Date(Math.round(d.getTime() / DAY) * DAY));
    return iso < opts.min ? opts.min : iso > opts.max ? opts.max : iso;
  };

  const onDown = (ev: PointerEvent): void => {
    ev.preventDefault();
    ev.stopPropagation();
    dragging = true;
    handle.setPointerCapture(ev.pointerId);
    store.setAsOf(toISO(ev.clientX));
  };
  const onMove = (ev: PointerEvent): void => {
    if (!dragging) return;
    ev.preventDefault();
    ev.stopPropagation();
    store.setAsOf(toISO(ev.clientX));
  };
  const onUp = (ev: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    ev.stopPropagation();
    try {
      handle.releasePointerCapture(ev.pointerId);
    } catch {
      /* pointer already released */
    }
    announce(`Recomputed as of ${fmtDate(store.get().asOf)}`);
  };
  const onKey = (ev: KeyboardEvent): void => {
    const step = ev.shiftKey ? 30 : 1;
    let delta = 0;
    if (ev.key === 'ArrowLeft') delta = -step;
    else if (ev.key === 'ArrowRight') delta = step;
    else if (ev.key === 'Home') return store.setAsOf(opts.min);
    else if (ev.key === 'End') return store.setAsOf(opts.max);
    else return;
    ev.preventDefault();
    store.nudgeAsOf(delta);
  };

  handle.addEventListener('pointerdown', onDown);
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
  handle.addEventListener('keydown', onKey);

  return () => {
    handle.removeEventListener('pointerdown', onDown);
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    handle.removeEventListener('keydown', onKey);
  };
}

/* -------------------------------------------------------------- keyboard nav */

/**
 * Arrow keys walk the points: left/right along a lab's own line, up/down to the
 * nearest point on the lab above / below in the current ranking.
 */
export function attachKeyboardNav(pointsGroup: SVGGElement): () => void {
  const onKey = (ev: KeyboardEvent): void => {
    const target = ev.target as SVGCircleElement | null;
    if (!target || !target.classList.contains('lab-point')) return;
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(ev.key)) return;
    ev.preventDefault();

    const all = qsa<SVGCircleElement>('circle.lab-point', pointsGroup);
    const lab = target.getAttribute('data-lab');
    const sameLab = all.filter((n) => n.getAttribute('data-lab') === lab);
    sameLab.sort((a, b) => Number(a.getAttribute('cx')) - Number(b.getAttribute('cx')));
    const i = sameLab.indexOf(target);

    let next: SVGCircleElement | undefined;
    if (ev.key === 'ArrowLeft') next = sameLab[Math.max(0, i - 1)];
    else if (ev.key === 'ArrowRight') next = sameLab[Math.min(sameLab.length - 1, i + 1)];
    else if (ev.key === 'Home') next = sameLab[0];
    else if (ev.key === 'End') next = sameLab[sameLab.length - 1];
    else {
      const cx = Number(target.getAttribute('cx'));
      const cy = Number(target.getAttribute('cy'));
      const up = ev.key === 'ArrowUp';
      let bestScore = Infinity;
      for (const n of all) {
        if (n.getAttribute('data-lab') === lab) continue;
        const ny = Number(n.getAttribute('cy'));
        if (up ? ny >= cy : ny <= cy) continue;
        const score = Math.abs(ny - cy) + Math.abs(Number(n.getAttribute('cx')) - cx) * 0.35;
        if (score < bestScore) {
          bestScore = score;
          next = n;
        }
      }
    }
    if (next && next !== target) next.focus();
  };

  pointsGroup.addEventListener('keydown', onKey);
  return () => pointsGroup.removeEventListener('keydown', onKey);
}

/* ------------------------------------------------------------------ legend */

/**
 * The pre-v3 lab chips in `[data-legend]`. The legend dock (`chart/legend.ts`) has taken over
 * the lab row, so this is a no-op when the old container is gone — `main.ts` still calls it.
 */
export function buildLegend(ctx: Ctx, store: Store, root: ParentNode = document): void {
  const host = maybe('[data-legend]', root);
  if (!host) return;
  const all = qs<HTMLButtonElement>('[data-legend-all]', host);
  all.addEventListener('click', () => {
    store.resetLabs();
    announce('All labs shown');
  });

  for (const lab of ctx.labList) {
    const chip = el('button', {
      type: 'button',
      class: 'chip',
      'data-lab': lab.id,
      'aria-pressed': 'true',
      style: `color:${lab.color}`,
      title: `${lab.name} — click to toggle, double-click to solo`,
    });
    chip.append(el('span', { class: 'chip__dot', 'aria-hidden': 'true' }), el('span', { text: lab.short }));
    chip.addEventListener('click', (ev) => {
      if ((ev as MouseEvent).detail > 1) return; // let dblclick own the second press
      store.toggleLab(lab.id);
    });
    // Hovering a chip focuses its lab on the chart: the others step back, its forecast opens up.
    chip.addEventListener('pointerenter', () => store.setHoverLab(lab.id));
    chip.addEventListener('pointerleave', () => store.setHoverLab(null));
    chip.addEventListener('focus', () => store.setHoverLab(lab.id));
    chip.addEventListener('blur', () => store.setHoverLab(null));
    chip.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      store.soloLab(lab.id);
      announce(store.get().solo ? `Showing only ${lab.name}` : 'All labs shown');
    });
    host.append(chip);
  }

  const sync = (): void => {
    for (const chip of qsa<HTMLButtonElement>('.chip[data-lab]', host)) {
      const id = chip.getAttribute('data-lab') as LabId;
      chip.setAttribute('aria-pressed', store.visible(id) ? 'true' : 'false');
    }
    all.setAttribute('aria-pressed', store.get().solo || store.get().hidden.size ? 'false' : 'true');
  };
  sync();
  store.subscribe((channels) => {
    if (channels.has('filters')) sync();
  });
}
