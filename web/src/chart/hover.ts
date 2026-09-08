/**
 * Smart hover (REDESIGN §12.2): the family nearest to the pointer is emphasised, the others
 * quieten. Focus moves with hysteresis — only when the pointer is clearly closer to another
 * family and has rested there — so a line crossing under the cursor does not make the chart
 * flicker. A click pins the family; clicking again or Esc unpins.
 *
 * The visual change is a class toggle (`is-focus` / `is-dim`) on every `[data-lab]` element, and
 * `chart.css` animates opacity and stroke-width; nothing here re-renders.
 */
import type { LabId } from '@agi/shared';
import type { LensShape } from './types';

/** Pixel geometry of one family in the current view, rebuilt by the shell after every draw. */
export interface FamilyGeometry {
  lab: LabId;
  /** The lab line through its qualified releases, in order. */
  polyline: [number, number][];
  /** Every marker of the lab (points, tiers), as centres. */
  points: [number, number][];
  /** Release lenses of the lab (spotlight forecasts). */
  lenses: LensShape[];
}

export interface Nearest {
  lab: LabId;
  /** Pixel distance from the pointer to the family's nearest shape. */
  distance: number;
  /** How much farther the second-nearest family is (Infinity when there is only one). */
  margin: number;
}

/** The new nearest must beat the current focus by this many pixels to take over. */
export const SWITCH_MARGIN = 14;
/** …unless the current focus is farther than this from the pointer. */
export const FAR_PX = 60;
/** The pointer must rest this long before the focus moves. */
export const REST_MS = 90;
/** Leaving the plot clears the focus after this long. */
export const LEAVE_MS = 250;
/** Beyond this distance nothing is "near": hovering empty canvas clears the focus. */
export const CAPTURE_PX = 80;

/** Point radius the distance is measured against (a point under the pointer has distance 0). */
const POINT_R = 4;

/** Distance from a point to a segment. */
export function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  return Math.hypot(px - qx, py - qy);
}

/** Distance from a point to a lens, approximated as an ellipse (0 inside). */
function lensDistance(px: number, py: number, s: LensShape): number {
  const rx = Math.max(1, s.rx);
  const ry = Math.max(1, s.ry);
  const nx = (px - s.cx) / rx;
  const ny = (py - s.cy) / ry;
  const n = Math.hypot(nx, ny);
  if (n <= 1) return 0;
  // Scale the excess back to pixels along the pointer's direction.
  const scale = Math.hypot(nx * rx, ny * ry) / n;
  return (n - 1) * scale;
}

/** Pixel distance from the pointer to a family's nearest polyline segment, point or lens. */
export function familyDistance(px: number, py: number, fam: FamilyGeometry): number {
  let best = Number.POSITIVE_INFINITY;
  const line = fam.polyline;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    best = Math.min(best, segmentDistance(px, py, a[0], a[1], b[0], b[1]));
  }
  for (const p of fam.points) best = Math.min(best, Math.max(0, Math.hypot(px - p[0], py - p[1]) - POINT_R));
  for (const s of fam.lenses) best = Math.min(best, lensDistance(px, py, s));
  return best;
}

/**
 * The family nearest to the pointer and its margin over the runner-up. `null` when there is no
 * geometry at all (e.g. every lab hidden).
 */
export function nearestFamily(px: number, py: number, families: FamilyGeometry[]): Nearest | null {
  let first: { lab: LabId; d: number } | null = null;
  let second = Number.POSITIVE_INFINITY;
  for (const fam of families) {
    const d = familyDistance(px, py, fam);
    if (!Number.isFinite(d)) continue;
    if (!first || d < first.d) {
      if (first) second = first.d;
      first = { lab: fam.lab, d };
    } else if (d < second) {
      second = d;
    }
  }
  return first ? { lab: first.lab, distance: first.d, margin: second - first.d } : null;
}

/* -------------------------------------------------------------- controller */

export interface HoverDeps {
  /** Current family geometry (visible labs only). */
  geometry: () => FamilyGeometry[];
  /** The family currently in focus, however it got there. */
  current: () => LabId | null;
  /** The pinned family, if any — while pinned the pointer does not move the focus. */
  pinned: () => LabId | null;
  setFocus: (lab: LabId | null) => void;
  /** Toggle the pin of a family; `null` clears it. */
  pin: (lab: LabId | null) => void;
  /** Injected for tests; defaults to `window.setTimeout` / `clearTimeout`. */
  setTimeout?: (fn: () => void, ms: number) => number;
  clearTimeout?: (id: number) => void;
}

export interface HoverController {
  move(px: number, py: number): void;
  leave(): void;
  click(px: number, py: number): void;
  destroy(): void;
}

export function createHoverController(deps: HoverDeps): HoverController {
  const setT = deps.setTimeout ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((id) => window.clearTimeout(id));
  let restTimer = 0;
  let leaveTimer = 0;
  let pending: LabId | null | undefined; // undefined = nothing pending

  const cancelRest = (): void => {
    if (restTimer) clearT(restTimer);
    restTimer = 0;
    pending = undefined;
  };
  const cancelLeave = (): void => {
    if (leaveTimer) clearT(leaveTimer);
    leaveTimer = 0;
  };

  /** Arm (or re-arm) the rest timer for a focus change — every move restarts the clock. */
  const propose = (next: LabId | null): void => {
    if (restTimer) clearT(restTimer);
    pending = next;
    restTimer = setT(() => {
      restTimer = 0;
      if (pending === undefined) return;
      const next2 = pending;
      pending = undefined;
      if (deps.pinned()) return;
      if (deps.current() !== next2) deps.setFocus(next2);
    }, REST_MS);
  };

  return {
    move(px, py): void {
      cancelLeave();
      if (deps.pinned()) {
        cancelRest();
        return;
      }
      const fams = deps.geometry();
      const n = nearestFamily(px, py, fams);
      const cur = deps.current();
      const curFam = cur ? fams.find((f) => f.lab === cur) : undefined;
      const distToCur = curFam ? familyDistance(px, py, curFam) : Number.POSITIVE_INFINITY;

      if (n && n.lab === cur) {
        cancelRest();
        return;
      }
      if (n && n.distance <= CAPTURE_PX) {
        const takeOver = cur === null || distToCur > FAR_PX || distToCur - n.distance >= SWITCH_MARGIN;
        if (takeOver) propose(n.lab);
        else cancelRest();
        return;
      }
      // Nothing near the pointer: let go of a focus that is far away, keep a close one.
      if (cur !== null && distToCur > FAR_PX) propose(null);
      else cancelRest();
    },
    leave(): void {
      cancelRest();
      cancelLeave();
      leaveTimer = setT(() => {
        leaveTimer = 0;
        if (deps.pinned()) return;
        if (deps.current() !== null) deps.setFocus(null);
      }, LEAVE_MS);
    },
    click(px, py): void {
      cancelRest();
      const n = nearestFamily(px, py, deps.geometry());
      if (n && n.distance <= CAPTURE_PX) deps.pin(n.lab);
      else deps.pin(null);
    },
    destroy(): void {
      cancelRest();
      cancelLeave();
    },
  };
}

/* ------------------------------------------------------------------ classes */

/** The focus last applied to a root, so an unchanged focus can skip the full pass. */
const lastApplied = new WeakMap<ParentNode, LabId | null>();

/**
 * Apply the focus as classes on every `[data-lab]` element under `root`: the focused family gets
 * `is-focus`, every other `is-dim`; no focus clears both. Idempotent, and safe to call after
 * every draw so newly entered elements pick the state up too.
 *
 * The shell calls this on every frame of a drag, a pinch or a wheel zoom, where the focus has
 * not changed — walking every line, point, tier, marker, label, leader, ribbon, whisker, lens,
 * stripe and tick twice per frame for nothing. So when the focus is unchanged only the nodes a
 * data join has just entered are touched: those carry neither class yet, which the `:not()`
 * selector below finds. With no focus at all a fresh node is already correct, so there is
 * nothing to do.
 */
export function applyFocus(root: ParentNode, focus: LabId | null): void {
  const unchanged = lastApplied.has(root) && lastApplied.get(root) === focus;
  lastApplied.set(root, focus);
  if (unchanged && focus === null) return;
  const nodes = root.querySelectorAll<Element>(
    unchanged ? '[data-lab]:not(.is-focus):not(.is-dim)' : '[data-lab]',
  );
  for (const node of Array.from(nodes)) {
    const lab = node.getAttribute('data-lab');
    const isFocus = focus !== null && lab === focus;
    const isDim = focus !== null && lab !== focus;
    node.classList.toggle('is-focus', isFocus);
    node.classList.toggle('is-dim', isDim);
  }
}
