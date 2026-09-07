/** Release watch — one card per lab: last flagship, P(30/90 d), median window, sparkline. */
import type { LabView } from '../data';
import type { Computed, Ctx } from '../data';
import { clear, qs, svg } from '../dom';
import { EN_DASH, esc, fmtDate, fmtDays, fmtIndex, fmtPercent, pluralise } from './format';

const SPARK_W = 240;
const SPARK_H = 34;

function sparkline(view: LabView): SVGSVGElement {
  const node = svg('svg', {
    class: 'spark',
    viewBox: `0 0 ${SPARK_W} ${SPARK_H}`,
    preserveAspectRatio: 'none',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  const pts = view.points;
  if (pts.length < 2) return node;

  const t0 = Date.parse(`${pts[0]!.release.date}T00:00:00Z`);
  const t1 = Date.parse(`${pts[pts.length - 1]!.release.date}T00:00:00Z`);
  const span = Math.max(1, t1 - t0);
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) {
    lo = Math.min(lo, p.mi.index);
    hi = Math.max(hi, p.mi.index);
  }
  const range = Math.max(1, hi - lo);
  const px = (i: number): number => ((Date.parse(`${pts[i]!.release.date}T00:00:00Z`) - t0) / span) * (SPARK_W - 6) + 3;
  const py = (i: number): number => SPARK_H - 4 - ((pts[i]!.mi.index - lo) / range) * (SPARK_H - 8);

  let d = '';
  for (let i = 0; i < pts.length; i++) d += `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(i).toFixed(1)}`;
  node.append(svg('path', { class: 'spark__line', d, 'vector-effect': 'non-scaling-stroke' }));
  node.append(svg('circle', { class: 'spark__dot', cx: px(pts.length - 1), cy: py(pts.length - 1), r: 2.2 }));
  return node;
}

function probRow(label: string, p: number): string {
  const pct = Math.max(0, Math.min(1, p));
  return `<div class="prob__row"><span>${esc(label)}</span>
    <span class="prob__bar"><span class="prob__fill" style="width:${(pct * 100).toFixed(1)}%"></span></span>
    <span class="prob__val">${fmtPercent(pct)}</span></div>`;
}

export function renderWatch(ctx: Ctx, c: Computed, onSelect: (id: string) => void): void {
  const host = qs('[data-watch]');
  clear(host);

  const views = [...c.labViews].sort((a, b) => {
    const pa = a.predictions[0]?.medianDate ?? '9999-12-31';
    const pb = b.predictions[0]?.medianDate ?? '9999-12-31';
    return pa < pb ? -1 : pa > pb ? 1 : a.lab.name.localeCompare(b.lab.name);
  });

  for (const v of views) {
    const card = document.createElement('article');
    card.className = `watch-card${v.last ? '' : ' watch-card--empty'}`;
    card.style.setProperty('--lab', v.lab.color);

    const f = v.forecast;
    const pred = v.predictions[0];
    const days = f && f.lastRelease ? f.elapsedDays : null;

    const head = `<div class="watch-card__head">
        <h3 class="watch-card__lab">${esc(v.lab.short)}</h3>
        <span class="watch-card__age">${days === null ? '' : `${esc(fmtDays(days))} ago`}</span>
      </div>`;

    const model = v.last
      ? `<div><p class="watch-card__model">${esc(v.last.release.name)}</p>
         <p class="watch-card__index">Index ${fmtIndex(v.last.mi.index)} · ${esc(fmtDate(v.last.release.date))} · ${pluralise(v.last.mi.n, 'benchmark')}</p></div>`
      : `<div><p class="watch-card__model">No released flagship yet</p>
         <p class="watch-card__index">Nothing to forecast from.</p></div>`;

    const probs = f && f.lastRelease
      ? `<div class="prob">${probRow('30 days', f.p30)}${probRow('90 days', f.p90)}</div>`
      : '';

    const nextBlock = pred
      ? `<div class="watch-card__next">
          <b>${esc(fmtDate(pred.medianDate))}</b> median${pred.source === 'announced' ? ' (lab window)' : ''}<br />
          68% window ${esc(fmtDate(pred.p16Date))} ${EN_DASH} ${esc(fmtDate(pred.p84Date))}<br />
          expected index <b>${fmtIndex(pred.indexLow)} ${EN_DASH} ${fmtIndex(pred.indexHigh)}</b>
        </div>`
      : '';

    const announced = v.markers.filter((m) => m.status === 'announced' || m.status === 'rumored');
    const annBlock = announced.length
      ? `<p class="watch-card__announced">${announced
          .map((m) => `${esc(m.name)} (${esc(m.status)})`)
          .join(', ')}</p>`
      : '';

    card.innerHTML = head + model + probs + nextBlock + annBlock;
    if (v.points.length > 1) card.append(sparkline(v));

    if (v.last) {
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `Audit ${v.last.release.name}`);
      const id = v.last.release.id;
      card.addEventListener('click', () => onSelect(id));
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          onSelect(id);
        }
      });
    }

    host.append(card);
  }

  void ctx;
}
