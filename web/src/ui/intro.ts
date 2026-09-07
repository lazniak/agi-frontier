/** The three live stats above the chart, plus the header "as of" stamp. */
import type { Computed, Ctx } from '../data';
import { clear, el, maybe, qs } from '../dom';
import { EN_DASH, esc, fmtDate, fmtIndex, fmtPercent, fmtTimestamp, pluralise } from './format';

export function renderStamp(ctx: Ctx): void {
  const stamp = maybe('[data-generated]');
  const text = maybe('[data-generated-text]');
  if (!stamp || !text) return;
  text.textContent = ctx.synthetic
    ? `synthetic fixture · generated ${fmtTimestamp(ctx.bundle.generated_at)}`
    : `as of ${fmtTimestamp(ctx.bundle.generated_at)}`;
  stamp.setAttribute('data-synthetic', String(ctx.synthetic));
  stamp.setAttribute('title', ctx.synthetic ? 'Development fixture — not real data' : 'Bundle generation time (UTC)');
}

function value(node: HTMLElement, main: string, unit?: string): void {
  clear(node);
  node.append(document.createTextNode(main));
  if (unit) node.append(el('span', { class: 'stat__unit', text: unit }));
}

export function renderStats(ctx: Ctx, c: Computed): void {
  const idx = qs('[data-stat="index"]');
  // The first stat's label has to follow the scrubber, or it claims "today" while showing 2025.
  const idxLabel = idx.parentElement?.querySelector('.stat__label');
  if (idxLabel) {
    idxLabel.textContent = c.asOf === ctx.today ? 'Frontier Index today' : `Frontier Index on ${fmtDate(c.asOf)}`;
  }
  const idxMeta = qs('[data-stat="index-meta"]');
  const vel = qs('[data-stat="velocity"]');
  const velMeta = qs('[data-stat="velocity-meta"]');
  const next = qs('[data-stat="next"]');
  const nextMeta = qs('[data-stat="next-meta"]');

  // 1 — the frontier itself. `c.top` is the last knot of the frontier line, which `frontierLine`
  // builds from qualified models only, so this number can never come from a provisional release.
  if (c.top) {
    const lab = ctx.labs.get(c.top.release.lab);
    value(idx, fmtIndex(c.top.mi.index));
    idxMeta.innerHTML =
      `<span class="stat__lab" style="color:${esc(lab?.color ?? '#111')}"><span class="stat__dot"></span></span>` +
      `<b>${esc(c.top.release.name)}</b> · ${esc(lab?.name ?? c.top.release.lab)} · released ${esc(fmtDate(c.top.release.date))}`;
  } else {
    value(idx, EN_DASH);
    idxMeta.textContent = c.topProvisional
      ? 'No qualified model yet — every released flagship reports fewer than three index benchmarks.'
      : 'No released model has an official index score yet.';
  }
  renderProvisionalFootnote(idx, c);

  // 2 — how fast it is moving. In latent ability (logits), not index points: near the top of
  //     the 0–100 scale the index slope shrinks by construction and would read as a slowdown.
  if (!c.pace) {
    value(vel, EN_DASH);
    velMeta.textContent = 'Fewer than two frontier steps in the trailing year.';
  } else {
    const v = c.pace.logitsPerYear;
    value(vel, `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`, 'logits / yr');
    const doubling =
      c.pace.doublingDays && c.pace.doublingDays < 3650
        ? `Odds of solving a basket item double every <b>${(c.pace.doublingDays / 30.4375).toFixed(1)} months</b> · `
        : '';
    velMeta.innerHTML = `${doubling}slope of the running maximum in latent ability over the trailing 365 days${
      c.frontier.length ? ` · <b>${c.frontier.length}</b> frontier steps so far` : ''
    }.`;
  }

  // 3 — what is coming
  if (c.nextUp) {
    const { lab, pred, forecast } = c.nextUp;
    value(next, fmtDate(pred.medianDate));
    next.classList.add('stat__value--sm');
    nextMeta.innerHTML =
      `<span class="stat__lab" style="color:${esc(lab.color)}"><span class="stat__dot"></span></span>` +
      `<b>${esc(lab.name)}</b> · ${pred.source === 'announced' ? 'announced window' : 'median forecast'} · ` +
      `P(30 d) <b>${fmtPercent(forecast.p30)}</b> · P(90 d) <b>${fmtPercent(forecast.p90)}</b>`;
  } else {
    value(next, EN_DASH);
    next.classList.add('stat__value--sm');
    nextMeta.textContent = 'Not enough release history to forecast a next flagship.';
  }
}

/**
 * A provisional release can out-score the frontier leader on raw index — it is fitted from too
 * few benchmarks to be believed, but it is visible on the chart, so say so rather than let the
 * reader think the headline number is stale.
 */
function renderProvisionalFootnote(idx: HTMLElement, c: Computed): void {
  const host = idx.parentElement;
  if (!host) return;
  host.querySelector('.stat__foot')?.remove();

  const p = c.topProvisional;
  if (!p) return;
  if (c.top && p.mi.index <= c.top.mi.index) return;

  const foot = el('p', { class: 'stat__foot' });
  foot.innerHTML =
    `Provisional: <b>${esc(p.release.name)}</b> shows <b>${fmtIndex(p.mi.index)}</b> on ` +
    `${pluralise(p.mi.n, 'benchmark')}`;
  host.append(foot);
}

export function renderWorkerHealth(ctx: Ctx): void {
  const w = ctx.bundle.worker;
  const set = (key: string, text: string): void => {
    const node = maybe(`[data-worker="${key}"]`);
    if (node) node.textContent = text;
  };
  set('last_run', fmtTimestamp(w.last_run_at));
  set('last_success', fmtTimestamp(w.last_success_at));
  set('polled', `${w.pages_polled} polled · ${w.pages_changed} changed`);
  set('llm', w.llm_model ?? 'none recorded');
}

/** A one-line notice under the intro (synthetic data, or a maths failure). */
export function renderNotice(ctx: Ctx, c: Computed): void {
  const host = qs('.section--intro .shell');
  for (const old of Array.from(host.querySelectorAll('.banner'))) old.remove();

  const add = (tag: string, text: string, warn: boolean): void => {
    const b = el('p', { class: `banner${warn ? ' banner--warn' : ''}` });
    b.append(el('span', { class: 'banner__tag', text: tag }), el('span', { text }));
    host.append(b);
  };

  if (!c.ok && c.error) {
    add('Compute error', `The shared maths module failed: ${c.error}`, true);
  }
  if (ctx.synthetic) {
    add(
      'Synthetic',
      'This build is showing the development fixture — plausible shapes, invented numbers. Nothing here is a real benchmark result.',
      true,
    );
  }
}
