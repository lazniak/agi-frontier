/**
 * Stages — one column of time, future at the top (REDESIGN §2, §7.1).
 *
 * Reading downwards is reading backwards: the crossings the frontier has not reached yet
 * (farthest first), then the NOW divider with the projected era, then the pace eras and the
 * levels the frontier has already passed, newest first. Everything is computed by
 * `@agi/shared` — this module only arranges it.
 */
import type { Crossing, Era, LevelKind } from '@agi/shared';
import type { Computed, Ctx } from '../data';
import { clear, el, maybe } from '../dom';
import { EN_DASH, esc, fmtDate, fmtMonth, fmtRating, regimeLabel } from './format';

export interface StagesDeps {
  /** Open the audit drawer for the release that crossed a level. */
  onSelect(id: string): void;
  /** Highlight the matching rung of the chart's ladder, when the chart offers it. */
  hoverLevel?: ((id: string | null) => void) | undefined;
}

const KIND_LABEL: Record<LevelKind, string> = {
  human: 'human',
  saturation: 'saturation',
  generation: 'generation',
  ceiling: 'ceiling',
  speculative: 'speculative',
};

const REGIME_NOTE: Record<Era['regime'], string> = {
  dormant: 'below half a logit a year — the frontier is resting',
  climb: 'a steady climb',
  acceleration: 'accelerating',
  takeoff: 'take-off',
};

/** `median Mar 2028 · 68 %: Oct 2027 – Nov 2028 · 90 %: Aug 2027 – Jun 2029` */
function windowLine(c: Crossing): string {
  const parts = [`median <b>${esc(fmtMonth(c.date))}</b>`];
  if (c.p16 && c.p84) parts.push(`68 %: ${esc(fmtMonth(c.p16))} ${EN_DASH} ${esc(fmtMonth(c.p84))}`);
  if (c.p05 && c.p95) parts.push(`90 %: ${esc(fmtMonth(c.p05))} ${EN_DASH} ${esc(fmtMonth(c.p95))}`);
  return parts.join(' · ');
}

function emptyRow(text: string): HTMLElement {
  return el('li', { class: 'stage stage--empty' }, el('p', { class: 'stage__note', text }));
}

/**
 * The column scrolls inside a fixed height, and NOW is its hinge. Park it a little below the
 * middle on the first paint so the reader sees future *and* past and knows there is more to
 * scroll; after that the scroll position is theirs, and scrubbing must not yank it back.
 */
let centred = false;

export function renderStages(ctx: Ctx, c: Computed, deps: StagesDeps): void {
  const host = maybe('[data-stages]');
  if (!host) return;
  clear(host);

  const hover = deps.hoverLevel;
  const bindHover = (node: HTMLElement, levelId: string): void => {
    // The id lets the chart's ladder highlight this row too (`Interactions.hoverLevel`).
    node.dataset.levelId = levelId;
    if (!hover) return;
    node.addEventListener('pointerenter', () => hover(levelId));
    node.addEventListener('pointerleave', () => hover(null));
    node.addEventListener('focusin', () => hover(levelId));
    node.addEventListener('focusout', () => hover(null));
  };

  /* ------------------------------------------------------------- predicted */
  // Descending in time so the whole column reads top = far future, bottom = far past.
  const predicted = c.crossings
    .filter((x) => x.kind === 'predicted')
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  if (predicted.length === 0) {
    host.append(emptyRow('No level is predicted to be crossed within 15 years at the current pace.'));
  } else {
    for (const x of predicted) {
      const row = el('li', { class: 'stage stage--predicted' });
      row.innerHTML =
        `<div class="stage__head"><span class="stage__label">${esc(x.level.label)}</span>` +
        `<span class="badge badge--kind badge--${esc(x.level.kind)}">${esc(KIND_LABEL[x.level.kind])}</span></div>` +
        `<p class="stage__meta">${windowLine(x)}</p>` +
        `<p class="stage__rating">Rating ${esc(fmtRating(x.level.rating))}</p>`;
      bindHover(row, x.level.id);
      host.append(row);
    }
  }

  /* ------------------------------------------------------------------- now */
  const now = el('li', { class: 'stage stage--now' });
  const projected = c.projectedEra;
  const perYear = c.trend ? c.trend.slopePerDay * 365 : null;
  const doublingMonths =
    c.trend && c.trend.slopePerDay > 0 ? Math.LN2 / c.trend.slopePerDay / 30.4375 : null;
  const pace =
    projected && perYear !== null
      ? `At the current pace: <b>${esc(regimeLabel(projected))}</b>, ${perYear.toFixed(1)} logits / yr` +
        (doublingMonths && doublingMonths < 240
          ? ` ${EN_DASH} odds double every ${doublingMonths.toFixed(doublingMonths < 10 ? 1 : 0)} months.`
          : '.')
      : 'Not enough frontier history to project a pace.';
  now.innerHTML =
    `<div class="stage__nowrule"><span class="stage__nowtag">NOW</span>` +
    `<span class="stage__nowdate">${esc(c.asOf === ctx.today ? `${fmtDate(c.asOf)} · today` : fmtDate(c.asOf))}</span></div>` +
    `<p class="stage__meta">${pace}</p>`;
  host.append(now);

  if (!centred) {
    centred = true;
    requestAnimationFrame(() => {
      host.scrollTop = Math.max(0, now.offsetTop - host.clientHeight * 0.55);
    });
  }

  /* ------------------------------------------------------------------ eras */
  const eras = [...c.eras].sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : 0));
  if (eras.length === 0) {
    host.append(emptyRow('No pace era yet — the frontier needs a year of history before it has a regime.'));
  } else {
    for (const era of eras) {
      const row = el('li', { class: `stage stage--era stage--era-${era.regime}` });
      row.innerHTML =
        `<div class="stage__head"><span class="stage__label">${esc(regimeLabel(era.regime))}</span>` +
        `<span class="stage__range">${esc(fmtMonth(era.start))} ${EN_DASH} ${esc(era.end ? fmtMonth(era.end) : 'ongoing')}</span></div>` +
        `<p class="stage__meta">${esc(REGIME_NOTE[era.regime])} · mean ${era.meanPace.toFixed(1)} · max ${era.maxPace.toFixed(1)} logits / yr</p>`;
      host.append(row);
    }
  }

  /* ------------------------------------------------------------------- past */
  const past = c.crossings
    .filter((x) => x.kind === 'past')
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  if (past.length === 0) {
    host.append(emptyRow('The frontier has not passed any of the ladder’s levels yet.'));
    return;
  }

  for (const x of past) {
    const release = x.release_id ? ctx.releasesById.get(x.release_id) : undefined;
    const lab = x.lab ? ctx.labs.get(x.lab) : release ? ctx.labs.get(release.lab) : undefined;
    const row = el('li', { class: 'stage stage--past' });
    row.innerHTML =
      `<div class="stage__head"><span class="stage__label">${esc(x.level.label)}</span>` +
      `<span class="stage__range">${esc(fmtDate(x.date))}</span></div>` +
      (release
        ? `<p class="stage__meta"><span class="rank-dot" style="background:${esc(lab?.color ?? '#111')}"></span>` +
          `<b>${esc(release.name)}</b> · ${esc(lab?.short ?? release.lab)}</p>`
        : '<p class="stage__meta">Crossed before the first recorded release.</p>') +
      `<p class="stage__rating">Rating ${esc(fmtRating(x.level.rating))}</p>`;

    bindHover(row, x.level.id);

    if (release) {
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', `Audit ${release.name}, which crossed ${x.level.label}`);
      const id = release.id;
      row.addEventListener('click', () => deps.onSelect(id));
      row.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          deps.onSelect(id);
        }
      });
    }
    host.append(row);
  }
}
