/**
 * Worker runtime state under `STATE_DIR` (default `worker/.state`, git-ignored):
 *   state.json   — run bookkeeping + the `worker` block of latest.json
 *   hashes.json  — per source: last content hash and the item keys already seen
 *   pages/*.txt  — fetched page text cache (written by the fetcher)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMPTY_WORKER_STATE, type ResearcherBudget, type WorkerState } from '@agi/shared';
import { isoNow } from './fetcher';

export interface RunState extends WorkerState {
  /** Last successful `discover` run — the 24 h gate in `loop`. */
  last_discover_at: string | null;
}

/**
 * The OpenRouter client's running totals — same shape as the published budget, but a different
 * thing: a snapshot of the *client's lifetime* counters, not a run's own usage. `usageDelta`
 * takes two of these and returns the run's `ResearcherBudget`, so the distinction is visible in
 * the signatures rather than only in prose.
 */
export type UsageSnapshot = ResearcherBudget;

export const ZERO_USAGE: ResearcherBudget = { calls: 0, tokens_in: 0, tokens_out: 0, usd_estimate: 0 };

/** Sum two usage records; USD is rounded to micro-dollars so repeated adds do not drift. */
export function addUsage(a: ResearcherBudget | null | undefined, b: ResearcherBudget): ResearcherBudget {
  const base = a ?? ZERO_USAGE;
  return {
    calls: base.calls + b.calls,
    tokens_in: base.tokens_in + b.tokens_in,
    tokens_out: base.tokens_out + b.tokens_out,
    usd_estimate: Math.round((base.usd_estimate + b.usd_estimate) * 1_000_000) / 1_000_000,
  };
}

/**
 * The per-run delta between two client snapshots. The OpenRouter client is shared by every
 * command in the `loop` process, so its lifetime totals are not the run's own usage — this
 * subtraction is. `before` is null when the run started before any snapshot existed.
 */
export function usageDelta(after: UsageSnapshot, before: UsageSnapshot | null | undefined): ResearcherBudget {
  const b = before ?? ZERO_USAGE;
  return {
    calls: after.calls - b.calls,
    tokens_in: after.tokens_in - b.tokens_in,
    tokens_out: after.tokens_out - b.tokens_out,
    usd_estimate: Math.round((after.usd_estimate - b.usd_estimate) * 1_000_000) / 1_000_000,
  };
}

/**
 * Book one run's OpenRouter delta into the run state (REDESIGN §12.6): every run — poll,
 * discover, backfill — accumulates into `researcher.usage_total` (lifetime, persisted across
 * restarts, unlike the in-memory client totals), while `researcher.budget` is only replaced by
 * a *research* run (discover / backfill). Showing the last poll's delta as "Budget" is what made
 * the site's Researcher panel read as "the LLM is broken" (0 calls) after a 107-call backfill.
 */
export function recordUsage(run: RunState, delta: ResearcherBudget, opts: { research: boolean }): RunState {
  run.researcher = {
    ...run.researcher,
    usage_total: addUsage(run.researcher.usage_total, delta),
    ...(opts.research ? { budget: delta } : {}),
  };
  return run;
}

/**
 * The research steps that own a segment of `last_backfill_summary`, in the order they are
 * published. This is also the order `loop` runs them in (arena → backfill → eval).
 */
export const SUMMARY_STEPS = ['arena', 'backfill', 'eval'] as const;
export type SummaryStep = (typeof SUMMARY_STEPS)[number];

function summaryStepOf(segment: string): SummaryStep | null {
  return SUMMARY_STEPS.find((s) => segment.startsWith(`${s}:`)) ?? null;
}

/**
 * Split a composed summary back into one segment per step. Segments are joined with ` · `, but
 * a step's own text may contain that separator too (`backfill: … , 107 calls · 2.03 USD`), so a
 * piece that does not open with a known step prefix is a continuation of the previous segment.
 */
function splitSummarySegments(line: string): Map<SummaryStep, string> {
  const out = new Map<SummaryStep, string>();
  let current: SummaryStep | null = null;
  for (const piece of line.split(' · ')) {
    const step = summaryStepOf(piece);
    if (step) {
      out.set(step, piece);
      current = step;
    } else if (current) {
      out.set(current, `${out.get(current) ?? ''} · ${piece}`);
    }
  }
  return out;
}

/**
 * Compose `researcher.last_backfill_summary` (the contract keeps it a single string).
 *
 * The steps share one weekly gate, so in the loop they fire back-to-back: arena → backfill →
 * eval, seconds apart. A plain "last line wins" therefore published the arena line for only as
 * long as the backfill took to run, and REDESIGN §12.6 item 4 asks for all three to land in the
 * panel. So each step owns its own segment, keyed by its prefix, and a new line replaces only
 * the segment of the same step. The one dependency between steps: a fresh backfill moves the
 * candidate set, which makes the standing eval stale, so that segment is dropped rather than
 * left to describe a set that no longer exists. A line from an unknown step has nowhere to sit
 * and stands alone, as before.
 */
export function mergeSummaryLine(previous: string | null | undefined, next: string): string {
  const step = summaryStepOf(next);
  if (!step) return next;
  const segments = splitSummarySegments(previous ?? '');
  segments.set(step, next);
  if (step === 'backfill') segments.delete('eval');
  return SUMMARY_STEPS.map((s) => segments.get(s))
    .filter((s): s is string => s !== undefined)
    .join(' · ');
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
  researcher: { ...EMPTY_WORKER_STATE.researcher, usage_total: null, last_backfill_summary: null },
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
    // Older state.json files predate these two fields; publish them as explicit nulls so the
    // site can tell "never measured" from "missing key".
    return {
      ...pub,
      researcher: {
        ...pub.researcher,
        usage_total: pub.researcher.usage_total ?? null,
        last_backfill_summary: pub.researcher.last_backfill_summary ?? null,
      },
    };
  }
}

/** Flip the published state to "running" with a human-readable step (shown as `running · step`). */
export function markRunning(store: StateStore, step: string, now: string = isoNow()): RunState {
  const run = store.readRun();
  run.run_status = 'running';
  run.run_step = step;
  run.last_run_at = now;
  store.writeRun(run);
  return run;
}

export interface IdleOptions {
  /** When the loop will wake up — drives the site's "next research in …" progress bar. */
  nextRunAt: string | null;
  /** One-line result of the finished run, e.g. `poll: 23 pages, 1 changed · 0.004 USD`. */
  summary?: string | null;
  intervalMinutes?: number;
  now?: string;
}

/** Flip the published state back to "idle" and schedule the next run. */
export function markIdle(store: StateStore, opts: IdleOptions): RunState {
  const run = store.readRun();
  run.run_status = 'idle';
  run.run_step = null;
  run.next_run_at = opts.nextRunAt;
  if (opts.summary !== undefined) run.last_run_summary = opts.summary;
  if (opts.intervalMinutes !== undefined) run.interval_minutes = opts.intervalMinutes;
  store.writeRun(run);
  return run;
}

/** One line for `last_run_summary`, e.g. `poll: 23 pages, 1 changed, 2 LLM calls · 0.004 USD`. */
export function summariseRun(
  step: string,
  parts: Record<string, number | string | undefined>,
  usd?: number,
): string {
  const bits = Object.entries(parts)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${v} ${k}`);
  const head = `${step}: ${bits.length ? bits.join(', ') : 'nothing to report'}`;
  return usd !== undefined ? `${head} · ${usd.toFixed(3)} USD` : head;
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
