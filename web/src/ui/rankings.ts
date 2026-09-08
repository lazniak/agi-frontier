/**
 * Rankings — the current model per lab as of the scrubbed date, led by the Frontier Rating.
 *
 * The tier filter is the same `store.tierView` the chart uses, so flipping it here also changes
 * what the chart draws (REDESIGN §3): `flagship` ranks each lab's most capable tier, `all` ranks
 * whatever each lab shipped most recently and adds a one-line summary of the family band under
 * the lab's row.
 *
 * The table is honest about the two things a league table normally hides (REDESIGN §12.9): rows
 * the data cannot separate share one rank inside a hairline bracket, and every row reports how
 * much evidence its rating rests on, because a rating fitted from one community Elo score is a
 * different kind of claim from one fitted from five official test results.
 */
import { MIN_QUALIFIED_SCORES, comparability, daysBetween, evidenceOf, rankTies, ratingMargin } from '@agi/shared';
import type {
  Comparability,
  DatePrecision,
  Evidence,
  ISODate,
  LabId,
  ModelIndex,
  ModelTier,
  TieGroup,
} from '@agi/shared';
import type { Computed, Ctx, SeriesPoint } from '../data';
import { announce, badge, clear, el, maybe, qs } from '../dom';
import type { Store, TierView } from '../state';
import {
  EN_DASH,
  esc,
  fmtDate,
  fmtDatePrecision,
  fmtIndex,
  fmtNumber,
  fmtRating,
  pluralise,
  precisionLabel,
} from './format';

/** Header columns: #, Model, Rating, Index, Benchmarks used, Released, Age (the last one is added here). */
const COLUMNS = 7;

/** Mean Gregorian month — the unit of the Age column. */
const DAYS_PER_MONTH = 365.25 / 12;

/** The comparability window the tooltip quotes (REDESIGN §12.5). */
const NEIGHBOUR_MONTHS = 18;

/** The nominal coverage of `TIE_Z` (= 1 standard error), spelled out for the reader. */
const TIE_COVERAGE = '68 %';

/**
 * Age of a release as of a date, in whole months — `null` under one month, which the column
 * prints as "new". Negative ages cannot occur: the rankings only list releases ≤ asOf.
 */
export function ageMonths(released: ISODate, asOf: ISODate): number | null {
  const months = Math.floor(daysBetween(released, asOf) / DAYS_PER_MONTH);
  return months < 1 ? null : months;
}

/**
 * The Age cell: "new" under a month, else `14 mo`.
 *
 * The tooltip only quotes a day count when the dataset actually knows the day. `date_precision`
 * says how sure the release date is, and the Released cell two columns to the left already prints
 * "month precision" — an exact "438 days since release" next to it claimed a precision the data
 * rules forbid us to invent, so a month/quarter/year-dated release gets a hedged month figure and
 * the precision it rests on.
 */
function ageCell(released: ISODate, asOf: ISODate, precision: DatePrecision): string {
  const months = ageMonths(released, asOf);
  const stamp = `as of ${fmtDate(asOf)}`;
  const hedge =
    precision === 'unknown'
      ? 'the launch date was never pinned down'
      : `the launch date is only known to the ${precision}`;
  const title =
    precision === 'day'
      ? `${pluralise(daysBetween(released, asOf), 'day')} since release, ${stamp}`
      : months === null
        ? `less than a month since release, ${stamp} (${hedge})`
        : `about ${pluralise(months, 'month')} since release, ${stamp} (${hedge})`;
  return months === null
    ? `<td class="num rank-age"><span class="rank-age__new" title="${esc(title)}">new</span></td>`
    : `<td class="num rank-age"><span title="${esc(title)}">${months}<small>mo</small></span></td>`;
}

/** The coverage tooltip: what the Rasch comparison for this model actually rests on. */
function coverageTitle(cmp: Comparability | undefined): string {
  if (!cmp) return 'Not in the current fit — no shared-benchmark comparison to report.';
  if (cmp.neighbours === 0) return `No frontier neighbour within ±${NEIGHBOUR_MONTHS} months — compared only through the fit’s δ.`;
  return `Shares ${pluralise(cmp.shared, 'benchmark')} with ${pluralise(cmp.neighbours, 'frontier neighbour')} (±${NEIGHBOUR_MONTHS} months)`;
}

/**
 * The ranks of one rendering, tie groups included.
 *
 * `rankCurrentFlagships` returns qualified models first and provisional ones after, each block
 * sorted by index — so the whole array is *not* descending in rating, and `rankTies` (which
 * requires a descending list) has to be asked one block at a time. Grouping across the divider
 * would be meaningless anyway: the divider already says the two blocks rest on different amounts
 * of evidence. The provisional ranks are offset by the size of the first block so the numbers
 * keep counting straight through the divider, exactly as they did before.
 */
function rankGroups(rows: ModelIndex[]): TieGroup[] {
  const qualified = rows.filter((m) => m.qualified);
  const provisional = rows.filter((m) => !m.qualified);
  return [
    ...rankTies(qualified),
    ...rankTies(provisional).map((g) => ({ ...g, rank: g.rank + qualified.length })),
  ];
}

/** One rendered row: the model plus where it sits inside its tie group. */
interface RankedRow {
  mi: ModelIndex;
  /** The rank shown for the whole group; ranks skip after a tie. */
  rank: number;
  tied: boolean;
  /** 0-based position inside the group, and the group's size. */
  pos: number;
  size: number;
}

function flattenGroups(groups: TieGroup[]): RankedRow[] {
  return groups.flatMap((g) =>
    g.members.map((mi, pos) => ({ mi, rank: g.rank, tied: g.tied, pos, size: g.members.length })),
  );
}

/**
 * The rank cell. A tied group prints `=2` once and leaves its continuation rows blank, the way a
 * league table does — but blank is invisible to a screen reader walking the table cell by cell,
 * so every row carries the joint rank as a visually-hidden phrase.
 */
function rankCell(row: RankedRow): string {
  if (!row.tied) return `<td class="num rank-cell-rank">${row.rank}</td>`;
  const shared = `joint rank ${row.rank}, ${pluralise(row.size, 'model')} tied`;
  const shown = row.pos === 0 ? `<span aria-hidden="true">=${row.rank}</span>` : '';
  return `<td class="num rank-cell-rank">${shown}<span class="visually-hidden">${esc(shared)}</span></td>`;
}

/** How the rating interval reads in prose, for the ± tooltip and the row's accessible name. */
function marginTitle(mi: ModelIndex, margin: number): string {
  const lo = fmtRating(mi.rating - margin);
  const hi = fmtRating(mi.rating + margin);
  return `${TIE_COVERAGE} interval: ${lo} ${EN_DASH} ${hi}. Models whose intervals overlap share a rank.`;
}

/**
 * The evidence meter: one slot per index benchmark, lit for the ones the fit actually used. A
 * bar filled to a percentage cannot distinguish "one score of nineteen" from "two of nineteen"
 * at this size, and that difference is the whole point of the column.
 */
function evidenceDots(mi: ModelIndex, basket: number, e: Evidence): string {
  const weak = e.kind === 'community-only' || e.kind === 'none';
  const dots = Array.from({ length: basket }, (_, i) =>
    i < mi.n ? `<span class="edot edot--on${weak ? ' edot--weak' : ''}"></span>` : '<span class="edot"></span>',
  ).join('');
  return `<span class="edots" aria-hidden="true">${dots}</span>`;
}

/** What the evidence cell says on hover: how many benchmarks, of what kind, against what. */
function evidenceTitle(e: Evidence, basket: number, cmp: Comparability | undefined): string {
  if (e.n === 0) return `No index benchmark backs this rating. ${coverageTitle(cmp)}`;
  const kind =
    e.community === 0
      ? 'all of them official test results'
      : e.community === e.n
        ? e.n === 1
          ? 'and it is a community Elo score, not a test result'
          : 'all of them community Elo scores, not test results'
        : `${e.community} of them community Elo`;
  return `Fitted from ${pluralise(e.n, 'index benchmark')} of ${basket}, ${kind}. ${coverageTitle(cmp)}`;
}

/**
 * `index.html` ships the six static columns; the Age header is appended here so the markup and
 * `COLUMNS` cannot drift apart. Idempotent — the header is added once and reused.
 */
function ensureAgeHeader(table: HTMLTableElement): void {
  const row = table.tHead?.rows[0];
  if (!row || row.querySelector('[data-col="age"]')) return;
  const th = el('th', { scope: 'col', class: 'num', 'data-col': 'age', text: 'Age' });
  th.title = 'Months since release, as of the scrubbed date';
  row.append(th);
}

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
  ensureAgeHeader(table);
  const body = table.tBodies[0];
  if (!body) return;
  clear(body);

  const showAll = store.get().tierView === 'all';
  const rows: ModelIndex[] = showAll ? c.rankingsAll : c.rankings;

  const caption = maybe('[data-rankings-note]');
  if (caption) {
    const lead = showAll
      ? 'The newest released model per lab, whatever its tier, ranked by Frontier Rating. Mid and small models carry a tier badge and a family line showing the lab’s current lineup.'
      : 'The newest released flagship per lab, ranked by Frontier Rating — 400 points is ten times the odds of solving an average basket item.';
    // The two sentences the order itself cannot say: where it is not supported, and how much
    // evidence each row rests on (REDESIGN §12.9).
    caption.textContent =
      `${lead} Rows bracketed together share a rank (=2): their ${TIE_COVERAGE} rating intervals — ` +
      `the ± beside each rating — overlap, so the data cannot separate them. Evidence counts the ` +
      `index benchmarks the rating was fitted from, and flags a rating resting on community Elo ` +
      `alone. Select a row to open its audit.`;
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
  // Shared-benchmark comparability of every fitted model with its ±18-month frontier neighbours,
  // computed once per render from the same fit the rankings come from (REDESIGN §12.5).
  const cmp = comparability(c.fit, ctx.bundle.releases, { asOf: c.asOf, windowMonths: NEIGHBOUR_MONTHS });
  // Which benchmarks are community-run rather than a test the lab sat: the flag travels on the
  // bundle, so LMArena is never hardcoded here (CLAUDE.md, data rules).
  const community = new Set(ctx.benchmarkList.filter((b) => b.community).map((b) => b.id));
  // `rankCurrentFlagships` returns qualified first, then provisional, so one divider before the
  // first provisional row is enough. Rank numbers keep counting straight through it.
  let dividerDone = false;
  const familyDone = new Set<LabId>();
  const ranked = flattenGroups(rankGroups(rows));

  ranked.forEach((row) => {
    const mi = row.mi;
    const release = ctx.releasesById.get(mi.release_id);
    if (!release) return;
    const lab = ctx.labs.get(mi.lab);
    const used = new Map(mi.used.map((u) => [u.benchmark, u]));
    const evidence = evidenceOf(mi, community);
    const margin = Math.round(ratingMargin(mi));

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
    // `rank-model__meta` is hidden above 720 px (panels.css). On a phone the Index, Benchmarks-used
    // and Released columns are dropped — seven columns will not fit in 354 px, and the chip list
    // alone made every row ~300 px tall — so coverage and the release date, at the precision the
    // dataset actually claims, ride along inside the model cell instead of scrolling off the edge.
    const tr = el('tr');
    tr.tabIndex = 0;
    tr.setAttribute('role', 'button');
    // The evidence warning rides in the model cell, not the evidence column, because that column
    // is one of the three a phone drops — and "this rating is one community Elo score" is exactly
    // the caveat a reader must not lose on the narrow layout.
    const flag = evidence.label ? ` ${badge('evidence', esc(evidence.label))}` : '';
    const classes = ['rank-row'];
    if (!mi.qualified) classes.push('rank-row--provisional');
    if (row.tied) {
      classes.push('rank-row--tied');
      if (row.pos === 0) classes.push('is-tie-start');
      if (row.pos === row.size - 1) classes.push('is-tie-end');
    }
    tr.className = classes.join(' ');
    tr.setAttribute(
      'aria-label',
      `Audit ${release.name}, ${row.tied ? `joint rank ${row.rank} of ${row.size} tied models` : `rank ${row.rank}`}` +
        `, rating ${fmtRating(mi.rating)} plus or minus ${margin}` +
        `, ${pluralise(evidence.n, 'index benchmark')}${evidence.label ? `, ${evidence.label}` : ''}` +
        `${mi.qualified ? '' : ', provisional'}`,
    );
    tr.innerHTML =
      rankCell(row) +
      `<td><span class="rank-model"><span class="rank-dot" style="background:${esc(lab?.color ?? '#111')}"></span>
        <span><span class="rank-model__name">${esc(release.name)}</span>${
          tier === 'flagship' ? '' : ` ${badge('tier', tier)}`
        }${mi.qualified ? '' : ` ${badge('provisional', 'provisional')}`}${flag}<br />
        <span class="rank-model__lab">${esc(lab?.short ?? mi.lab)}</span>
        <small class="rank-model__meta">${mi.n} of ${basket.length} · ${esc(
          fmtDatePrecision(release.date, release.date_precision),
        )}</small></span></span></td>` +
      `<td class="num"><span class="rank-rating">${esc(fmtRating(mi.rating))}</span><span class="rank-se" title="${esc(
        marginTitle(mi, margin),
      )}">± ${margin}</span></td>` +
      `<td class="num"><span class="rank-index">${fmtIndex(mi.index)}</span></td>` +
      `<td><span class="rank-coverage rank-evidence" title="${esc(
        evidenceTitle(evidence, basket.length, cmp.get(mi.release_id)),
      )}"><span class="rank-evidence__n">${evidence.n}</span><small>of ${basket.length}</small>
        ${evidenceDots(mi, basket.length, evidence)}</span>
        <span class="bchips">${chips}</span></td>` +
      `<td class="rank-date">${esc(fmtDate(release.date))}<small>${esc(precisionLabel(release.date_precision))}</small></td>` +
      ageCell(release.date, c.asOf, release.date_precision);

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
        // A family line inserted between two tied rows would cut their bracket in half, so it
        // carries the bracket through itself instead.
        const inside = row.tied && row.pos < row.size - 1;
        const line = el('tr', { class: `rank-family${inside ? ' rank-row--tied is-tie-mid' : ''}` });
        line.innerHTML =
          `<td colspan="${COLUMNS}">Family: ${family.length} models · band ${esc(fmtRating(lo))} ${EN_DASH} ${esc(fmtRating(hi))}` +
          ` · ${esc(family.map((p) => p.release.name).join(', '))}</td>`;
        body.append(line);
      }
    }
  });
}
