/** The floating tooltip: one element, HTML built per hovered thing. */
import { addDays, ratingFromTheta, type FrontierGain, type LeadershipStripe, type ModelRelease, type PredictedRelease } from '@agi/shared';
import type { Ctx, SeriesPoint } from '../data';
import { qs } from '../dom';
import {
  EN_DASH,
  esc,
  fmtDate,
  fmtDatePrecision,
  fmtDays,
  fmtIndex,
  fmtPercent,
  precisionLabel,
} from '../ui/format';

export class Tooltip {
  private node: HTMLElement;
  private raf = 0;
  private pending: { x: number; y: number } | null = null;

  constructor(root: ParentNode = document) {
    this.node = qs('[data-tooltip]', root);
  }

  show(html: string, x: number, y: number): void {
    this.node.innerHTML = html;
    this.node.hidden = false;
    this.node.setAttribute('aria-hidden', 'false');
    this.node.classList.add('is-visible');
    this.move(x, y);
  }

  move(x: number, y: number): void {
    this.pending = { x, y };
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const p = this.pending;
      if (!p || this.node.hidden) return;
      const r = this.node.getBoundingClientRect();
      const pad = 14;
      let left = p.x + 16;
      let top = p.y - r.height - 14;
      if (left + r.width > window.innerWidth - pad) left = p.x - r.width - 16;
      if (left < pad) left = pad;
      if (top < pad) top = p.y + 20;
      if (top + r.height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - r.height - pad);
      this.node.style.left = `${Math.round(left)}px`;
      this.node.style.top = `${Math.round(top)}px`;
    });
  }

  hide(): void {
    this.node.classList.remove('is-visible');
    this.node.setAttribute('aria-hidden', 'true');
    this.node.hidden = true;
  }
}

/* --------------------------------------------------------------- builders */

function head(color: string, name: string, sub: string): string {
  return `<div class="tt-head"><span class="tt-dot" style="background:${esc(color)}"></span>
    <span class="tt-name">${esc(name)}</span></div>
    <p class="tt-sub">${esc(sub)}</p>`;
}

function rows(pairs: [string, string][]): string {
  return `<dl class="tt-rows">${pairs
    .map(([k, v]) => `<div class="tt-row"><dt>${esc(k)}</dt><dd>${v}</dd></div>`)
    .join('')}</dl>`;
}

export function releaseTooltip(ctx: Ctx, p: SeriesPoint): string {
  const lab = ctx.labs.get(p.release.lab);
  const total = ctx.indexBenchmarks.length;
  const provisional = p.mi.qualified
    ? ''
    : `<p class="tt-note">Provisional — only ${p.mi.n} of ${total} index benchmarks reported; off the lab line, and not used for the frontier or trend</p>`;
  return (
    head(lab?.color ?? '#111', p.release.name, `${lab?.name ?? p.release.lab} · ${fmtDatePrecision(p.release.date, p.release.date_precision)}`) +
    `<p class="tt-big">R ${Math.round(p.mi.rating).toLocaleString('en-US')}<small>index ${fmtIndex(p.mi.index)}</small></p>` +
    rows([
      ['Rating range', `${Math.round(p.mi.rating - 173.72 * p.mi.se)} ${EN_DASH} ${Math.round(p.mi.rating + 173.72 * p.mi.se)}`],
      ['Index range', `${fmtIndex(p.mi.indexLow)} ${EN_DASH} ${fmtIndex(p.mi.indexHigh)}`],
      ['Coverage', `${p.mi.n} / ${total} benchmarks`],
      ['Date precision', esc(precisionLabel(p.release.date_precision))],
    ]) +
    provisional +
    `<p class="tt-hint">Click for sources</p>`
  );
}

export function markerTooltip(ctx: Ctx, r: ModelRelease): string {
  const lab = ctx.labs.get(r.lab);
  const what =
    r.status === 'announced'
      ? 'Announced by the lab, not usable yet — it is not on the index.'
      : r.status === 'rumored'
        ? 'Credible reporting only, no lab confirmation — off the index.'
        : 'Announced and then dropped. Kept for history.';
  const pairs: [string, string][] = [
    ['Status', esc(r.status)],
    ['Expected', esc(fmtDatePrecision(r.date, r.date_precision))],
  ];
  if (r.expected_window) {
    pairs.push(['Window', `${esc(fmtDate(r.expected_window.start))} ${EN_DASH} ${esc(fmtDate(r.expected_window.end))}`]);
  }
  return (
    head(lab?.color ?? '#111', r.name, `${lab?.name ?? r.lab} · ${r.status}`) +
    rows(pairs) +
    `<p class="tt-note">Status: ${esc(r.status)} — its position on the y axis is indicative (no scores). ${esc(what)}</p>`
  );
}

export function predictionTooltip(ctx: Ctx, labId: string, pred: PredictedRelease, p30: number, p90: number): string {
  const lab = ctx.labs.get(labId as never);
  const announced = pred.source === 'announced';
  const title = announced
    ? `Announced next ${lab?.short ?? labId} flagship`
    : `Predicted next ${lab?.short ?? labId} flagship`;
  const ordinal = pred.k === 1 ? 'next' : pred.k === 2 ? 'second' : `${pred.k}th`;
  return (
    head(announced ? '#9AA0A6' : '#F5C400', title, `${ordinal} release · ${announced ? 'lab window' : 'log-normal cadence'}`) +
    `<p class="tt-big">${esc(fmtDate(pred.medianDate))}<small>median</small></p>` +
    rows([
      ['68% window', `${esc(fmtDate(pred.p16Date))} ${EN_DASH} ${esc(fmtDate(pred.p84Date))}`],
      ['90% window', `${esc(fmtDate(pred.p05Date))} ${EN_DASH} ${esc(fmtDate(pred.p95Date))}`],
      ['P(30 days)', fmtPercent(p30)],
      ['P(90 days)', fmtPercent(p90)],
      ['Expected rating', `${Math.round(ratingFromTheta(pred.thetaLow ?? pred.theta))} ${EN_DASH} ${Math.round(ratingFromTheta(pred.thetaHigh ?? pred.theta))}`],
      ['Expected index', `${fmtIndex(pred.indexLow)} ${EN_DASH} ${fmtIndex(pred.indexHigh)}`],
    ]) +
    `<p class="tt-hint">Circle diameter = the 68% window</p>`
  );
}

/** A released flagship with no score on any index benchmark — a tick on the timeline. */
export function tickTooltip(ctx: Ctx, r: ModelRelease): string {
  const lab = ctx.labs.get(r.lab);
  return (
    head(lab?.color ?? '#111', r.name, `${lab?.name ?? r.lab} · ${fmtDatePrecision(r.date, r.date_precision)}`) +
    `<p class="tt-note">Released, but it reported no score on any index benchmark — most of the basket did not exist yet. It sits on the timeline only and does not affect the index.</p>` +
    `<p class="tt-hint">Click for sources</p>`
  );
}

function quarterLabel(iso: string): string {
  const q = Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1;
  return `Q${q} ${iso.slice(0, 4)}`;
}

/** One shaded era of the pace strip. */
export function eraTooltip(d: { start: string; end: string | null; regime: string; meanPace: number; maxPace: number }): string {
  return (
    head('#9a9a9a', `${d.regime[0]?.toUpperCase() ?? ''}${d.regime.slice(1)}`, 'Pace era') +
    `<p class="tt-big">${d.meanPace.toFixed(1)}<small>logits / yr mean</small></p>` +
    rows([
      ['Peak pace', `${d.maxPace.toFixed(1)} logits / yr`],
      ['From', esc(fmtDate(d.start))],
      ['Until', d.end ? esc(fmtDate(d.end)) : 'still ' + esc(d.regime)],
    ]) +
    `<p class="tt-note">Dormant below 0.5 logits/yr, climb below 1.5, acceleration below 3, takeoff above.</p>`
  );
}

/** One bar of the pace strip. */
export function paceTooltip(d: FrontierGain): string {
  return (
    head('#111111', quarterLabel(d.start), 'Frontier gain, latent ability') +
    `<p class="tt-big">${d.gain > 0 ? '+' : ''}${d.gain.toFixed(2)}<small>logits</small></p>` +
    rows([
      ['Frontier steps', String(d.steps)],
      ['Period', `${esc(fmtDate(d.start))} ${EN_DASH} ${esc(fmtDate(addDays(d.end, -1)))}`],
    ]) +
    `<p class="tt-note">How far the running maximum of θ moved this quarter. One logit multiplies the odds of solving a basket item by e ≈ 2.7; the 0–100 index hides this near the top.</p>`
  );
}

export function stripeTooltip(ctx: Ctx, s: LeadershipStripe, endDate: string): string {
  const lab = ctx.labs.get(s.lab);
  const model = ctx.releasesById.get(s.release_id);
  const to = s.to ?? endDate;
  const days = Math.max(
    0,
    Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${s.from}T00:00:00Z`).getTime()) / 86_400_000),
  );
  return (
    head(lab?.color ?? '#111', lab?.name ?? s.lab, 'Frontier leadership') +
    `<p class="tt-big">${esc(fmtDays(days))}<small>in the lead</small></p>` +
    rows([
      ['Model', esc(model?.name ?? s.release_id)],
      ['Index', fmtIndex(s.index)],
      ['From', esc(fmtDate(s.from))],
      ['Until', s.to ? esc(fmtDate(s.to)) : 'still leading'],
    ])
  );
}
