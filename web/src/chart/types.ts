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
  visible: (lab: LabId) => boolean;
  reduced: boolean;
  io: Interactions;
}

export const PREDICT = '#F5C400';
export const ANNOUNCED = '#9AA0A6';
export const INK = '#111111';

/** Fading applied to the k-th chained prediction. */
export const CHAIN_OPACITY = [1, 0.7, 0.5, 0.35, 0.25];

export function chainOpacity(k: number): number {
  return CHAIN_OPACITY[Math.min(CHAIN_OPACITY.length - 1, Math.max(0, k - 1))] ?? 0.25;
}
