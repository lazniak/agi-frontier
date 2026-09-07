/**
 * Worker runtime state under `STATE_DIR` (default `worker/.state`, git-ignored):
 *   state.json   — run bookkeeping + the `worker` block of latest.json
 *   hashes.json  — per source: last content hash and the item keys already seen
 *   pages/*.txt  — fetched page text cache (written by the fetcher)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMPTY_WORKER_STATE, type WorkerState } from '@agi/shared';
import { isoNow } from './fetcher';

export interface RunState extends WorkerState {
  /** Last successful `discover` run — the 24 h gate in `loop`. */
  last_discover_at: string | null;
}

export interface SourceState {
  hash: string;
  checked_at: string;
  changed_at: string | null;
  /** Item keys already processed. Capped; oldest dropped first. */
  seen: string[];
}

export type HashState = Record<string, SourceState>;

export const EMPTY_RUN_STATE: RunState = {
  ...EMPTY_WORKER_STATE,
  last_discover_at: null,
};

/** Comfortably larger than the biggest source window (OpenAI's feed carries 400+ items). */
const MAX_SEEN = 1200;

export class StateStore {
  constructor(private readonly dir: string) {}

  get pagesDir(): string {
    return join(this.dir, 'pages');
  }

  readRun(): RunState {
    const raw = readJson<Partial<RunState>>(join(this.dir, 'state.json'));
    return { ...EMPTY_RUN_STATE, ...(raw ?? {}) };
  }

  writeRun(state: RunState): void {
    writeJson(join(this.dir, 'state.json'), state);
  }

  readHashes(): HashState {
    return readJson<HashState>(join(this.dir, 'hashes.json')) ?? {};
  }

  writeHashes(hashes: HashState): void {
    writeJson(join(this.dir, 'hashes.json'), hashes);
  }

  /** The public bundle exposes everything except the loop-internal bookkeeping. */
  static toWorkerState(run: RunState): WorkerState {
    const { last_discover_at: _discover, ...pub } = run;
    return pub;
  }
}

export function sourceKey(labId: string, url: string): string {
  return `${labId}|${url}`;
}

/**
 * Compare a freshly polled source against stored state.
 * `changed` drives "should we look at all"; `newItems` drives "what costs an LLM call".
 */
export function diffSource(
  previous: SourceState | undefined,
  hash: string,
  itemKeys: string[],
  now: string = isoNow(),
): { changed: boolean; newItems: string[]; next: SourceState } {
  const seen = new Set(previous?.seen ?? []);
  const newItems = itemKeys.filter((k) => !seen.has(k));
  const changed = previous?.hash !== hash;
  const merged = [...(previous?.seen ?? []), ...newItems];
  const next: SourceState = {
    hash,
    checked_at: now,
    changed_at: changed ? now : (previous?.changed_at ?? null),
    seen: merged.slice(Math.max(0, merged.length - MAX_SEEN)),
  };
  return { changed, newItems, next };
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirOf(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i < 0 ? '.' : path.slice(0, i);
}
