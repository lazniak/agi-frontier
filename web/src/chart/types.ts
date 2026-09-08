/** Shared render context for the chart layers. */
import type { ISODate, LabId } from '@agi/shared';
import type { Computed, Ctx } from '../data';
import type { Geom, XScale, YScale } from './scales';

export interface PointerLike {
  clientX: number;
  clientY: number;
}

/** Everything a layer may do to the world outside its own <g>. */
export interface Interactions {
  tip(html: string, at: PointerLike): void;
  tipMove(at: PointerLike): void;
  tipHide(): void;
  hoverRelease(id: string | null): void;
  /** Focus a lab (legend hover, forecast hover); null clears it. */
  hoverLab(id: LabId | null): void;
  openAudit(id: string): void;
  /** Highlight a ladder row (hovering the ladder or a level); null clears it. Optional. */
  hoverLevel?(id: string | null): void;
}

/**
 * Optional drawing layers the legend dock toggles (REDESIGN §12.1). `ribbons` and `tiers` are
 * the store's own `bands` / `tierView` flags seen through the same switch; the rest hide or show
 * a layer group without touching the store.
 */
export type LayerToggle = 'ribbons' | 'fans' | 'frontierFan' | 'lens' | 'ladder' | 'crossings' | 'backtest' | 'pace' | 'tiers';

export const LAYER_TOGGLES: readonly LayerToggle[] = [
  'ribbons',
  'fans',
  'frontierFan',
  'lens',
  'ladder',
  'crossings',
  'backtest',
  'pace',
  'tiers',
];

export interface RenderCtx {
  ctx: Ctx;
  computed: Computed;
  x: XScale;
  y: YScale;
  geom: Geom;
  asOf: ISODate;
  today: ISODate;
  hover: string | null;
  selected: string | null;
  /**
   * The lab the reader is looking at (pin, smart hover, legend hover, hovered or selected
   * release, solo). Every other lab steps back while it is set — through CSS classes toggled by
   * the shell (`is-focus` / `is-dim` on every `[data-lab]` element), not per-render attributes.
   */
  focusLab: LabId | null;
  /** The pinned family, when the reader clicked one (REDESIGN §12.2). */
  pinnedLab: LabId | null;
  /**
   * Labs whose forecast is drawn in full (fan + release lens). The rest get a compact whisker,
   * so ten forecasts never pile into one yellow knot. See `chart/forecast.ts`.
   */
  spotlight: ReadonlySet<LabId>;
  visible: (lab: LabId) => boolean;
  /** Is an optional layer switched on in the legend dock? */
  layerOn: (layer: LayerToggle) => boolean;
  reduced: boolean;
  /** Forecast depth: `next` = one release ahead, `long` = the full chain. */
  forecast: 'next' | 'long';
  /** Family ribbons on/off (the store's `bands` flag). */
  bands: boolean;
  /** Which tiers get markers: flagship only, or mid/small too. */
  tierView: 'flagship' | 'all';
  /** Id of the soft-glow SVG filter defined by the chart shell. */
  glowId: string;
  io: Interactions;
}

/**
 * The pixel footprint of one release lens, handed from the forecast layer to the smart hover so
 * pointing at a lens focuses its family (REDESIGN §12.2).
 */
export interface LensShape {
  lab: LabId;
  cx: number;
  cy: number;
  /** Half-width along time (2nd–98th percentile) and half-thickness at the mode. */
  rx: number;
  ry: number;
}

export const PREDICT = '#F5C400';
export const ANNOUNCED = '#9AA0A6';
export const INK = '#111111';

/* The opacity of a lab that is not the focus is a CSS concern now (`.is-dim` in chart.css); the
   old DIM_LINE / DIM_POINT constants were a second copy of the same number and are gone. */

/** Fading applied to the k-th chained prediction. */
export const CHAIN_OPACITY = [1, 0.7, 0.5, 0.35, 0.25];

export function chainOpacity(k: number): number {
  return CHAIN_OPACITY[Math.min(CHAIN_OPACITY.length - 1, Math.max(0, k - 1))] ?? 0.25;
}
