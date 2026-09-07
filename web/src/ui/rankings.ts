/**
 * Rankings — the current model per lab as of the scrubbed date, led by the Frontier Rating.
 *
 * The tier filter is the same `store.tierView` the chart uses, so flipping it here also changes
 * what the chart draws (REDESIGN §3): `flagship` ranks each lab's most capable tier, `all` ranks
 * whatever each lab shipped most recently and adds a one-line summary of the family band under
 * the lab's row.
 */
import { MIN_QUALIFIED_SCORES } from '@agi/shared';
import type { LabId, ModelIndex, ModelTier } from '@agi/shared';
import type { Computed, Ctx, SeriesPoint } from '../data';
import { announce, badge, clear, el, maybe, qs } from '../dom';
import type { Store, TierView } from '../state';
import { EN_DASH, esc, fmtDate, fmtIndex, fmtNumber, fmtRating, fmtRatingSe, precisionLabel } from './format';

const COLUMNS = 6;

const TIER_OPTIONS: { value: TierView; label: string; title: string }[] = [
  { value: 'flagship', label: 'Flagship', title: 'Only each lab’s most capable tier' },
  { value: 'all', label: 'All tiers', title: 'Whatever each lab shipped most recently, mid and small included' },
];

/** Build the tier filter once; `renderRankings` keeps its `aria-checked` in sync. */
export function initRankingsFilter(store: Store): void {
  const host = maybe('[data-rankings-tiers]');
  if (!host) return;
  clear(host);
  for (const opt of TIER_OPTIONS) {
    const b = el('button', {
      type: 'button',
      class: 'seg__btn',
      role: 'radio',
      'aria-checked': 'false',
      'data-value': opt.value,
      title: opt.title,
      text: opt.label,
    });
    b.addEventListener('click', () => {
      store.setTierView(opt.value);
      announce(opt.value === 'flagship' ? 'Rankings: flagship tier only' : 'Rankings: every tier');
    });
    host.append(b);
  }
}

function syncFilter(store: Store): void {
  const host = maybe('[data-rankings-tiers]');
  if (!host) return;
  const current = store.get().tierView;
  for (const b of Array.from(host.querySelectorAll<HTMLButtonElement>('button[data-value]'))) {
    const on = b.dataset.value === current;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
}

/** The lab's current lineup: the newest release in each tier it still ships. */
function lineup(c: Computed, lab: LabId): SeriesPoint[] {
  const view = c.byLab.get(lab);
  if (!view) return [];
  const byTier = new Map<ModelTier, SeriesPoint>();
  for (const p of view.points) byTier.set('flagship', p);
  for (const p of view.tiers) byTier.set(p.mi.tier, p);
  return [...byTier.values()];
}

export function renderRankings(ctx: Ctx, c: Computed, store: Store, onSelect: (id: string) => void): void {
  syncFilter(store);

  const table = qs<HTMLTableElement>('[data-rankings]');
  const body = table.tBodies[0];
  if (!body) return;
  clear(body);

  const showAll = store.get().tierView === 'all';
  const rows: ModelIndex[] = showAll ? c.rankingsAll : c.rankings;

  const caption = maybe('[data-rankings-note]');
  if (caption) {
    caption.textContent = showAll
      ? 'The newest released model per lab, whatever its tier, ranked by Frontier Rating. Mid and small models carry a tier badge and a family line showing the lab’s current lineup. Select a row to open its audit.'
      : 'The newest released flagship per lab, ranked by Frontier Rating — 400 points is ten times the odds of solving an average basket item. Coverage is how many index benchmarks the lab reported. Select a row to open its audit.';
  }

  if (rows.length === 0) {
    const tr = body.insertRow();
    const td = tr.insertCell();
    td.colSpan = COLUMNS;
    td.className = 'empty-note';
    td.textContent = c.ok
      ? 'No released model has an official index score as of this date.'
      : 'The index could not be computed.';
    return;
  }

  const basket = ctx.indexBenchmarks;
  // `rankCurrentFlagships` returns qualified first, then provisional, so one divider before the
  // first provisional row is enough. Rank numbers keep counting straight through it.
  let dividerDone = false;
  const familyDone = new Set<LabId>();

  rows.forEach((mi, i) => {
    const release = ctx.releasesById.get(mi.release_id);
    if (!release) return;
    const lab = ctx.labs.get(mi.lab);
    const used = new Map(mi.used.map((u) => [u.benchmark, u]));

    if (!mi.qualified && !dividerDone) {
      dividerDone = true;
      const divider = el('tr', { class: 'rank-divider' });
      divider.innerHTML = `<td colspan="${COLUMNS}">Provisional (fewer than ${MIN_QUALIFIED_SCORES} index benchmarks)</td>`;
      body.append(divider);
    }

    const chips = basket
      .map((b) => {
        const u = used.get(b.id);
        return u
          ? `<span class="bchip" title="${esc(b.name)} — ${esc(u.config ?? 'no configuration recorded')}">${esc(b.short)} ${fmtNumber(u.value)}</span>`
          : `<span class="bchip bchip--missing" title="${esc(b.name)} — not reported">${esc(b.short)}</span>`;
      })
      .join('');

    const tier = mi.tier;
    const tr = el('tr');
    tr.tabIndex = 0;
    tr.setAttribute('role', 'button');
    if (!mi.qualified) tr.className = 'rank-row--provisional';
    tr.setAttribute(
      'aria-label',
      `Audit ${release.name}, rank ${i + 1}, rating ${fmtRating(mi.rating)}${mi.qualified ? '' : ', provisional'}`,
    );
    tr.innerHTML =
      `<td class="num rank-cell-rank">${i + 1}</td>` +
      `<td><span class="rank-model"><span class="rank-dot" style="background:${esc(lab?.color ?? '#111')}"></span>
        <span><span class="rank-model__name">${esc(release.name)}</span>${
          tier === 'flagship' ? '' : ` ${badge('tier', tier)}`
        }${mi.qualified ? '' : ` ${badge('provisional', 'provisional')}`}<br />
        <span class="rank-model__lab">${esc(lab?.short ?? mi.lab)}</span></span></span></td>` +
      `<td class="num"><span class="rank-rating">${esc(fmtRating(mi.rating))}</span><span class="rank-se">${esc(fmtRatingSe(mi.se))}</span></td>` +
      `<td class="num"><span class="rank-index">${fmtIndex(mi.index)}</span></td>` +
      `<td><span class="rank-coverage">${mi.n}/${basket.length}
        <span class="coverage-bar"><span style="width:${(mi.coverage * 100).toFixed(0)}%"></span></span></span>
        <span class="bchips">${chips}</span></td>` +
      `<td class="rank-date">${esc(fmtDate(release.date))}<small>${esc(precisionLabel(release.date_precision))}</small></td>`;

    tr.addEventListener('click', () => onSelect(mi.release_id));
    tr.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        onSelect(mi.release_id);
      }
    });
    body.append(tr);

    // One family line per lab, under its best row, and only where the extra tiers are on show.
    if (showAll && !familyDone.has(mi.lab)) {
      familyDone.add(mi.lab);
      const family = lineup(c, mi.lab);
      if (family.length > 1) {
        const ratings = family.map((p) => p.mi.rating);
        const lo = Math.min(...ratings);
        const hi = Math.max(...ratings);
        const line = el('tr', { class: 'rank-family' });
        line.innerHTML =
          `<td colspan="${COLUMNS}">Family: ${family.length} models · band ${esc(fmtRating(lo))} ${EN_DASH} ${esc(fmtRating(hi))}` +
          ` · ${esc(family.map((p) => p.release.name).join(', '))}</td>`;
        body.append(line);
      }
    }
  });
}
