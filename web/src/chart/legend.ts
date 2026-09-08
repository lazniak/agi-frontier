/**
 * The legend dock (REDESIGN §12.1) — replaces the static key paragraph. Three rows:
 *
 * - labs: one chip per lab (colour dot, model count) — click toggles visibility, double-click
 *   solos, hover/focus puts the family in focus on the chart (`store.setHoverLab`); the chip in
 *   focus carries `aria-current`;
 * - marks: what the shapes mean (released, provisional, tier, announced, rumored, tick, frontier);
 * - layers: toggle buttons with a swatch for every optional layer, wired to the chart's
 *   `LayerState` (`ribbons` and `tiers` are the store's own flags seen through the same switch).
 *
 * Keyboard reachable throughout; 44 px targets under 720 px come from chart.css.
 */
import type { LabId } from '@agi/shared';
import type { Ctx } from '../data';
import type { Store } from '../state';
import { announce, clear, el, qsa } from '../dom';
import { LAYER_TOGGLES, type LayerToggle } from './types';

/* ------------------------------------------------------------- layer state */

export interface LayerState {
  on(layer: LayerToggle): boolean;
  set(layer: LayerToggle, on: boolean): void;
  toggle(layer: LayerToggle): void;
  subscribe(fn: () => void): () => void;
}

const LAYERS_KEY = 'agi:layers';
/** Whether the marks reference is folded open. Default closed — the plot needs the two lines. */
const MARKS_KEY = 'agi:legend-marks';

/**
 * Which optional layers are drawn. `ribbons` and `tiers` read and write the store (they were
 * store flags before v3 and the control bar still drives them); the rest are remembered in
 * localStorage (best-effort) so a reader who hides the crossings finds them hidden tomorrow.
 */
export function createLayerState(store: Store): LayerState {
  const off = new Set<LayerToggle>();
  try {
    const raw = localStorage.getItem(LAYERS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        for (const v of parsed) if (typeof v === 'string' && (LAYER_TOGGLES as readonly string[]).includes(v)) off.add(v as LayerToggle);
      }
    }
  } catch {
    /* storage unavailable or corrupt — everything on */
  }
  const listeners = new Set<() => void>();
  const persist = (): void => {
    try {
      const stored = [...off].filter((l) => l !== 'ribbons' && l !== 'tiers');
      localStorage.setItem(LAYERS_KEY, JSON.stringify(stored));
    } catch {
      /* storage unavailable */
    }
  };
  const emit = (): void => {
    for (const fn of listeners) fn();
  };
  const api: LayerState = {
    on(layer): boolean {
      if (layer === 'ribbons') return store.get().bands;
      if (layer === 'tiers') return store.get().tierView === 'all';
      return !off.has(layer);
    },
    set(layer, on): void {
      if (layer === 'ribbons') {
        store.setBands(on);
        return;
      }
      if (layer === 'tiers') {
        store.setTierView(on ? 'all' : 'flagship');
        return;
      }
      if (on === !off.has(layer)) return;
      if (on) off.delete(layer);
      else off.add(layer);
      persist();
      emit();
    },
    toggle(layer): void {
      api.set(layer, !api.on(layer));
    },
    subscribe(fn): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  // The store-backed toggles change through the control bar too; relay so the dock re-syncs.
  store.subscribe((channels) => {
    if (channels.has('view')) emit();
  });
  return api;
}

/* -------------------------------------------------------------------- dock */

export interface LegendDockDeps {
  ctx: Ctx;
  store: Store;
  layers: LayerState;
  /** The family currently in focus (pin, smart hover, legend hover…). */
  focus: () => LabId | null;
}

export interface LegendDock {
  /** Re-read visibility, focus and layer flags. Cheap. */
  sync(): void;
  destroy(): void;
}

interface LayerChip {
  layer: LayerToggle;
  swatch: string;
  label: string;
  title: string;
}

const LAYER_CHIPS: LayerChip[] = [
  {
    layer: 'ribbons',
    swatch: 'band',
    label: 'family ribbon',
    title: 'Family ribbon — the best and the weakest member of the lab’s current family, on real data',
  },
  { layer: 'fans', swatch: 'fan', label: 'forecast fan', title: 'Forecast fan — 10th to 90th percentile of the lab’s capability trend' },
  {
    layer: 'frontierFan',
    swatch: 'frontierfan',
    label: 'frontier trend fan',
    title: 'Frontier trend fan — the running maximum continued, with its 90 % band',
  },
  {
    layer: 'lens',
    swatch: 'lens',
    // The full sentence lived in the chip until it wrapped the layers row onto a second line of
    // a stage the plot needs (T49); the tooltip still spells it out.
    label: 'release lens',
    title: 'Release lens — its thickness at a date follows the probability of the launch landing there; inner edge 68 %, outer edge 90 %',
  },
  { layer: 'ladder', swatch: 'ladder', label: 'ladder', title: 'Level ladder — human baselines, saturations, generation ceilings and the speculative landmarks' },
  { layer: 'crossings', swatch: 'crossing', label: 'crossings', title: 'Predicted crossings of the levels by the frontier trend' },
  { layer: 'backtest', swatch: 'bt', label: 'backtest hairline', title: 'Backtest hairline — prediction to actual release, while the scrubber is in the past' },
  { layer: 'pace', swatch: 'pace', label: 'pace', title: 'Pace strip — frontier gain per quarter, in logits' },
  { layer: 'tiers', swatch: 'tier', label: 'mid / small tiers', title: 'Also draw mid and small releases as small hollow markers' },
];

interface Mark {
  /** One swatch, or a row of them for a mark that is read as a scale (the backtest hairline). */
  swatch: string | string[];
  label: string;
}

const MARKS: Mark[] = [
  { swatch: 'point', label: 'released flagship' },
  { swatch: 'provisional', label: 'provisional (fewer than 3 index benchmarks)' },
  { swatch: 'tier', label: 'mid / small tier' },
  { swatch: 'announced', label: 'announced' },
  { swatch: 'rumored', label: 'rumored' },
  { swatch: 'tick', label: 'released, no basket score' },
  { swatch: 'frontier', label: 'running maximum' },
  // The dock replaced the static key, and these two went missing with it: the chart still draws
  // whiskers for the labs outside the spotlight and still colours the backtest hairlines.
  { swatch: 'whisker', label: 'release window (labs outside the spotlight)' },
  { swatch: ['bt68', 'bt90', 'btmiss'], label: 'backtest hairline — inside 68 %, inside 90 %, missed' },
];

export function buildLegendDock(host: HTMLElement, deps: LegendDockDeps): LegendDock {
  const { ctx, store, layers } = deps;
  clear(host);
  const teardown: (() => void)[] = [];

  /* labs */
  const labRow = el('div', { class: 'legend-row legend-row--labs', role: 'group', 'aria-label': 'Labs — toggle visibility, hover to focus' });
  labRow.append(el('span', { class: 'legend-row__label', text: 'Labs' }));
  const chips = el('div', { class: 'legend-chips' });
  const all = el('button', { type: 'button', class: 'chip chip--all', 'aria-pressed': 'true', text: 'All' });
  all.addEventListener('click', () => {
    store.resetLabs();
    announce('All labs shown');
  });
  chips.append(all);

  const counts = new Map<LabId, number>();
  for (const rel of ctx.bundle.releases) {
    if (rel.status !== 'released') continue;
    counts.set(rel.lab, (counts.get(rel.lab) ?? 0) + 1);
  }

  for (const lab of ctx.labList) {
    const n = counts.get(lab.id) ?? 0;
    const chip = el('button', {
      type: 'button',
      class: 'chip chip--lab',
      'data-lab': lab.id,
      'aria-pressed': 'true',
      style: `color:${lab.color}`,
      title: `${lab.name} — ${n} released ${n === 1 ? 'model' : 'models'}. Click to toggle, double-click to solo, hover to focus.`,
    });
    chip.append(
      el('span', { class: 'chip__dot', 'aria-hidden': 'true' }),
      el('span', { class: 'chip__name', text: lab.short }),
      el('span', { class: 'chip__count', text: String(n), 'aria-label': `${n} models` }),
    );
    chip.addEventListener('click', (ev) => {
      if ((ev as MouseEvent).detail > 1) return; // let dblclick own the second press
      store.toggleLab(lab.id);
    });
    chip.addEventListener('pointerenter', () => store.setHoverLab(lab.id));
    chip.addEventListener('pointerleave', () => store.setHoverLab(null));
    chip.addEventListener('focus', () => store.setHoverLab(lab.id));
    chip.addEventListener('blur', () => store.setHoverLab(null));
    chip.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      store.soloLab(lab.id);
      announce(store.get().solo ? `Showing only ${lab.name}` : 'All labs shown');
    });
    chips.append(chip);
  }
  labRow.append(chips);

  /* marks — reference the reader consults once, so it folds away (T49). The labs and layers rows
     are controls and stay open; these eight explanations cost two lines of a stage whose plot was
     measured at 328 px of 780. `<details>` gives the disclosure semantics for free. */
  const markRow = el('details', { class: 'legend-row legend-row--marks' }) as HTMLDetailsElement;
  const summary = el('summary', { class: 'legend-row__label legend-row__label--toggle' });
  summary.append(el('span', { text: 'Marks' }));
  markRow.append(summary);
  const marks = el('div', { class: 'legend-chips legend-chips--marks' });
  for (const m of MARKS) {
    const swatches = (Array.isArray(m.swatch) ? m.swatch : [m.swatch]).map((s) =>
      el('span', { class: `key__swatch key__swatch--${s}`, 'aria-hidden': 'true' }),
    );
    marks.append(el('span', { class: 'legend-mark' }, ...swatches, el('span', { text: m.label })));
  }
  markRow.append(marks);
  try {
    markRow.open = localStorage.getItem(MARKS_KEY) === '1';
  } catch {
    /* private mode: stay closed */
  }
  markRow.addEventListener('toggle', () => {
    try {
      localStorage.setItem(MARKS_KEY, markRow.open ? '1' : '0');
    } catch {
      /* nothing to remember it with */
    }
  });

  /* layers */
  const layerRow = el('div', { class: 'legend-row legend-row--layers', role: 'group', 'aria-label': 'Layers — toggle what is drawn' });
  layerRow.append(el('span', { class: 'legend-row__label', text: 'Layers' }));
  const layerChips = el('div', { class: 'legend-chips' });
  for (const c of LAYER_CHIPS) {
    const btn = el('button', { type: 'button', class: 'chip chip--layer', 'data-layer': c.layer, 'aria-pressed': 'true', title: c.title });
    btn.append(el('span', { class: `key__swatch key__swatch--${c.swatch}`, 'aria-hidden': 'true' }), el('span', { text: c.label }));
    btn.addEventListener('click', () => {
      layers.toggle(c.layer);
      announce(`${c.label}: ${layers.on(c.layer) ? 'shown' : 'hidden'}`);
    });
    layerChips.append(btn);
  }
  layerRow.append(layerChips);

  host.append(labRow, markRow, layerRow);

  const sync = (): void => {
    const focus = deps.focus();
    for (const chip of qsa<HTMLButtonElement>('.chip--lab', host)) {
      const id = chip.getAttribute('data-lab') as LabId;
      chip.setAttribute('aria-pressed', store.visible(id) ? 'true' : 'false');
      if (focus === id) chip.setAttribute('aria-current', 'true');
      else chip.removeAttribute('aria-current');
    }
    all.setAttribute('aria-pressed', store.get().solo || store.get().hidden.size ? 'false' : 'true');
    for (const btn of qsa<HTMLButtonElement>('.chip--layer', host)) {
      const layer = btn.getAttribute('data-layer') as LayerToggle;
      btn.setAttribute('aria-pressed', layers.on(layer) ? 'true' : 'false');
    }
  };
  sync();
  teardown.push(
    store.subscribe((channels) => {
      if (channels.has('filters') || channels.has('hover') || channels.has('selection') || channels.has('view')) sync();
    }),
  );
  teardown.push(layers.subscribe(sync));

  return {
    sync,
    destroy(): void {
      for (const fn of teardown) fn();
      clear(host);
    },
  };
}
