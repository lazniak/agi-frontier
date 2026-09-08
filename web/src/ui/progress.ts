/**
 * "Next research in 3 days" — the header progress bar (REDESIGN §7.2, §6.3, §12.8).
 *
 * The bar counts down to the next *research* run, not to the next loop wake. Those used to be the
 * same thing; since the cadence scales with how many people read the site (§12.8) they are not,
 * and the loop wakes hourly to poll whatever the research interval is. So the bar prefers
 * `researcher.cadence.next_research_at` and falls back to the loop's own `next_run_at` — relabelled
 * as a check, because that is what it is — on a bundle from a worker that has no cadence yet.
 *
 * It fills with the share of the interval that has elapsed, re-reads the clock every 30 s and
 * whenever the tab becomes visible again (a backgrounded tab does not tick). Four states: counting
 * down, running, schedule unknown, overdue.
 */
import type { WorkerState } from '@agi/shared';
import type { Ctx } from '../data';
import { clear, el, maybe } from '../dom';
import { cadenceReaders, cadenceTier, fmtDuration, fmtTimestamp } from './format';

/** How often the countdown re-reads the clock. */
const TICK_MS = 30_000;
/** Overdue once `next_run_at` is this many intervals in the past. */
const OVERDUE_FACTOR = 2;

export interface ProgressApi {
  /** Recompute now (called by the timer, the visibility handler and on demand). */
  refresh(): void;
  destroy(): void;
}

type State = 'idle' | 'running' | 'unknown' | 'overdue';

function ms(ts: string | null): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t;
}

/**
 * What the bar is counting down to. The research schedule wins when the worker publishes one;
 * `start` is the last research run, so the bar measures the wait the reader is actually in.
 */
interface Schedule {
  kind: 'research' | 'check';
  next: number;
  /** The stamp the `next` came from, kept so the overdue message can print it as published. */
  nextAt: string;
  start: number;
  intervalMs: number;
}

function schedule(w: WorkerState): Schedule | null {
  const cadence = w.researcher.cadence;
  const researchAt = cadence?.next_research_at ?? null;
  const research = ms(researchAt);
  if (cadence && researchAt !== null && research !== null) {
    const intervalMs = Math.max(1, cadence.interval_hours) * 3_600_000;
    return {
      kind: 'research',
      next: research,
      nextAt: researchAt,
      start: ms(w.researcher.last_backfill_at) ?? research - intervalMs,
      intervalMs,
    };
  }
  const nextAt = w.next_run_at;
  const next = ms(nextAt);
  if (nextAt === null || next === null) return null;
  const intervalMs = Math.max(1, w.interval_minutes) * 60_000;
  // With no run recorded yet, walk one interval back from the scheduled wake so the bar still
  // means "how much of the wait has elapsed".
  return { kind: 'check', next, nextAt, start: ms(w.last_run_at) ?? next - intervalMs, intervalMs };
}

/** Everything the tooltip says: what the last run did, which model, which researcher, how often. */
function tooltip(w: WorkerState): string {
  const lines = [
    w.last_run_summary ? `Last run: ${w.last_run_summary}` : `Last run: ${fmtTimestamp(w.last_run_at)}`,
    `Extractor model: ${w.llm_model ?? 'none recorded'}`,
    `Researcher: v${w.researcher.version}`,
    `Loop wakes every ${w.interval_minutes} min`,
  ];
  const c = w.researcher.cadence;
  if (c) {
    lines.push(`Research ${cadenceTier(c.tier)} · ${cadenceReaders(c)}`);
    if (c.capped) lines.push('Slowed to the floor: the monthly research budget is spent.');
  }
  return lines.join('\n');
}

export function initProgress(ctx: Ctx): ProgressApi {
  const host = maybe('[data-progress]');
  if (!host) {
    return { refresh(): void {}, destroy(): void {} };
  }

  const label = el('span', { class: 'progress__label' });
  const track = el('span', { class: 'progress__track', 'aria-hidden': 'true' });
  const fill = el('span', { class: 'progress__fill' });
  track.append(fill);
  clear(host);
  host.append(label, track);
  host.setAttribute('role', 'status');

  function paint(state: State, text: string, ratio: number): void {
    host!.dataset.state = state;
    label.textContent = text;
    fill.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
    host!.setAttribute('title', tooltip(ctx.bundle.worker));
  }

  function refresh(): void {
    const w = ctx.bundle.worker;
    const now = Date.now();

    if (w.run_status === 'running') {
      paint('running', w.run_step ? `Researching · ${w.run_step}` : 'Researching', 1);
      return;
    }

    const s = schedule(w);
    if (s === null) {
      paint('unknown', 'Research schedule unknown', 0);
      return;
    }

    const noun = s.kind === 'research' ? 'Research' : 'Check';
    if (now - s.next > OVERDUE_FACTOR * s.intervalMs) {
      paint('overdue', `${noun} overdue since ${fmtTimestamp(s.nextAt)}`, 1);
      return;
    }

    const span = Math.max(1, s.next - s.start);
    const ratio = (now - s.start) / span;
    const left = Math.max(0, s.next - now);
    paint('idle', `Next ${noun.toLowerCase()} in ${fmtDuration(left)}`, ratio);
  }

  refresh();
  const timer = window.setInterval(refresh, TICK_MS);
  const onVisible = (): void => {
    if (!document.hidden) refresh();
  };
  document.addEventListener('visibilitychange', onVisible);

  return {
    refresh,
    destroy(): void {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    },
  };
}
