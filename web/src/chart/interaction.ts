/** Zoom / pan, the draggable "now" scrubber, keyboard traversal and the legend. */
import { select } from 'd3-selection';
import { zoom, zoomIdentity, zoomTransform, type D3ZoomEvent, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';
import type { ISODate, LabId } from '@agi/shared';
import type { Ctx } from '../data';
import type { Store } from '../state';
import { announce, el, qs, qsa } from '../dom';
import { fmtDate } from '../ui/format';
import { fromDate, type Geom, type XScale } from './scales';

const DAY = 86_400_000;

/* -------------------------------------------------------------------- zoom */

export interface ZoomHandle {
  behavior: ZoomBehavior<SVGSVGElement, unknown>;
  transform(): ZoomTransform;
  reset(): void;
}

export function attachZoom(
  svgEl: SVGSVGElement,
  getGeom: () => Geom,
  onZoom: (t: ZoomTransform) => void,
): ZoomHandle {
  const sel = select(svgEl);
  const behavior = zoom<SVGSVGElement, unknown>()
    .scaleExtent([1, 40])
    .filter((ev: Event) => {
      const e = ev as WheelEvent & { button?: number; ctrlKey: boolean };
      if (e.type === 'dblclick') return false;
      // Never let the scrubber handle start a pan.
      const target = ev.target as Element | null;
      if (target && typeof target.closest === 'function' && target.closest('.now-handle')) return false;
      if (e.type === 'wheel') {
        // Already fully zoomed out and scrolling further out → let the page scroll instead of
        // swallowing the gesture. d3-zoom only calls preventDefault once the filter passes.
        const k = zoomTransform(svgEl).k;
        if (e.deltaY > 0 && k <= 1.0000001) return false;
        return true;
      }
      return e.button === 0 || e.button === undefined;
    })
    .on('start', () => svgEl.parentElement?.classList.add('is-panning'))
    .on('end', () => svgEl.parentElement?.classList.remove('is-panning'))
    .on('zoom', (ev: D3ZoomEvent<SVGSVGElement, unknown>) => onZoom(ev.transform));

  sel.call(behavior);
  // The wheel gesture is horizontal-only; d3 handles the rest.
  const applyExtent = (): void => {
    const g = getGeom();
    behavior.extent([
      [g.x0, g.y1],
      [g.x1, g.y0],
    ]);
    behavior.translateExtent([
      [g.x0 - g.iw * 1.5, -Infinity],
      [g.x1 + g.iw * 1.5, Infinity],
    ]);
  };
  applyExtent();

  return {
    behavior,
    transform: () => zoomTransform(svgEl),
    reset: () => {
      applyExtent();
      sel.call(behavior.transform, zoomIdentity);
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
    store.setAsOf(toISO(ev.clientX));
  };
  const onUp = (ev: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
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
    const cur = new Date(`${store.get().asOf}T00:00:00Z`).getTime();
    store.setAsOf(fromDate(new Date(cur + delta * DAY)));
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

export function buildLegend(ctx: Ctx, store: Store, root: ParentNode = document): void {
  const host = qs('[data-legend]', root);
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
