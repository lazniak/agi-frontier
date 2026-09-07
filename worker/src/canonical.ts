/**
 * Stable serialisation of `data/models/<lab>.json`.
 *
 * Key order follows `shared/src/types.ts`, releases are sorted by date, `undefined` keys are
 * dropped. Rewriting an unchanged file therefore produces a byte-identical result, which is
 * what makes `poll` idempotent and keeps the git history readable.
 *
 * Keys the shared contract gains later are preserved (appended after the known ones) rather
 * than silently dropped — this writer must never lose hand-authored data.
 */
import type { LabFile, ModelRelease, Score, Source } from '@agi/shared';

const SOURCE_KEYS = ['url', 'title', 'quote', 'retrieved_at', 'verified', 'verified_at', 'via', 'note'] as const;
const SCORE_KEYS = ['benchmark', 'value', 'config', 'note', 'reported_by', 'source'] as const;
const RELEASE_KEYS = [
  'id', 'lab', 'name', 'family', 'date', 'date_precision', 'status', 'tier', 'origin',
  'expected_window', 'announcement', 'sources', 'scores', 'notes',
] as const;
const WINDOW_KEYS = ['start', 'end', 'source'] as const;

/** Rebuild an object with `order` first (skipping `undefined`), then any remaining keys. */
function orderKeys<T extends object>(value: T, order: readonly string[]): T {
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of order) {
    if (key in source && source[key] !== undefined) out[key] = source[key];
  }
  for (const key of Object.keys(source)) {
    if (!(key in out) && source[key] !== undefined) out[key] = source[key];
  }
  return out as T;
}

export function canonicalSource(s: Source): Source {
  return orderKeys(s, SOURCE_KEYS);
}

export function canonicalScore(s: Score): Score {
  return orderKeys({ ...s, source: canonicalSource(s.source) }, SCORE_KEYS);
}

export function canonicalRelease(r: ModelRelease): ModelRelease {
  const next: ModelRelease = {
    ...r,
    announcement: canonicalSource(r.announcement),
    scores: r.scores.map(canonicalScore),
  };
  if (r.sources) next.sources = r.sources.map(canonicalSource);
  if (r.expected_window) {
    next.expected_window = orderKeys(
      { ...r.expected_window, source: canonicalSource(r.expected_window.source) },
      WINDOW_KEYS,
    );
  }
  return orderKeys(next, RELEASE_KEYS);
}

export function sortReleases(releases: ModelRelease[]): ModelRelease[] {
  return [...releases].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id.localeCompare(b.id)));
}

export function canonicalLabFile(file: LabFile): LabFile {
  return {
    lab: file.lab,
    updated_at: file.updated_at,
    releases: sortReleases(file.releases).map(canonicalRelease),
  };
}

/** 2-space JSON with a trailing newline — matches `.editorconfig` and the hand-written files. */
export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

export function stringifyLabFile(file: LabFile): string {
  return stringifyJson(canonicalLabFile(file));
}
