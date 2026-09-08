/**
 * Benchmark lifetimes strip (REDESIGN §12.5) — mounted in `[data-lifetimes]` under the Method copy.
 *
 * Benchmarks are born, live and burn out at 100 %. One Gantt-like row per benchmark runs from
 * the year it was introduced to the release that saturated it (a filled cap) or to the scrubbed
 * date (an open end). The lighter head of each bar is the stretch before any released model
 * scored it; the row ends with the score count and the life stage. Colour follows the benchmark
 * generation, legacy rows are lighter. Everything is plain HTML positioned in percent along one
 * shared time axis, so the strip re-flows with the page and re-renders on every `asOf` change.
 *
 * Which benchmarks exist at the scrubbed date is `benchmarkLifetimes`' decision, not this file's
 * (see `renderLifetimes`). Every row opens on tap or Enter, because the per-benchmark facts have
 * to reach a phone and a screen reader, not just a mouse pointer.
 */
import { benchmarkLifetimes, dateToDayNumber } from '@agi/shared';
import type { BenchmarkLifetime, ISODate, LifetimeState } from '@agi/shared';
import type { Computed, Ctx } from '../data';
import { clear, el, maybe } from '../dom';
import { esc, fmtDate, fmtMonth, fmtPercent, pluralise } from './format';

/**
 * Generation swatches — four ink tints, the site's only colour here on purpose (the palette keeps
 * hue for labs and for the prediction yellow, so a hue ramp would read as data it is not).
 *
 * The steps are chosen in composited sRGB rather than in alpha: over white, `#111` at α gives
 * `255 − 238α`, so 0.22/0.42/0.64/0.88 land on 203/155/103/46 — four even ~50-value steps instead
 * of the old 188/155/112/55, whose first two were a hair apart once the pale head opacity was
 * applied on top. The tint reaches the row as `--lt-tint` so the bars, the saturation cap and the
 * `gen n` chip in the label all take the same value and cannot drift.
 */
const GENERATION_TINTS = ['rgba(17, 17, 17, 0.22)', 'rgba(17, 17, 17, 0.42)', 'rgba(17, 17, 17, 0.64)', 'rgba(17, 17, 17, 0.88)'];

/** How many generations the legend explains — the palette length, so the two cannot drift. */
export const GENERATION_COUNT = GENERATION_TINTS.length;

/** Ink tint for a benchmark generation (1-based; anything past the palette takes the darkest). */
export function generationTint(generation: number): string {
  const i = Math.min(GENERATION_TINTS.length, Math.max(1, Math.round(generation))) - 1;
  return GENERATION_TINTS[i] ?? GENERATION_TINTS[GENERATION_TINTS.length - 1]!;
}

const STATE_LABEL: Record<LifetimeState, string> = {
  fresh: 'fresh',
  active: 'active',
  saturated: 'saturated',
  legacy: 'legacy',
};

/** `2019-01-01` — where the axis puts a year tick. */
function yearStart(year: number): ISODate {
  return `${String(year).padStart(4, '0')}-01-01`;
}

/**
 * `2019-07-01` — where a benchmark's bar starts. `Benchmark.introduced` is only a year, and the
 * shared module takes its midpoint as the introduction date (see `lifetimes.introductionDate`),
 * which is what the `fresh` clock counts from. Drawing the head from 1 January instead put the
 * bar's start half a year before the state it is meant to illustrate.
 */
function introducedOn(year: number): ISODate {
  return `${String(year).padStart(4, '0')}-07-01`;
}

/** The shared time axis: [first introduction year, the year after `asOf`], in day numbers. */
export interface Axis {
  t0: number;
  t1: number;
  years: number[];
}

/**
 * Build the axis for a set of rows. Ticks every year, or every second year once the span
 * passes ten years so the labels never touch on a phone.
 */
export function buildAxis(rows: BenchmarkLifetime[], asOf: ISODate): Axis {
  const asOfYear = Number(asOf.slice(0, 4));
  const firstYear = rows.length ? Math.min(...rows.map((r) => r.introduced)) : asOfYear - 1;
  const lastYear = asOfYear + 1;
  const t0 = dateToDayNumber(yearStart(firstYear));
  const t1 = dateToDayNumber(yearStart(lastYear));
  const span = lastYear - firstYear;
  const step = span > 10 ? 2 : 1;
  const years: number[] = [];
  for (let y = firstYear; y <= lastYear; y += step) years.push(y);
  return { t0, t1, years };
}

/** Position of a date along the axis, in percent, clamped to the track. */
function pct(axis: Axis, iso: ISODate): number {
  const x = ((dateToDayNumber(iso) - axis.t0) / Math.max(1, axis.t1 - axis.t0)) * 100;
  return Math.min(100, Math.max(0, x));
}

function endLabel(row: BenchmarkLifetime): string {
  const scores = pluralise(row.nScores, 'score');
  if (row.state === 'saturated' && row.saturatedAt) return `${scores} · saturated ${fmtMonth(row.saturatedAt)}`;
  if (row.state === 'legacy' && row.saturatedAt) return `${scores} · legacy, saturated ${fmtMonth(row.saturatedAt)}`;
  return `${scores} · ${STATE_LABEL[row.state]}`;
}

function rowTitle(ctx: Ctx, row: BenchmarkLifetime, asOf: ISODate): string {
  const b = ctx.benchmarks.get(row.benchmark);
  const parts = [
    `${b?.name ?? row.benchmark} — introduced ${row.introduced}, generation ${row.generation}, weight ${row.weight}`,
    row.firstScore ? `first scored ${fmtDate(row.firstScore)}` : 'no released model has scored it yet',
    row.saturatedAt ? `saturated ${fmtDate(row.saturatedAt)} (best official score ≥ 95 % of the range)` : `still alive as of ${fmtDate(asOf)}`,
    row.delta === null ? 'not in the current fit' : `δ = ${row.delta.toFixed(2)}`,
    `${fmtPercent(row.coverageOfFrontier)} of the last 12 months’ flagships report it`,
  ];
  if (b && !b.in_index) parts.push('recorded, not in the index');
  return parts.join(' · ');
}

function renderRow(ctx: Ctx, row: BenchmarkLifetime, axis: Axis, asOf: ISODate): HTMLElement {
  const b = ctx.benchmarks.get(row.benchmark);
  // `introduced` is only a year, and the shared module reads it as that year's midpoint — so the
  // bar has to start there too, or the head runs from six months before the state it illustrates.
  // A first score older than that midpoint wins: whatever the recorded year, a released model
  // scoring the benchmark proves it already existed.
  const born = introducedOn(row.introduced);
  const start = pct(axis, row.firstScore && row.firstScore < born ? row.firstScore : born);
  const scored = row.firstScore ? pct(axis, row.firstScore) : null;
  const end = pct(axis, row.saturatedAt ?? asOf);
  const closed = row.saturatedAt !== null;
  const details = rowTitle(ctx, row, asOf);

  /*
   * The row is a button, not a decorated `<li>`: δ, coverage and the first-score date used to live
   * only in a `title`, which a keyboard never reaches and a touch screen never shows — on a phone,
   * where the spec wants this strip to work, the explanation the copy promises was unreachable.
   * Now one tap / Enter opens the same sentence inline, and it is in the accessible name either way.
   */
  const li = el('li', {
    class: `lt-row lt-row--${row.state}${b && !b.in_index ? ' lt-row--off-index' : ''}`,
    'data-benchmark': row.benchmark,
    tabindex: '0',
    role: 'button',
    'aria-expanded': 'false',
    title: details,
  });
  // The tint drives the bars, the cap and the label chip from one place (see panels.css).
  li.style.setProperty('--lt-tint', generationTint(row.generation));

  const label = el('span', { class: 'lt-label' });
  label.append(el('span', { class: 'lt-label__name', text: b?.short ?? row.benchmark }));
  const gen = el('small', { class: 'lt-label__gen' });
  gen.append(el('span', { class: 'lt-gen-dot', 'aria-hidden': 'true' }), document.createTextNode(`gen ${row.generation}`));
  label.append(gen);

  const track = el('span', { class: 'lt-track', 'aria-hidden': 'true' });
  // The pale head: introduced but not yet on any released model's card.
  const headEnd = scored ?? end;
  const head = el('span', { class: 'lt-bar lt-bar--head' });
  head.style.left = `${start}%`;
  head.style.width = `${Math.max(0, headEnd - start)}%`;
  track.append(head);
  if (scored !== null) {
    const body = el('span', { class: `lt-bar lt-bar--body${closed ? '' : ' lt-bar--open'}` });
    body.style.left = `${scored}%`;
    body.style.width = `${Math.max(0.6, end - scored)}%`;
    track.append(body);
  }
  if (closed) {
    const cap = el('span', { class: 'lt-cap' });
    cap.style.left = `${end}%`;
    track.append(cap);
  }
  const now = el('span', { class: 'lt-now' });
  now.style.left = `${pct(axis, asOf)}%`;
  track.append(now);

  const tail = el('span', { class: 'lt-end', text: endLabel(row) });
  // Clipped rather than `display: none` while collapsed, so the facts are in the row's accessible
  // name whether or not it is open — and are never read twice when it is.
  const detail = el('span', { class: 'lt-detail', text: details });
  const sr = el('span', {
    class: 'visually-hidden',
    text: `${b?.name ?? row.benchmark}: introduced ${row.introduced}, ${endLabel(row)}.`,
  });

  const toggle = (): void => {
    const open = li.getAttribute('aria-expanded') === 'true';
    li.setAttribute('aria-expanded', String(!open));
    li.classList.toggle('is-open', !open);
  };
  li.addEventListener('click', toggle);
  li.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault();
    toggle();
  });

  li.append(label, track, tail, detail, sr);
  return li;
}

function renderAxis(axis: Axis): HTMLElement {
  const ax = el('div', { class: 'lt-axis', 'aria-hidden': 'true' });
  for (const y of axis.years) {
    const tick = el('span', { class: 'lt-axis__tick', text: String(y) });
    tick.style.left = `${pct(axis, yearStart(y))}%`;
    ax.append(tick);
  }
  return ax;
}

/**
 * Render (or re-render) the strip for the current computation. Rows are sorted by introduction
 * year, then by first score, so the Gantt reads top-down like a timeline; ties fall back to the
 * basket order the shared function already returns.
 */
export function renderLifetimes(ctx: Ctx, c: Computed): void {
  const host = maybe('[data-lifetimes]');
  if (!host) return;
  clear(host);

  /*
   * Who drops the benchmarks that did not exist yet at `asOf`: `benchmarkLifetimes` does, and only
   * it. It skips a benchmark whose introduction is in the future of the viewed date *and* which no
   * released model has scored — the second half matters, because a model released before the
   * benchmark's mid-year introduction date proves the benchmark existed, and such a row must stay.
   * Filtering again here on the year alone would look like the same rule and quietly be a stricter
   * one, so the strip takes the list as given and only draws it.
   */
  const rows = benchmarkLifetimes(c.fit, ctx.bundle.releases, ctx.benchmarkList, c.asOf)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.introduced - b.r.introduced || (a.r.firstScore ?? '9999').localeCompare(b.r.firstScore ?? '9999') || a.i - b.i)
    .map((x) => x.r);

  host.append(el('h3', { class: 'section-title lifetimes__title', text: 'Benchmark lifetimes' }));
  host.append(
    el('p', {
      class: 'method-copy lifetimes__copy',
      text:
        'The Rasch fit is the shared-benchmark comparison generalised: every model is compared through the ' +
        'benchmarks it shares with its neighbours, and the chain of overlapping generations carries the rating ' +
        'across eras. A saturated benchmark keeps its difficulty δ in the fit, so nothing is lost when it dies — ' +
        'the models it once separated stay separated, and the ceiling it hit becomes a rung on the ladder.',
    }),
  );

  if (rows.length === 0) {
    host.append(
      el('p', {
        class: 'section-note',
        text: ctx.benchmarkList.length
          ? `No benchmark of this basket had been published as of ${fmtDate(c.asOf)}.`
          : 'No benchmarks in the bundle.',
      }),
    );
    return;
  }

  const axis = buildAxis(rows, c.asOf);
  const strip = el('div', { class: 'lt-strip' });
  strip.append(renderAxis(axis));
  const list = el('ol', { class: 'lt-rows', 'aria-label': `Benchmark lifetimes as of ${fmtDate(c.asOf)}` });
  for (const row of rows) list.append(renderRow(ctx, row, axis, c.asOf));
  strip.append(list);

  const legend = el('p', { class: 'lt-legend' });
  legend.innerHTML =
    `<span class="lt-legend__item"><span class="lt-swatch lt-swatch--head"></span>introduced, not yet scored</span>` +
    `<span class="lt-legend__item"><span class="lt-swatch lt-swatch--body"></span>on released models</span>` +
    `<span class="lt-legend__item"><span class="lt-swatch lt-swatch--cap"></span>saturated (best official score ≥ 95 %)</span>` +
    `<span class="lt-legend__item"><span class="lt-swatch lt-swatch--now"></span>${esc(fmtDate(c.asOf))}</span>`;
  strip.append(legend);

  // The generation ramp was drawn but never explained; without this row the four tints are just
  // four greys and the "gen n" chip beside each name has nothing to agree with.
  const gens = el('p', { class: 'lt-legend lt-legend--gen' });
  gens.innerHTML =
    `<span class="lt-legend__label">Generation</span>` +
    Array.from({ length: GENERATION_COUNT }, (_, i) => {
      const n = i + 1;
      const last = n === GENERATION_COUNT;
      return (
        `<span class="lt-legend__item"><span class="lt-swatch lt-swatch--gen" style="background:${esc(generationTint(n))}"></span>` +
        `gen ${n}${last ? ' and newer' : ''}</span>`
      );
    }).join('');
  strip.append(gens);
  host.append(strip);
}
