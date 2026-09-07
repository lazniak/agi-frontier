/**
 * Backtest card — "how the forecast made on <asOf> did" (REDESIGN §5, §7.1).
 *
 * Two halves. The per-lab table is replayed live at the scrubbed date (`c.backtest.rows`): what
 * the cadence model predicted then, what actually shipped, and whether the truth fell inside the
 * window. Under it, the worker's whole-history report (`c.backtest.report`) — coverage against
 * its nominal targets, the error summary, and the calibration curve that says whether the
 * quantiles mean what they claim.
 *
 * The section is only shown while the scrubber is off today; on today there is nothing to score.
 */
import type { BacktestReport, BacktestRow } from '@agi/shared';
import type { Computed, Ctx } from '../data';
import { clear, el, maybe } from '../dom';
import { EN_DASH, esc, fmtDate, fmtNumber, fmtPercent, fmtSignedDays } from './format';

const COLUMNS = 5;

/** `drift` and `driftPerYear` landed after the first bundles — render them only when present. */
interface MaybeDrift {
  drift?: unknown;
  driftPerYear?: unknown;
}

function hitBadge(row: BacktestRow): string {
  if (row.predictedMedian === null) {
    return '<span class="badge badge--off">no forecast</span>';
  }
  if (row.actual === null) {
    return '<span class="badge badge--off">no release yet</span>';
  }
  if (row.in68) return '<span class="badge badge--hit68">68 %</span>';
  if (row.in90) return '<span class="badge badge--hit90">90 %</span>';
  return '<span class="badge badge--miss">miss</span>';
}

/** Nominal vs observed, with the perfect-calibration diagonal behind it. */
function calibrationCurve(report: BacktestReport): SVGSVGElement | null {
  const pts = report.calibration ?? [];
  if (pts.length < 2) return null;
  const S = 120;
  const pad = 10;
  const px = (v: number): number => pad + v * (S - 2 * pad);
  const py = (v: number): number => S - pad - v * (S - 2 * pad);

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'calib');
  svg.setAttribute('viewBox', `0 0 ${S} ${S}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute(
    'aria-label',
    'Calibration curve: the share of releases that landed at or before each nominal quantile date, against the diagonal of perfect calibration.',
  );

  const frame = document.createElementNS(ns, 'rect');
  frame.setAttribute('class', 'calib__frame');
  frame.setAttribute('x', String(pad));
  frame.setAttribute('y', String(pad));
  frame.setAttribute('width', String(S - 2 * pad));
  frame.setAttribute('height', String(S - 2 * pad));
  svg.append(frame);

  const diag = document.createElementNS(ns, 'line');
  diag.setAttribute('class', 'calib__diag');
  diag.setAttribute('x1', String(px(0)));
  diag.setAttribute('y1', String(py(0)));
  diag.setAttribute('x2', String(px(1)));
  diag.setAttribute('y2', String(py(1)));
  svg.append(diag);

  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.nominal).toFixed(1)},${py(p.observed).toFixed(1)}`).join('');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('class', 'calib__line');
  path.setAttribute('d', d);
  svg.append(path);

  for (const p of pts) {
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('class', 'calib__dot');
    dot.setAttribute('cx', px(p.nominal).toFixed(1));
    dot.setAttribute('cy', py(p.observed).toFixed(1));
    dot.setAttribute('r', '2');
    const title = document.createElementNS(ns, 'title');
    title.textContent = `nominal ${fmtPercent(p.nominal)} → observed ${fmtPercent(p.observed)}`;
    dot.append(title);
    svg.append(dot);
  }
  return svg;
}

function fact(label: string, value: string, note?: string): string {
  return (
    `<div class="bfact"><dt>${esc(label)}</dt>` +
    `<dd>${esc(value)}${note ? `<small>${esc(note)}</small>` : ''}</dd></div>`
  );
}

export function renderBacktest(ctx: Ctx, c: Computed): void {
  const section = maybe('#backtest');
  const host = maybe('[data-backtest]');
  if (!section || !host) return;

  const scrubbed = c.asOf !== ctx.today;
  section.hidden = !scrubbed;
  if (!scrubbed) {
    clear(host);
    return;
  }

  clear(host);

  const title = maybe('[data-backtest-title]');
  if (title) title.textContent = `How the forecast made on ${fmtDate(c.asOf)} did`;

  /* ------------------------------------------------------------ per-lab rows */
  const rows = c.backtest.rows ?? [];
  const wrap = el('div', { class: 'table-wrap' });
  const table = el('table', { class: 'bt-table' });
  table.innerHTML =
    '<caption class="visually-hidden">Per-lab forecast made at the scrubbed date against what actually shipped</caption>' +
    '<thead><tr><th scope="col">Lab</th><th scope="col">Predicted</th><th scope="col">Actual</th>' +
    '<th scope="col" class="num">Error</th><th scope="col">Hit</th></tr></thead><tbody></tbody>';
  const body = table.querySelector('tbody');

  if (body) {
    const sorted = [...rows].sort((a, b) => {
      const da = a.predictedMedian ?? a.actual?.date ?? '9999-12-31';
      const db = b.predictedMedian ?? b.actual?.date ?? '9999-12-31';
      return da < db ? -1 : da > db ? 1 : a.lab.localeCompare(b.lab);
    });
    if (sorted.length === 0) {
      const tr = el('tr');
      const td = el('td', { class: 'empty-note', colspan: String(COLUMNS) });
      td.textContent = 'No lab had enough release history at this date to make a forecast.';
      tr.append(td);
      body.append(tr);
    }
    for (const row of sorted) {
      const lab = ctx.labs.get(row.lab);
      const actualRelease = row.actual ? ctx.releasesById.get(row.actual.release_id) : undefined;
      const tr = el('tr');
      tr.innerHTML =
        `<td><span class="rank-model"><span class="rank-dot" style="background:${esc(lab?.color ?? '#111')}"></span>` +
        `<span class="rank-model__lab">${esc(lab?.short ?? row.lab)}</span></span></td>` +
        `<td class="bt-pred">${row.predictedMedian ? esc(fmtDate(row.predictedMedian)) : EN_DASH}` +
        (row.p16 && row.p84 ? `<small>68 %: ${esc(fmtDate(row.p16))} ${EN_DASH} ${esc(fmtDate(row.p84))}</small>` : '') +
        '</td>' +
        `<td class="bt-actual">${
          row.actual
            ? `${esc(actualRelease?.name ?? row.actual.release_id)}<small>${esc(fmtDate(row.actual.date))}</small>`
            : `${EN_DASH}<small>nothing shipped since</small>`
        }</td>` +
        `<td class="num bt-error">${esc(fmtSignedDays(row.errorDays))}</td>` +
        `<td>${hitBadge(row)}</td>`;
      body.append(tr);
    }
  }
  wrap.append(table);
  host.append(wrap);

  /* ------------------------------------------------------------ global report */
  const report = c.backtest.report;
  if (!report) {
    host.append(el('p', { class: 'section-note bt-note', text: 'The worker has not published a backtest yet.' }));
    return;
  }

  const summary = el('div', { class: 'bt-report' });
  const facts = el('dl', { class: 'bfacts' });
  const drift = report as unknown as MaybeDrift;

  facts.innerHTML =
    fact('Scored rows', String(report.n), `${report.unforecastable} unforecastable (lab had no history yet)`) +
    fact('Coverage 68 %', fmtPercent(report.coverage68, 1), 'target 68 %') +
    fact('Coverage 90 %', fmtPercent(report.coverage90, 1), 'target 90 %') +
    fact('MAE', `${Math.round(report.maeDays)} d`, `median ${Math.round(report.medianAbsDays)} d`) +
    fact('Bias', fmtSignedDays(report.biasDays), report.biasDays > 0 ? 'ships later than predicted' : 'ships earlier than predicted') +
    fact('θ MAE', report.thetaMae === null ? EN_DASH : fmtNumber(report.thetaMae, 2), 'logits') +
    (typeof drift.driftPerYear === 'number' && Number.isFinite(drift.driftPerYear)
      ? fact(
          'Cadence drift',
          `${drift.driftPerYear >= 0 ? '+' : '−'}${Math.abs(drift.driftPerYear).toFixed(2)} / yr`,
          drift.drift === true ? 'applied to the forecasts' : 'measured, not applied',
        )
      : '');
  summary.append(facts);

  const sigma = el('p', { class: 'bt-sigma' });
  sigma.innerHTML =
    `σ scale <b>×${esc(report.sigmaScale.toFixed(1))}</b> ${EN_DASH} chosen so that past 68 % / 90 % windows held ` +
    `<b>${esc(fmtPercent(report.coverage68))}</b> / <b>${esc(fmtPercent(report.coverage90))}</b> of the releases. ` +
    `Every window drawn on the chart is widened by it. ` +
    (Number.isFinite(report.halfLifeDays)
      ? `Cadence half-life ${Math.round(report.halfLifeDays)} days.`
      : 'Cadence intervals are weighted equally.') +
    ` Replayed every ${report.stepDays} days from ${esc(fmtDate(report.from))} to ${esc(fmtDate(report.to))}.`;
  summary.append(sigma);

  const curve = calibrationCurve(report);
  if (curve) {
    const box = el('figure', { class: 'bt-calib' });
    box.append(curve);
    box.append(
      el('figcaption', {
        text: 'Calibration — nominal quantile against the share of releases at or before it. On the diagonal means the windows mean what they say.',
      }),
    );
    summary.append(box);
  }

  host.append(summary);
}
