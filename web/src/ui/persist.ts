/**
 * The view choices that survive a reload, kept in one localStorage key (`agi:view`).
 *
 * Everything here is best-effort: private-mode storage throws on both read and write, and a
 * corrupt value must never stop the page from booting — an unreadable key simply means
 * "use the defaults".
 */
import type { ForecastMode, RangeMode, TierView, YMode } from '../state';

export const VIEW_KEY = 'agi:view';
export const TOUR_KEY = 'agi:tour';

/** Pre-redesign keys. Read once for migration, then removed. */
const LEGACY_KEYS = ['agi:long-range', 'agi:full-history', 'agi:y-scale'] as const;

export interface PersistedView {
  yMode: YMode;
  range: RangeMode;
  forecast: ForecastMode;
  bands: boolean;
  tierView: TierView;
}

export const DEFAULT_VIEW: PersistedView = {
  yMode: 'rating',
  range: 'story',
  forecast: 'next',
  bands: true,
  tierView: 'flagship',
};

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function del(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage unavailable — nothing to clean up */
  }
}

const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null;

/**
 * The stored view, merged over the defaults. Migrates the three pre-redesign keys the first time
 * it runs: `agi:long-range` → forecast, `agi:full-history` → range, `agi:y-scale` → yMode.
 */
export function readView(): PersistedView {
  const out: PersistedView = { ...DEFAULT_VIEW };

  const raw = get(VIEW_KEY);
  if (raw) {
    try {
      const p = JSON.parse(raw) as Partial<Record<keyof PersistedView, unknown>>;
      out.yMode = oneOf(p.yMode, ['rating', 'index'] as const) ?? out.yMode;
      out.range = oneOf(p.range, ['story', 'recent'] as const) ?? out.range;
      out.forecast = oneOf(p.forecast, ['next', 'long'] as const) ?? out.forecast;
      out.tierView = oneOf(p.tierView, ['flagship', 'all'] as const) ?? out.tierView;
      if (typeof p.bands === 'boolean') out.bands = p.bands;
      return out;
    } catch {
      /* corrupt JSON — fall through to the legacy migration, then the defaults */
    }
  }

  // One-shot migration from the pre-redesign toggles.
  const legacyLong = get('agi:long-range');
  const legacyHistory = get('agi:full-history');
  const legacyY = get('agi:y-scale');
  if (legacyLong !== null || legacyHistory !== null || legacyY !== null) {
    if (legacyLong === '1') out.forecast = 'long';
    if (legacyHistory === '0') out.range = 'recent';
    // The old axis switch was logit-vs-linear; the linear reading is now the bounded index.
    if (legacyY === 'linear') out.yMode = 'index';
    writeView(out);
  }
  for (const k of LEGACY_KEYS) del(k);
  return out;
}

export function writeView(view: PersistedView): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    /* storage unavailable — the choice simply does not persist */
  }
}

export function readFlag(key: string): boolean {
  return get(key) === '1';
}

export function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}
