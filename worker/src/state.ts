/**
 * Worker runtime state under `STATE_DIR` (default `worker/.state`, git-ignored):
 *   state.json   — run bookkeeping + the `worker` block of latest.json
 *   hashes.json  — per source: last content hash and the item keys already seen
 *   pages/*.txt  — fetched page text cache (written by the fetcher)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkerState } from '@agi/shared';
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
  last_run_at: null,
  last_success_at: null,
  pages_polled: 0,
  pages_changed: 0,
  llm_model: null,
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

  /** Only the five fields the public bundle exposes. */
  static toWorkerState(run: RunState): WorkerState {
    return {
      last_run_at: run.last_run_at,
      last_success_at: run.last_success_at,
      pages_polled: run.pages_polled,
      pages_changed: run.pages_changed,
      llm_model: run.llm_model,
    };
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
