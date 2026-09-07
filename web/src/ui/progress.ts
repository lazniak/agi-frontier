/**
 * "Next research in 42 min" — the header progress bar (REDESIGN §7.2, §6.3).
 *
 * Everything comes from `bundle.worker`: the bar fills with the share of the interval that has
 * elapsed since `last_run_at`, and it re-reads the clock every 30 s and whenever the tab becomes
 * visible again (a backgrounded tab does not tick). Four states: counting down, running,
 * schedule unknown, overdue.
 */
import type { WorkerState } from '@agi/shared';
import type { Ctx } from '../data';
import { clear, el, maybe } from '../dom';
import { fmtDuration, fmtTimestamp } from './format';

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

/** Everything the tooltip says: what the last run did, which model, which researcher. */
function tooltip(w: WorkerState): string {
  const lines = [
    w.last_run_summary ? `Last run: ${w.last_run_summary}` : `Last run: ${fmtTimestamp(w.last_run_at)}`,
    `Extractor model: ${w.llm_model ?? 'none recorded'}`,
    `Researcher: v${w.researcher.version}`,
    `Interval: ${w.interval_minutes} min`,
  ];
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

    const next = ms(w.next_run_at);
    if (next === null) {
      paint('unknown', 'Research schedule unknown', 0);
      return;
    }

    const intervalMs = Math.max(1, w.interval_minutes) * 60_000;
    if (now - next > OVERDUE_FACTOR * intervalMs) {
      paint('overdue', `Research overdue since ${fmtTimestamp(w.next_run_at)}`, 1);
      return;
    }

    // `last_run_at` is the start of the bar; with no run recorded yet, walk one interval back
    // from the scheduled wake so the bar still means "how much of the wait has elapsed".
    const start = ms(w.last_run_at) ?? next - intervalMs;
    const span = Math.max(1, next - start);
    const ratio = (now - start) / span;
    const left = Math.max(0, next - now);
    paint('idle', `Next research in ${fmtDuration(left)}`, ratio);
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
