/**
 * Researcher panel — what the automated researcher is doing and how well it does it
 * (REDESIGN §6, §7.1, §12.6).
 *
 * Everything here is `bundle.worker`: the loop's schedule and current step, the evaluation of
 * the researcher against the frozen gold set, its OpenRouter usage, and the one-line summaries
 * of the last poll and the last research run. Two numbers used to be conflated and made the
 * panel lie ("0 calls, 0 %" while the LLM was working): `budget` is the last *research* run's
 * delta, `usage_total` the lifetime total. They are shown side by side, and an LLM status dot
 * says whether the last loop iteration actually succeeded. When nothing published came from the
 * researcher yet, the panel says so rather than implying the dataset is machine-produced.
 */
import type { LabId, ResearcherBudget, ResearcherEval, WorkerState } from '@agi/shared';
import type { Ctx } from '../data';
import { clear, el, maybe } from '../dom';
import { EN_DASH, esc, fmtPercent, fmtTimestamp, pluralise } from './format';

/** A run whose success stamp lags its start stamp by more than this is treated as failed. */
const SUCCESS_LAG_MS = 2 * 60 * 60 * 1000;

function fact(label: string, value: string, note?: string): string {
  return `<div class="rfact"><dt>${esc(label)}</dt><dd>${esc(value)}${note ? `<small>${esc(note)}</small>` : ''}</dd></div>`;
}

/** `busy` is its own tone: a run on the clock has neither succeeded nor failed yet. */
export type LlmTone = 'ok' | 'idle' | 'fail' | 'busy';

export interface LlmStatus {
  tone: LlmTone;
  label: string;
  note: string;
}

function parseTs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * The LLM status dot (REDESIGN §12.6). This panel exists so a reader can tell whether the
 * researcher is actually working, so every branch has to be true of the state that produced it —
 * the earlier version had two that were not:
 *
 * - a run that is *running right now* has `last_run_at` newer than `last_success_at` by however
 *   long it has been going, which the lag test read as a failure and painted red. In progress is
 *   neither success nor failure, so it gets its own amber tone.
 * - a worker whose very first run threw (`last_run_at` set, `last_success_at` still null) fell
 *   through every test and landed on "no run recorded" — with the LLM already billed during that
 *   run. A run *was* recorded; it failed. That is the launch-day state of a fresh deploy.
 *
 * Order matters: running first (it explains the lag), then "never succeeded", then the lag test,
 * then success. `run === null` is the only state that may say "not run yet". Bundles from a worker
 * that predates `usage_total` simply read as "no calls yet".
 */
export function llmStatus(w: WorkerState): LlmStatus {
  const calls = w.researcher.usage_total?.calls ?? 0;
  const run = parseTs(w.last_run_at);
  const ok = parseTs(w.last_success_at);
  const lifetime = `${pluralise(calls, 'call')} lifetime`;

  if (w.run_status === 'running') {
    return {
      tone: 'busy',
      label: 'run in progress',
      note: ok === null ? 'no successful run yet' : `last success ${fmtTimestamp(w.last_success_at)}`,
    };
  }
  if (run === null) {
    // Nothing has ever started. Calls may still have been billed by an earlier deploy's counter.
    return {
      tone: 'idle',
      label: 'not run yet',
      note: calls > 0 ? `${lifetime}, none from a recorded run` : 'the researcher has not billed a call',
    };
  }
  if (ok === null) {
    return {
      tone: 'fail',
      label: 'last run failed',
      note: calls > 0 ? `no successful run yet · ${lifetime}` : 'no successful run yet',
    };
  }
  if (run - ok > SUCCESS_LAG_MS) {
    return { tone: 'fail', label: 'last run failed', note: `no success since ${fmtTimestamp(w.last_success_at)}` };
  }
  if (calls > 0) return { tone: 'ok', label: 'LLM OK', note: lifetime };
  // The loop is healthy but the model was never needed — honest to say so rather than claim OK.
  return { tone: 'idle', label: 'no calls yet', note: 'the last run succeeded without billing one' };
}

function llmFact(w: WorkerState): string {
  const s = llmStatus(w);
  return (
    `<div class="rfact rfact--llm"><dt>LLM</dt><dd><span class="llm-dot llm-dot--${s.tone}" aria-hidden="true"></span>` +
    `${esc(s.label)}<small>${esc(s.note)}</small></dd></div>`
  );
}

function usageFacts(b: ResearcherBudget): string {
  return (
    fact('Calls', b.calls.toLocaleString('en-US')) +
    fact('Tokens in', b.tokens_in.toLocaleString('en-US')) +
    fact('Tokens out', b.tokens_out.toLocaleString('en-US')) +
    fact('Estimated cost', b.usd_estimate > 0 ? `$${b.usd_estimate.toFixed(2)}` : EN_DASH)
  );
}

/** One column of the usage grid: a small heading, then either the facts or a reason there are none. */
function usageBlock(title: string, b: ResearcherBudget | null | undefined, empty: string): HTMLElement {
  const box = el('div', { class: 'rusage__col' });
  box.append(el('h4', { class: 'rusage__title', text: title }));
  if (!b) box.append(el('p', { class: 'section-note rusage__empty', text: empty }));
  else {
    const dl = el('dl', { class: 'rfacts rfacts--tight' });
    dl.innerHTML = usageFacts(b);
    box.append(dl);
  }
  return box;
}

function evalTable(ctx: Ctx, ev: ResearcherEval): HTMLElement {
  const wrap = el('div', { class: 'table-wrap' });
  const table = el('table', { class: 'bt-table' });
  const rows = Object.entries(ev.by_lab) as [LabId, ResearcherEval['by_lab'][LabId]][];
  const body = rows
    .map(([labId, r]) => {
      const lab = ctx.labs.get(labId);
      return (
        `<tr><td><span class="rank-model"><span class="rank-dot" style="background:${esc(lab?.color ?? '#111')}"></span>` +
        `<span class="rank-model__lab">${esc(lab?.short ?? labId)}</span></span></td>` +
        `<td class="num">${r.gold}</td><td class="num">${r.found}</td><td class="num">${r.matched}</td>` +
        `<td class="num">${r.scores_matched} / ${r.scores_gold}</td></tr>`
      );
    })
    .join('');
  table.innerHTML =
    '<caption class="visually-hidden">Researcher output per lab, against the frozen gold set</caption>' +
    '<thead><tr><th scope="col">Lab</th><th scope="col" class="num">Gold</th><th scope="col" class="num">Found</th>' +
    '<th scope="col" class="num">Matched</th><th scope="col" class="num">Scores</th></tr></thead>' +
    `<tbody>${body || `<tr><td class="empty-note" colspan="5">No per-lab rows in this evaluation.</td></tr>`}</tbody>`;
  wrap.append(table);
  return wrap;
}

export function renderResearcher(ctx: Ctx): void {
  const host = maybe('[data-researcher]');
  if (!host) return;
  clear(host);

  const w = ctx.bundle.worker;
  const r = w.researcher;

  if (!ctx.researched) {
    const notice = el('p', { class: 'banner banner--warn' });
    notice.append(
      el('span', { class: 'banner__tag', text: 'Seed dataset' }),
      el('span', {
        text:
          'The researcher has not been promoted yet. Everything published here still comes from the frozen, human-curated seed; ' +
          'the OpenRouter researcher only replaces it once it passes the evaluation below.',
      }),
    );
    host.append(notice);
  }

  /* -------------------------------------------------------------- status */
  const status = el('dl', { class: 'rfacts' });
  status.innerHTML =
    fact('Status', w.run_status === 'running' ? 'running' : 'idle', w.run_step ?? `every ${w.interval_minutes} min`) +
    llmFact(w) +
    fact('Last run', fmtTimestamp(w.last_run_at), `last success ${fmtTimestamp(w.last_success_at)}`) +
    fact('Next run', fmtTimestamp(w.next_run_at)) +
    fact('Version', `v${r.version}`, w.llm_model ?? 'no extractor model recorded') +
    fact('Last backfill', fmtTimestamp(r.last_backfill_at)) +
    fact('Last LMArena', fmtTimestamp(r.last_arena_at));
  host.append(status);

  /* -------------------------------------------------- what changed last run */
  // The poll summary is the loop's hourly delta; the backfill summary is the last research run's.
  // Both are kept, because "nothing changed in the last poll" used to read as "the LLM is dead".
  const summary = el('p', { class: 'section-note rnote' });
  const pollLine = w.last_run_summary
    ? `<b>What changed last:</b> ${esc(w.last_run_summary)}`
    : '<b>What changed last:</b> nothing recorded yet.';
  const backfillLine = r.last_backfill_summary ? `<br /><b>Last research run:</b> ${esc(r.last_backfill_summary)}` : '';
  summary.innerHTML = pollLine + backfillLine;
  host.append(summary);

  /* ---------------------------------------------------------------- eval */
  const ev = r.eval;
  const evalHead = el('h3', { class: 'section-title rsub', text: 'Evaluation against the gold set' });
  host.append(evalHead);

  if (!ev) {
    host.append(
      el('p', {
        class: 'section-note',
        text: 'The researcher has not been evaluated yet — no precision, recall or quote-verification numbers to show.',
      }),
    );
  } else {
    const facts = el('dl', { class: 'rfacts' });
    facts.innerHTML =
      fact('Release precision', fmtPercent(ev.precision_releases, 1), `${ev.matched_releases} / ${ev.found_releases} found`) +
      fact('Release recall', fmtPercent(ev.recall_releases, 1), `${ev.matched_releases} / ${ev.gold_releases} gold`) +
      fact('Score recall', fmtPercent(ev.score_recall, 1), `${ev.matched_scores} / ${ev.gold_scores} scores`) +
      fact('Score MAE', ev.score_mae.toFixed(2), 'benchmark units') +
      fact('Quotes verified', fmtPercent(ev.quote_verified_rate, 1), `${ev.quotes_verified} / ${ev.quotes_total}`) +
      fact('Evaluated', fmtTimestamp(ev.evaluated_at));
    host.append(facts, evalTable(ctx, ev));
  }

  /* ----------------------------------------------------- OpenRouter usage */
  host.append(el('h3', { class: 'section-title rsub', text: 'OpenRouter usage' }));
  const usage = el('div', { class: 'rusage' });
  usage.append(
    usageBlock(
      'Lifetime',
      r.usage_total,
      'Lifetime totals are not recorded yet — the worker publishing this bundle predates the counter.',
    ),
    usageBlock('Last research run', r.budget, 'No research run (backfill or discovery) has been billed yet.'),
  );
  host.append(usage);
}
