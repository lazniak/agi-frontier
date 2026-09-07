/** Rankings table — current flagships as of the scrubbed date, sorted by Frontier Index. */
import { MIN_QUALIFIED_SCORES } from '@agi/shared';
import type { Computed, Ctx } from '../data';
import { sourceCount } from '../data';
import { badge, clear, qs } from '../dom';
import { esc, fmtDate, fmtIndex, fmtNumber, precisionLabel } from './format';

const COLUMNS = 7;

export function renderRankings(ctx: Ctx, c: Computed, onSelect: (id: string) => void): void {
  const table = qs<HTMLTableElement>('[data-rankings]');
  const body = table.tBodies[0];
  if (!body) return;
  clear(body);

  if (c.rankings.length === 0) {
    const tr = body.insertRow();
    const td = tr.insertCell();
    td.colSpan = COLUMNS;
    td.className = 'empty-note';
    td.textContent = c.ok
      ? 'No released flagship has an official index score as of this date.'
      : 'The index could not be computed.';
    return;
  }

  const basket = ctx.indexBenchmarks;
  // `rankCurrentFlagships` returns qualified first, then provisional, so one divider before the
  // first provisional row is enough. Rank numbers keep counting straight through it.
  let dividerDone = false;

  c.rankings.forEach((mi, i) => {
    const release = ctx.releasesById.get(mi.release_id);
    if (!release) return;
    const lab = ctx.labs.get(mi.lab);
    const used = new Map(mi.used.map((u) => [u.benchmark, u]));

    if (!mi.qualified && !dividerDone) {
      dividerDone = true;
      const divider = document.createElement('tr');
      divider.className = 'rank-divider';
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

    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    tr.setAttribute('role', 'button');
    if (!mi.qualified) tr.className = 'rank-row--provisional';
    tr.setAttribute(
      'aria-label',
      `Audit ${release.name}, rank ${i + 1}, index ${fmtIndex(mi.index)}${mi.qualified ? '' : ', provisional'}`,
    );
    tr.innerHTML =
      `<td class="num rank-cell-rank">${i + 1}</td>` +
      `<td><span class="rank-model"><span class="rank-dot" style="background:${esc(lab?.color ?? '#111')}"></span>
        <span><span class="rank-model__name">${esc(release.name)}</span>${mi.qualified ? '' : ` ${badge('provisional', 'provisional')}`}<br />
        <span class="rank-model__lab">${esc(lab?.short ?? mi.lab)}</span></span></span></td>` +
      `<td class="rank-date">${esc(fmtDate(release.date))}<small>${esc(precisionLabel(release.date_precision))}</small></td>` +
      `<td class="num"><span class="rank-index">${fmtIndex(mi.index)}</span><span class="rank-se">± ${mi.se.toFixed(2)}</span></td>` +
      `<td class="num rank-coverage">${mi.n}/${basket.length}
        <span class="coverage-bar"><span style="width:${(mi.coverage * 100).toFixed(0)}%"></span></span></td>` +
      `<td><span class="bchips">${chips}</span></td>` +
      `<td class="num">${sourceCount(release)}</td>`;

    tr.addEventListener('click', () => onSelect(mi.release_id));
    tr.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        onSelect(mi.release_id);
      }
    });
    body.append(tr);
  });
}
