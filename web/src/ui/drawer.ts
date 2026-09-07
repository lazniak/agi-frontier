/**
 * The audit drawer: everything behind a single number.
 * Desktop = right-hand panel, mobile = bottom sheet (CSS decides).
 */
import type { ModelRelease, Score, Source } from '@agi/shared';
import type { Computed, Ctx } from '../data';
import { orderedScores, sourceCount } from '../data';
import type { Store } from '../state';
import { badge, qs } from '../dom';
import {
  EN_DASH,
  esc,
  fmtDate,
  fmtDatePrecision,
  fmtIndex,
  fmtNumber,
  fmtSigned,
  fmtTimestamp,
  precisionLabel,
  shortUrl,
} from './format';

export class Drawer {
  private root: HTMLElement;
  private scrim: HTMLElement;
  private body: HTMLElement;
  private title: HTMLElement;
  private eyebrow: HTMLElement;
  private lastFocus: HTMLElement | null = null;

  constructor(private ctx: Ctx, private store: Store) {
    this.root = qs('[data-drawer]');
    this.scrim = qs('[data-drawer-scrim]');
    this.body = qs('[data-drawer-body]', this.root);
    this.title = qs('[data-drawer-title], #drawer-title', this.root);
    this.eyebrow = qs('[data-drawer-eyebrow]', this.root);

    qs('[data-drawer-close]', this.root).addEventListener('click', () => this.store.select(null));
    this.scrim.addEventListener('click', () => this.store.select(null));
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !this.root.hidden) {
        ev.preventDefault();
        this.store.select(null);
      }
    });
  }

  sync(computed: Computed): void {
    const id = this.store.get().selected;
    if (!id) return this.close();
    const release = this.ctx.releasesById.get(id);
    if (!release) return this.close();
    this.open(release, computed);
  }

  private close(): void {
    if (this.root.hidden) return;
    this.root.classList.remove('is-open');
    this.scrim.classList.remove('is-open');
    const done = (): void => {
      if (this.store.get().selected) return;
      this.root.hidden = true;
      this.scrim.hidden = true;
    };
    window.setTimeout(done, 380);
    this.lastFocus?.focus?.();
    this.lastFocus = null;
  }

  private open(release: ModelRelease, computed: Computed): void {
    if (this.root.hidden) {
      const active = document.activeElement;
      this.lastFocus = active instanceof HTMLElement ? active : null;
      this.root.hidden = false;
      this.scrim.hidden = false;
      // next frame so the transform transition actually runs
      requestAnimationFrame(() => {
        this.root.classList.add('is-open');
        this.scrim.classList.add('is-open');
      });
    }

    const lab = this.ctx.labs.get(release.lab);
    this.eyebrow.innerHTML =
      `<span class="rank-dot" style="background:${esc(lab?.color ?? '#111')}"></span>` +
      `${esc(lab?.name ?? release.lab)} · ${esc(release.status)}`;
    this.title.textContent = release.name;
    this.body.innerHTML = this.content(release, computed);
    this.body.scrollTop = 0;
    this.body.focus({ preventScroll: true });
  }

  private content(release: ModelRelease, c: Computed): string {
    const mi = c.fit.models[release.id];
    const basket = this.ctx.indexBenchmarks;

    const facts: string[] = [];
    if (mi) {
      facts.push(fact('Frontier Index', `${fmtIndex(mi.index)}<small> ± ${mi.se.toFixed(2)} θ</small>`));
      facts.push(fact('Range', `<small>${fmtIndex(mi.indexLow)} ${EN_DASH} ${fmtIndex(mi.indexHigh)}</small>`));
      facts.push(fact('Coverage', `${mi.n}<small> / ${basket.length}</small>`));
      facts.push(fact('θ (ability)', fmtSigned(mi.theta)));
    } else {
      facts.push(fact('Frontier Index', `<small>${release.status === 'released' ? 'no official index score' : 'not on the index'}</small>`));
    }
    facts.push(fact('Released', `<small>${esc(fmtDatePrecision(release.date, release.date_precision))}</small>`));
    facts.push(fact('Sources', String(sourceCount(release))));

    const window = release.expected_window
      ? `<div class="dblock"><h3 class="dblock__title">Expected window</h3>
          <p class="method-copy">${esc(fmtDate(release.expected_window.start))} ${EN_DASH} ${esc(fmtDate(release.expected_window.end))}</p>
          ${sourceCard(release.expected_window.source)}</div>`
      : '';

    const scores = orderedScores(this.ctx, release);
    const scoreTable = scores.length
      ? `<table class="dtable">
          <thead><tr><th>Benchmark</th><th class="num">Value</th><th class="num">Fit</th></tr></thead>
          <tbody>${scores.map((s) => this.scoreRow(s, release, c)).join('')}</tbody>
        </table>`
      : `<p class="method-copy">No benchmark scores recorded for this model.</p>`;

    const notes = release.notes
      ? `<div class="dblock"><h3 class="dblock__title">Notes</h3><p class="dnote">${esc(release.notes)}</p></div>`
      : '';

    const extra = (release.sources ?? []).length
      ? `<div class="dblock"><h3 class="dblock__title">Supporting sources</h3>
          ${(release.sources ?? []).map(sourceCard).join('')}</div>`
      : '';

    return (
      `<div class="dblock"><dl class="dfacts">${facts.join('')}</dl>
        <p class="method-copy" style="margin-top:14px">${esc(precisionLabel(release.date_precision))} · family ${esc(release.family)}${
          mi ? ` · residual σ of the whole fit ${c.fit.residualSigma.toFixed(3)}` : ''
        }</p></div>` +
      `<div class="dblock"><h3 class="dblock__title">Announcement</h3>${sourceCard(release.announcement)}</div>` +
      window +
      `<div class="dblock"><h3 class="dblock__title">All reported scores</h3>${scoreTable}</div>` +
      extra +
      notes +
      `<p class="dfoot"><a class="link-out" href="/latest.json" download>Download JSON</a>
        <a class="link-out" href="https://github.com/lazniak/agi-frontier/blob/main/docs/METHODOLOGY.md" rel="noopener">Methodology</a></p>`
    );
  }

  private scoreRow(s: Score, release: ModelRelease, c: Computed): string {
    const b = this.ctx.benchmarks.get(s.benchmark);
    const mi = c.fit.models[release.id];
    const used = mi?.used.find((u) => u.benchmark === s.benchmark && u.value === s.value);
    const delta = c.fit.difficulties[s.benchmark];

    const badges =
      (b?.in_index ? badge('index', 'in index') : badge('off', 'not fitted')) +
      (b?.legacy ? badge('legacy', 'legacy') : '') +
      (s.reported_by === 'official' ? badge('official', 'official') : badge('maintainer', 'maintainer')) +
      (s.source.verified ? badge('verified', 'verified') : badge('unverified', 'unverified'));

    const fitCell = used
      ? `<div>δ ${fmtSigned(delta ?? 0)}</div><span class="dscore__resid">predicted ${fmtNumber(used.predicted)} · residual ${fmtSigned(used.residual)}</span>`
      : b?.in_index
        ? `<span class="dscore__resid">not used in the fit</span>`
        : `<span class="dscore__resid">${EN_DASH}</span>`;

    return `<tr>
      <td>
        <div class="dscore__name">${esc(b?.name ?? s.benchmark)} ${badges}</div>
        <div class="dscore__config">${esc(s.config ?? 'configuration not recorded')}${s.note ? ` · ${esc(s.note)}` : ''}</div>
        ${s.source.quote ? `<p class="dscore__quote">${esc(s.source.quote)}</p>` : ''}
        <div class="dsource__meta" style="margin-top:6px">
          <a class="dsource__link" href="${esc(s.source.url)}" rel="noopener nofollow">${esc(shortUrl(s.source.url, 44))}</a>
          <span>retrieved ${esc(fmtTimestamp(s.source.retrieved_at))}</span>
        </div>
      </td>
      <td class="num"><span class="dscore__value">${fmtNumber(s.value)}</span><span class="dscore__resid">%</span></td>
      <td class="num">${fitCell}</td>
    </tr>`;
  }
}

function fact(label: string, valueHtml: string): string {
  return `<div class="dfact"><dt>${esc(label)}</dt><dd>${valueHtml}</dd></div>`;
}

function sourceCard(s: Source): string {
  return `<div class="dsource">
    <p class="dsource__title">${esc(s.title ?? shortUrl(s.url))}</p>
    ${s.quote ? `<blockquote class="dsource__quote">${esc(s.quote)}</blockquote>` : ''}
    <a class="dsource__link" href="${esc(s.url)}" rel="noopener nofollow">${esc(shortUrl(s.url))}</a>
    <div class="dsource__meta" style="margin-top:8px">
      <span>retrieved ${esc(fmtTimestamp(s.retrieved_at))}</span>
      ${s.verified ? badge('verified', `verified ${s.verified_at ? fmtTimestamp(s.verified_at) : ''}`.trim()) : badge('unverified', 'quote not re-checked')}
      ${s.via ? `<span>via ${esc(s.via)}</span>` : ''}
    </div>
  </div>`;
}
