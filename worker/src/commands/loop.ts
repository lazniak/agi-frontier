/**
 * Long-running mode for the container: poll every LOOP_INTERVAL_MINUTES (+/- 5 min jitter),
 * discover once per 24 h, arena + incremental backfill (+ eval) weekly, exponential backoff
 * up to 6 h after repeated failures, everything caught, SIGTERM handled.
 *
 * Before every step the published state flips to `running · step`; before every sleep it goes
 * back to `idle` with `next_run_at = now + delay`, which is what the site's progress bar reads.
 */
import { runPoll } from './poll';
import { runDiscover } from './discover';
import { runArena } from '../researcher/arena';
import { runBackfill } from '../researcher/backfill';
import { runEval } from '../researcher/eval';
import { isoNow } from '../fetcher';
import { markIdle, markRunning, summariseRun } from '../state';
import { computeCadence, ingestTrafficLog } from '../traffic';
import type { ResearchCadence } from '@agi/shared';
import type { Runtime } from '../runtime';

export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
export const JITTER_MS = 5 * 60 * 1000;
export const DISCOVER_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const WEEKLY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface LoopOptions {
  /** Stop after N iterations — used by tests; the container runs unbounded. */
  maxIterations?: number;
  sleepImpl?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

/** interval * 2^failures, capped, then +/- up to 5 minutes of jitter (never negative). */
export function nextDelayMs(intervalMs: number, consecutiveFailures: number, random = Math.random): number {
  const backoff = Math.min(intervalMs * Math.pow(2, Math.max(0, consecutiveFailures)), MAX_BACKOFF_MS);
  const jitter = (random() * 2 - 1) * JITTER_MS;
  return Math.max(1000, Math.round(backoff + jitter));
}

export function shouldDiscover(lastDiscoverAt: string | null, nowMs: number, enabled: boolean): boolean {
  if (!enabled) return false;
  if (!lastDiscoverAt) return true;
  const t = Date.parse(lastDiscoverAt);
  if (!Number.isFinite(t)) return true;
  return nowMs - t >= DISCOVER_INTERVAL_MS;
}

/** Shared weekly gate: true when never run, or when `last` is older than 7 days (or unparseable). */
export function shouldRunWeekly(lastAt: string | null, nowMs: number, enabled: boolean, intervalMs = WEEKLY_INTERVAL_MS): boolean {
  if (!enabled) return false;
  if (!lastAt) return true;
  const t = Date.parse(lastAt);
  if (!Number.isFinite(t)) return true;
  return nowMs - t >= intervalMs;
}

/**
 * The research gates. `intervalMs` comes from the traffic-scaled cadence (REDESIGN §12.8) and
 * defaults to the old fixed week, so a worker with no traffic log behaves exactly as before.
 * A null stamp still means "never ran" — the first run after a deploy happens immediately.
 */
export function shouldArena(
  lastArenaAt: string | null,
  nowMs: number,
  enabled: boolean,
  intervalMs = WEEKLY_INTERVAL_MS,
): boolean {
  return shouldRunWeekly(lastArenaAt, nowMs, enabled, intervalMs);
}

export function shouldBackfill(
  lastBackfillAt: string | null,
  nowMs: number,
  enabled: boolean,
  intervalMs = WEEKLY_INTERVAL_MS,
): boolean {
  return shouldRunWeekly(lastBackfillAt, nowMs, enabled, intervalMs);
}

/**
 * Ingest the nginx traffic log, recompute the cadence and publish it in the run state so the next
 * bundle carries it. Returns the cadence for the gates below.
 *
 * Called at the top of every iteration (before `poll`, which writes the bundle) and again after
 * the research steps, so `next_research_at` reflects the run that just happened rather than the
 * previous one. Running it twice is safe: the fold is idempotent and the hysteresis advances at
 * most once per closed day.
 */
export function refreshCadence(rt: Runtime, nowMs: number): ResearchCadence {
  const run = rt.state.readRun();
  const ingest = ingestTrafficLog({
    path: rt.config.trafficLog,
    state: run.traffic,
    now: nowMs,
    // Persist before the log is truncated — a crash then re-reads instead of losing a day.
    commit: (traffic) => {
      const latest = rt.state.readRun();
      rt.state.writeRun({ ...latest, traffic });
    },
  });
  const { traffic, cadence } = computeCadence({
    traffic: ingest.state,
    usageTotalUsd: run.researcher.usage_total?.usd_estimate ?? 0,
    monthlyBudgetUsd: rt.config.researchMonthlyUsd,
    lastResearchAt: run.researcher.last_backfill_at,
    now: nowMs,
  });
  const latest = rt.state.readRun();
  rt.state.writeRun({ ...latest, traffic, researcher: { ...latest.researcher, cadence } });
  if (ingest.read) {
    rt.log.info('traffic ingested', {
      visits: ingest.visits.length,
      bots: ingest.bots,
      ignored: ingest.ignored,
      malformed: ingest.malformed,
      truncated: ingest.truncated,
      visitors_per_day: cadence.visitors_per_day,
      days_measured: cadence.days_measured,
      tier: cadence.tier,
      interval_hours: cadence.interval_hours,
      capped: cadence.capped,
    });
  }
  return cadence;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

async function guarded(rt: Runtime, step: string, fn: () => Promise<number>): Promise<number> {
  markRunning(rt.state, step);
  rt.log.info('step started', { step });
  try {
    return await fn();
  } catch (e) {
    rt.log.error('step threw', { step, error: (e as Error).message });
    return 1;
  }
}

export async function runLoop(rt: Runtime, opts: LoopOptions = {}): Promise<number> {
  const sleep = opts.sleepImpl ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const intervalMs = Math.max(1, rt.config.loopIntervalMinutes) * 60_000;
  const controller = new AbortController();
  let stopping = false;

  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    rt.log.info('shutting down', { signal });
    controller.abort();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  const run0 = rt.state.readRun();
  run0.interval_minutes = rt.config.loopIntervalMinutes;
  rt.state.writeRun(run0);

  rt.log.info('loop started', {
    interval_minutes: rt.config.loopIntervalMinutes,
    discover: rt.config.discoverEnabled,
    arena: rt.config.arenaEnabled,
    backfill: rt.config.backfillEnabled,
    model: rt.config.openRouterModel,
    git_push: rt.config.gitPush,
    data_dir: rt.config.dataDir,
  });

  let failures = 0;
  let iterations = 0;
  while (!stopping) {
    iterations++;

    // Before `poll`, because `poll` writes the bundle and the site should see today's cadence.
    const researchIntervalMs = refreshCadence(rt, now()).interval_hours * 3_600_000;

    const pollCode = await guarded(rt, 'poll', () => runPoll(rt, {}));
    failures = pollCode === 0 ? 0 : failures + 1;
    if (pollCode !== 0) rt.log.warn('poll reported errors', { consecutive_failures: failures });

    if (!stopping && shouldDiscover(rt.state.readRun().last_discover_at, now(), rt.config.discoverEnabled)) {
      await guarded(rt, 'discover', () => runDiscover(rt, {}));
    }

    let researched = false;
    if (!stopping && shouldArena(rt.state.readRun().researcher.last_arena_at, now(), rt.config.arenaEnabled, researchIntervalMs)) {
      const arenaCode = await guarded(rt, 'arena', () => runArena(rt, {}));
      if (arenaCode !== 0) rt.log.warn('arena reported errors');
      researched = true;
    }

    if (!stopping && shouldBackfill(rt.state.readRun().researcher.last_backfill_at, now(), rt.config.backfillEnabled, researchIntervalMs)) {
      const backfillCode = await guarded(rt, 'backfill --incremental', () => runBackfill(rt, { incremental: true }));
      if (backfillCode !== 0) rt.log.warn('backfill reported errors');
      // The eval only means something fresh right after the candidate set moved.
      await guarded(rt, 'eval', () => runEval(rt, {}));
      researched = true;
    }

    // `next_research_at` was computed from the previous run's stamp; re-stamp it now that the
    // research has actually happened, so the site's second progress bar counts down from here.
    if (researched) refreshCadence(rt, now());

    if (opts.maxIterations !== undefined && iterations >= opts.maxIterations) break;
    if (stopping) break;

    const delay = nextDelayMs(intervalMs, failures);
    const nextRunAt = new Date(now() + delay).toISOString().replace(/\.\d{3}Z$/, 'Z');
    markIdle(rt.state, { nextRunAt, intervalMinutes: rt.config.loopIntervalMinutes });
    rt.log.info('sleeping', { ms: delay, minutes: Math.round(delay / 60_000), next_run_at: nextRunAt });
    await sleep(delay, controller.signal);
  }

  // Shutting down: leave a coherent published state behind.
  markIdle(rt.state, { nextRunAt: null, intervalMinutes: rt.config.loopIntervalMinutes, now: isoNow() });
  rt.log.info('loop stopped', { iterations });
  return 0;
}
