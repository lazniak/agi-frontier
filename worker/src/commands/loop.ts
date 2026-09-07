/**
 * Long-running mode for the container: poll every LOOP_INTERVAL_MINUTES (+/- 5 min jitter),
 * discover once per 24 h, exponential backoff up to 6 h after repeated failures,
 * everything caught, SIGTERM handled.
 */
import { runPoll } from './poll';
import { runDiscover } from './discover';
import type { Runtime } from '../runtime';

export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
export const JITTER_MS = 5 * 60 * 1000;
export const DISCOVER_INTERVAL_MS = 24 * 60 * 60 * 1000;

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

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

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

  rt.log.info('loop started', {
    interval_minutes: rt.config.loopIntervalMinutes,
    discover: rt.config.discoverEnabled,
    model: rt.config.openRouterModel,
    git_push: rt.config.gitPush,
    data_dir: rt.config.dataDir,
  });

  let failures = 0;
  let iterations = 0;
  while (!stopping) {
    iterations++;
    try {
      const code = await runPoll(rt, {});
      failures = code === 0 ? 0 : failures + 1;
      if (code !== 0) rt.log.warn('poll reported errors', { consecutive_failures: failures });
    } catch (e) {
      failures++;
      rt.log.error('poll threw', { error: (e as Error).message, consecutive_failures: failures });
    }

    if (!stopping && shouldDiscover(rt.state.readRun().last_discover_at, now(), rt.config.discoverEnabled)) {
      try {
        await runDiscover(rt, {});
      } catch (e) {
        rt.log.error('discover threw', { error: (e as Error).message });
      }
    }

    if (opts.maxIterations !== undefined && iterations >= opts.maxIterations) break;
    if (stopping) break;

    const delay = nextDelayMs(intervalMs, failures);
    rt.log.info('sleeping', { ms: delay, minutes: Math.round(delay / 60_000) });
    await sleep(delay, controller.signal);
  }

  rt.log.info('loop stopped', { iterations });
  return 0;
}
