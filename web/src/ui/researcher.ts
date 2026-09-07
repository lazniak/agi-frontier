/**
 * Researcher panel — what the automated researcher is doing and how well it does it
 * (REDESIGN §6, §7.1).
 *
 * Everything here is `bundle.worker`: the loop's schedule and current step, the evaluation of
 * the researcher against the frozen gold set, its call/token budget, and the one-line summary of
 * the last run. When nothing published came from the researcher yet, the panel says so rather
 * than implying the dataset is machine-produced.
 */
import type { LabId, ResearcherEval } from '@agi/shared';
import type { Ctx } from '../data';
import { clear, el, maybe } from '../dom';
import { EN_DASH, esc, fmtPercent, fmtTimestamp } from './format';

function fact(label: string, value: string, note?: string): string {
  return `<div class="rfact"><dt>${esc(label)}</dt><dd>${esc(value)}${note ? `<small>${esc(note)}</small>` : ''}</dd></div>`;
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
    fact('Last run', fmtTimestamp(w.last_run_at), `last success ${fmtTimestamp(w.last_success_at)}`) +
    fact('Next run', fmtTimestamp(w.next_run_at)) +
    fact('Version', `v${r.version}`, w.llm_model ?? 'no extractor model recorded') +
    fact('Last backfill', fmtTimestamp(r.last_backfill_at)) +
    fact('Last LMArena', fmtTimestamp(r.last_arena_at));
  host.append(status);

  /* -------------------------------------------------- what changed last run */
  const summary = el('p', { class: 'section-note rnote' });
  summary.innerHTML = w.last_run_summary
    ? `<b>What changed last:</b> ${esc(w.last_run_summary)}`
    : '<b>What changed last:</b> nothing recorded yet.';
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

  /* -------------------------------------------------------------- budget */
  host.append(el('h3', { class: 'section-title rsub', text: 'Budget' }));
  const budget = r.budget;
  if (!budget) {
    host.append(el('p', { class: 'section-note', text: 'No calls have been billed to the researcher yet.' }));
  } else {
    const b = el('dl', { class: 'rfacts' });
    b.innerHTML =
      fact('Calls', String(budget.calls)) +
      fact('Tokens in', budget.tokens_in.toLocaleString('en-US')) +
      fact('Tokens out', budget.tokens_out.toLocaleString('en-US')) +
      fact('Estimated cost', budget.usd_estimate > 0 ? `$${budget.usd_estimate.toFixed(2)}` : EN_DASH);
    host.append(b);
  }
}
