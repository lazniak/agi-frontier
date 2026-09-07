/**
 * The first-visit tour — four steps that name the four things a reader cannot guess:
 * the axis, the forecast circle, the NOW rule and the Stages column.
 *
 * Anchors are resolved by selector at show-time (the chart draws them, so they may not exist
 * on an empty dataset) and a step whose anchors are all missing is skipped rather than pointing
 * at nothing. Dismissal is remembered in `agi:tour`; the header's "Tour" link reopens it.
 */
import { el, qsa } from '../dom';
import { readFlag, TOUR_KEY, writeFlag } from './persist';

interface Step {
  /** Tried in order; the first match wins. */
  anchors: string[];
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    anchors: ['.axis-title', '.level-label', '.chart-svg', '[data-chart-canvas]'],
    title: 'This is the Frontier Rating',
    body:
      'The axis is unbounded and linear in latent ability: 400 points is ten times the odds of solving an ' +
      'average item of the benchmark basket. The rungs on the right are levels — human baselines, saturation ' +
      'points, generation ceilings — fitted from the same numbers, not drawn by hand.',
  },
  {
    anchors: ['.pred-circle', '.pred-whisker', '.fan', '[data-chart-canvas]'],
    title: 'Every circle is a release window',
    body:
      'A yellow circle sits on the median predicted launch date; its diameter is the 68 % window, widened by ' +
      'the σ scale the backtest earned. It shrinks as the launch nears, because time that has already passed ' +
      'without a release cuts the distribution from the left.',
  },
  {
    anchors: ['.now-handle', '#scrub', '.scrubber'],
    title: 'Drag NOW into the past',
    body:
      'The whole page — the fit, the frontier, the rankings, every forecast — is recomputed as of the date you ' +
      'scrub to. Drag it back and the Backtest card appears: what the model predicted then, against what ' +
      'actually shipped.',
  },
  {
    anchors: ['#stages', '[data-stages]'],
    title: 'Stages reads the future downwards',
    body:
      'Levels the frontier has not reached yet sit at the top with their 68 % and 90 % windows, then NOW and ' +
      'the current pace regime, then the eras and the levels already passed — with the model that passed them.',
  },
];

export interface TourApi {
  /** Open at step 0. Used by the header link and by the first visit. */
  start(): void;
  close(): void;
  destroy(): void;
}

function firstAnchor(step: Step): HTMLElement | SVGElement | null {
  for (const sel of step.anchors) {
    const found = qsa<HTMLElement | SVGElement>(sel).find((n) => {
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (found) return found;
  }
  return null;
}

export function createTour(): TourApi {
  const root = el('div', { class: 'tour', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tour-title' });
  root.hidden = true;
  const scrim = el('div', { class: 'tour__scrim' });
  const ring = el('div', { class: 'tour__ring', 'aria-hidden': 'true' });
  const card = el('div', { class: 'tour__card' });
  const counter = el('p', { class: 'tour__step' });
  const title = el('h2', { class: 'tour__title', id: 'tour-title' });
  const bodyText = el('p', { class: 'tour__body' });
  const actions = el('div', { class: 'tour__actions' });
  const skip = el('button', { type: 'button', class: 'cbtn cbtn--quiet', text: 'Skip' });
  const back = el('button', { type: 'button', class: 'cbtn', text: 'Back' });
  const next = el('button', { type: 'button', class: 'cbtn cbtn--accent', text: 'Next' });
  actions.append(skip, back, next);
  card.append(counter, title, bodyText, actions);
  root.append(scrim, ring, card);
  document.body.append(root);

  let index = 0;
  let open = false;
  let raf = 0;

  function place(anchor: HTMLElement | SVGElement): void {
    const r = anchor.getBoundingClientRect();
    const pad = 8;
    const rx = Math.max(4, r.left - pad);
    const ry = Math.max(4, r.top - pad);
    const rw = Math.min(window.innerWidth - rx - 4, r.width + pad * 2);
    const rh = Math.min(window.innerHeight - ry - 4, r.height + pad * 2);
    ring.style.left = `${rx}px`;
    ring.style.top = `${ry}px`;
    ring.style.width = `${rw}px`;
    ring.style.height = `${rh}px`;

    const cw = Math.min(360, window.innerWidth - 24);
    card.style.width = `${cw}px`;
    const ch = card.offsetHeight || 200;
    const below = ry + rh + 14;
    const raw = below + ch < window.innerHeight - 12 ? below : ry - ch - 14;
    // Never off the bottom edge either: a tall ring leaves no room on either side of it.
    const top = Math.max(12, Math.min(raw, window.innerHeight - ch - 12));
    const left = Math.max(12, Math.min(window.innerWidth - cw - 12, rx + rw / 2 - cw / 2));
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
  }

  function show(): void {
    // Skip steps whose anchors are not on the page (an empty dataset draws no circles).
    let step = STEPS[index];
    while (step && !firstAnchor(step)) {
      index += 1;
      step = STEPS[index];
    }
    if (!step) {
      finish();
      return;
    }
    counter.textContent = `Step ${index + 1} of ${STEPS.length}`;
    title.textContent = step.title;
    bodyText.textContent = step.body;
    back.disabled = index === 0;
    next.textContent = index === STEPS.length - 1 ? 'Done' : 'Next';

    const anchor = firstAnchor(step);
    if (!anchor) {
      finish();
      return;
    }
    // `instant`, never `auto`: `auto` defers to the page's `scroll-behavior: smooth`, and the
    // ring would then be measured against an element still gliding across the viewport.
    anchor.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => place(anchor));
    });
    // The chart redraws on resize/scroll; re-measure once things have settled.
    window.setTimeout(() => {
      if (open) place(anchor);
    }, 280);
  }

  function finish(): void {
    writeFlag(TOUR_KEY, true);
    close();
  }

  function close(): void {
    if (!open) return;
    open = false;
    root.hidden = true;
    document.documentElement.classList.remove('is-touring');
  }

  function start(): void {
    index = 0;
    open = true;
    root.hidden = false;
    document.documentElement.classList.add('is-touring');
    show();
    next.focus();
  }

  next.addEventListener('click', () => {
    if (index >= STEPS.length - 1) finish();
    else {
      index += 1;
      show();
    }
  });
  back.addEventListener('click', () => {
    index = Math.max(0, index - 1);
    show();
  });
  skip.addEventListener('click', finish);
  scrim.addEventListener('click', finish);

  const onKey = (ev: KeyboardEvent): void => {
    if (!open) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      finish();
      return;
    }
    if (ev.key !== 'Tab') return;
    // Small, explicit focus trap: the three buttons are the whole dialog.
    const focusable = [skip, back, next].filter((b) => !b.disabled);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    } else if (!focusable.includes(document.activeElement as HTMLButtonElement)) {
      ev.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', onKey, true);

  const onResize = (): void => {
    if (open) show();
  };
  window.addEventListener('resize', onResize);

  return {
    start,
    close,
    destroy(): void {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      if (raf) cancelAnimationFrame(raf);
      root.remove();
    },
  };
}

/** Open the tour once per browser, after the first render has drawn its anchors. */
export function maybeAutoStart(tour: TourApi): void {
  if (readFlag(TOUR_KEY)) return;
  window.setTimeout(() => tour.start(), 900);
}
