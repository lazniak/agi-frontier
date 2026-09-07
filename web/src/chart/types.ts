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
}

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
   * The lab the reader is looking at (legend hover, hovered or selected release, solo). Every
   * other lab steps back while it is set.
   */
  focusLab: LabId | null;
  /**
   * Labs whose forecast is drawn in full (fan + window circle). The rest get a compact whisker,
   * so ten forecasts never pile into one yellow knot. See `chart/forecast.ts`.
   */
  spotlight: ReadonlySet<LabId>;
  visible: (lab: LabId) => boolean;
  reduced: boolean;
  /** "Long-range forecast (3 years)": full chained chain + the 3-year right edge. */
  longRange: boolean;
  /** Id of the soft-glow SVG filter defined by the chart shell. */
  glowId: string;
  io: Interactions;
}

export const PREDICT = '#F5C400';
export const ANNOUNCED = '#9AA0A6';
export const INK = '#111111';

/** Opacity of a lab that is not the focus while another one is. */
export const DIM_LINE = 0.16;
export const DIM_POINT = 0.28;

/** Fading applied to the k-th chained prediction. */
export const CHAIN_OPACITY = [1, 0.7, 0.5, 0.35, 0.25];

export function chainOpacity(k: number): number {
  return CHAIN_OPACITY[Math.min(CHAIN_OPACITY.length - 1, Math.max(0, k - 1))] ?? 0.25;
}
