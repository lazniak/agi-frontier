/**
 * The control bar — one labelled row of segmented controls instead of six loose pills.
 *
 * Every group is a `role="radiogroup"` with roving tabindex, an `aria-label`, a tooltip and a
 * visible keyboard hint, so the same choice can be made with the mouse, the keyboard or a
 * screen reader. Below 720 px the whole bar becomes a bottom sheet behind a fixed "Controls"
 * button; the groups and their targets are identical, only the container moves.
 */
import type { ISODate } from '@agi/shared';
import type { Ctx } from '../data';
import type { ForecastMode, RangeMode, Store, TierView, YMode } from '../state';
import { announce, clear, el, maybe, qs } from '../dom';
import { fmtDate } from './format';

export interface ControlBarDeps {
  ctx: Ctx;
  store: Store;
  /** "Fit" — hand back to the chart. */
  fit(): void;
  /** "Reset" — hand back to the chart. */
  reset(): void;
  /** "Back to today" — main.ts eases the scrubber instead of jumping. */
  backToToday(): void;
  /** "?" — open the shortcut sheet. */
  help(): void;
}

export interface ControlBar {
  /** Re-read the store and update every aria-checked / label. Cheap; call on the `view` channel. */
  sync(): void;
  openSheet(): void;
  closeSheet(): void;
  destroy(): void;
}

interface SegOption<T extends string> {
  value: T;
  label: string;
  /** Visible keyboard hint on the button. */
  hint: string;
  title: string;
}

/** ≤ 720 px: the bar lives in a bottom sheet. */
const SHEET_QUERY = '(max-width: 720px)';

export function createControlBar(deps: ControlBarDeps): ControlBar {
  const { ctx, store } = deps;
  const bar = qs('[data-controlbar]');
  const inner = qs('[data-controlbar-inner]', bar);
  const fab = maybe<HTMLButtonElement>('[data-controls-fab]');
  const scrim = maybe('[data-controls-scrim]');
  clear(inner);

  const syncs: (() => void)[] = [];
  const teardown: (() => void)[] = [];

  const isSheet = (): boolean => typeof matchMedia === 'function' && matchMedia(SHEET_QUERY).matches;

  /* ------------------------------------------------------- segmented control */

  function segmented<T extends string>(
    label: string,
    options: SegOption<T>[],
    read: () => T,
    write: (v: T) => void,
    announcement: (v: T) => string,
  ): HTMLElement {
    const group = el('div', { class: 'cgroup' });
    const id = `cg-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`;
    group.append(el('span', { class: 'cgroup__label', id, text: label }));

    const seg = el('div', { class: 'seg', role: 'radiogroup', 'aria-labelledby': id });
    const buttons: HTMLButtonElement[] = [];

    options.forEach((opt, i) => {
      const b = el('button', {
        type: 'button',
        class: 'seg__btn',
        role: 'radio',
        'aria-checked': 'false',
        title: `${opt.title} (${opt.hint})`,
        'data-value': opt.value,
      });
      b.append(el('span', { class: 'seg__label', text: opt.label }));
      b.append(el('kbd', { class: 'seg__key', text: opt.hint, 'aria-hidden': 'true' }));
      b.addEventListener('click', () => {
        write(opt.value);
        announce(announcement(opt.value));
        if (isSheet()) closeSheet();
      });
      b.addEventListener('keydown', (ev) => {
        const step = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 0;
        if (!step) return;
        ev.preventDefault();
        const next = options[(i + step + options.length) % options.length];
        if (!next) return;
        write(next.value);
        announce(announcement(next.value));
        buttons[(i + step + options.length) % options.length]?.focus();
      });
      buttons.push(b);
      seg.append(b);
    });

    group.append(seg);
    syncs.push(() => {
      const current = read();
      options.forEach((opt, i) => {
        const b = buttons[i];
        if (!b) return;
        const on = opt.value === current;
        b.setAttribute('aria-checked', String(on));
        // Roving tabindex: one stop per group, on the selected option.
        b.tabIndex = on ? 0 : -1;
      });
    });
    return group;
  }

  /* --------------------------------------------------------------- the groups */

  inner.append(
    segmented<YMode>(
      'Axis',
      [
        { value: 'rating', label: 'Rating', hint: 'R', title: 'Frontier Rating — unbounded; 400 points is 10× the odds' },
        { value: 'index', label: 'Index', hint: 'I', title: 'Frontier Index — the bounded 0–100 reading of the same scale' },
      ],
      () => store.get().yMode,
      (v) => store.setYMode(v),
      (v) => (v === 'rating' ? 'Axis: Frontier Rating' : 'Axis: Frontier Index'),
    ),
  );

  inner.append(
    segmented<RangeMode>(
      'Range',
      [
        { value: 'story', label: 'Story 2018→', hint: 'S', title: 'Start at the first release (GPT-1, 2018)' },
        { value: 'recent', label: 'Recent 2023→', hint: 'S', title: 'Start at 2023, the modern basket era' },
      ],
      () => store.get().range,
      (v) => store.setRange(v),
      (v) => (v === 'story' ? 'Range: the whole story, from 2018' : 'Range: recent, from 2023'),
    ),
  );

  inner.append(
    segmented<ForecastMode>(
      'Forecast',
      [
        { value: 'next', label: 'Next', hint: 'F', title: 'One release ahead per lab' },
        { value: 'long', label: 'Long', hint: 'F', title: 'The full chained forecast (up to 24 releases)' },
      ],
      () => store.get().forecast,
      (v) => store.setForecast(v),
      (v) => (v === 'next' ? 'Forecast: the next release per lab' : 'Forecast: the full chain'),
    ),
  );

  inner.append(
    segmented<'on' | 'off'>(
      'Bands',
      [
        { value: 'on', label: 'On', hint: 'B', title: 'Fill each lab family from its flagship down to its smallest current tier' },
        { value: 'off', label: 'Off', hint: 'B', title: 'Hide the family bands' },
      ],
      () => (store.get().bands ? 'on' : 'off'),
      (v) => store.setBands(v === 'on'),
      (v) => (v === 'on' ? 'Family bands on' : 'Family bands off'),
    ),
  );

  inner.append(
    segmented<TierView>(
      'Tiers',
      [
        { value: 'flagship', label: 'Flagship', hint: 'T', title: 'Only each lab’s most capable tier' },
        { value: 'all', label: 'All', hint: 'T', title: 'Also draw mid and small models as hollow markers' },
      ],
      () => store.get().tierView,
      (v) => store.setTierView(v),
      (v) => (v === 'flagship' ? 'Tiers: flagship only' : 'Tiers: every tier'),
    ),
  );

  /* --------------------------------------------------------------- view actions */

  const viewGroup = el('div', { class: 'cgroup' });
  viewGroup.append(el('span', { class: 'cgroup__label', text: 'View' }));
  const viewRow = el('div', { class: 'cgroup__row' });
  const fitBtn = el('button', { type: 'button', class: 'cbtn', title: 'Fit the axes to the visible data (0)' });
  fitBtn.append(el('span', { text: 'Fit' }), el('kbd', { class: 'seg__key', text: '0', 'aria-hidden': 'true' }));
  fitBtn.addEventListener('click', () => {
    deps.fit();
    if (isSheet()) closeSheet();
  });
  const resetBtn = el('button', { type: 'button', class: 'cbtn', title: 'Reset the zoom (Esc)' });
  resetBtn.append(el('span', { text: 'Reset' }), el('kbd', { class: 'seg__key', text: 'Esc', 'aria-hidden': 'true' }));
  resetBtn.addEventListener('click', () => {
    deps.reset();
    if (isSheet()) closeSheet();
  });
  viewRow.append(fitBtn, resetBtn);
  viewGroup.append(viewRow);
  inner.append(viewGroup);

  /* ------------------------------------------------------------------- the NOW */

  const nowGroup = el('div', { class: 'cgroup cgroup--now' });
  nowGroup.append(el('span', { class: 'cgroup__label', text: 'Now' }));
  const nowRow = el('div', { class: 'cgroup__row' });

  const back = el('button', { type: 'button', class: 'cbtn cbtn--icon', 'aria-label': 'Move the date back 30 days', title: 'Back 30 days (←; shift = one year)' });
  back.append(el('span', { 'aria-hidden': 'true', text: '◀' }));
  back.addEventListener('click', () => store.nudgeAsOf(-30));

  const pill = el('button', { type: 'button', class: 'cbtn cbtn--date', title: 'The date everything is computed as of — click to type one' });
  const pillText = el('span', { class: 'cbtn__date-text', text: 'today' });
  pill.append(pillText);

  const dateInput = el('input', { type: 'date', class: 'cbtn cbtn--dateinput', 'aria-label': 'Compute everything as of' });
  dateInput.hidden = true;
  dateInput.min = store.get().minDate;
  dateInput.max = ctx.today;

  const closeEditor = (): void => {
    dateInput.hidden = true;
    pill.hidden = false;
  };
  pill.addEventListener('click', () => {
    dateInput.value = store.get().asOf;
    pill.hidden = true;
    dateInput.hidden = false;
    dateInput.focus();
  });
  dateInput.addEventListener('change', () => {
    const v = dateInput.value as ISODate;
    if (v) store.setAsOf(v);
    closeEditor();
  });
  dateInput.addEventListener('blur', closeEditor);
  dateInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      closeEditor();
      pill.focus();
    }
  });

  const fwd = el('button', { type: 'button', class: 'cbtn cbtn--icon', 'aria-label': 'Move the date forward 30 days', title: 'Forward 30 days (→; shift = one year)' });
  fwd.append(el('span', { 'aria-hidden': 'true', text: '▶' }));
  fwd.addEventListener('click', () => store.nudgeAsOf(30));

  const todayBtn = el('button', { type: 'button', class: 'cbtn cbtn--accent', title: 'Back to today (Home)', text: 'Back to today' });
  todayBtn.hidden = true;
  todayBtn.addEventListener('click', () => deps.backToToday());

  nowRow.append(back, pill, dateInput, fwd, todayBtn);
  nowGroup.append(nowRow);
  inner.append(nowGroup);

  /* -------------------------------------------------------------------- help */

  const helpGroup = el('div', { class: 'cgroup cgroup--help' });
  helpGroup.append(el('span', { class: 'cgroup__label visually-hidden', text: 'Help' }));
  const helpBtn = el('button', {
    type: 'button',
    class: 'cbtn cbtn--round',
    'aria-label': 'Keyboard shortcuts',
    title: 'Keyboard shortcuts (?)',
    text: '?',
  });
  helpBtn.addEventListener('click', () => deps.help());
  helpGroup.append(helpBtn);
  inner.append(helpGroup);

  syncs.push(() => {
    const st = store.get();
    const scrubbed = st.asOf !== st.today;
    pillText.textContent = scrubbed ? fmtDate(st.asOf) : 'today';
    pill.setAttribute('aria-label', `Computing as of ${scrubbed ? fmtDate(st.asOf) : 'today'} — click to type a date`);
    todayBtn.hidden = !scrubbed;
    dateInput.min = st.minDate;
    dateInput.max = st.today;
    bar.classList.toggle('is-scrubbed', scrubbed);
  });

  /* ------------------------------------------------------------ bottom sheet */

  function openSheet(): void {
    bar.classList.add('is-open');
    fab?.setAttribute('aria-expanded', 'true');
    if (scrim) scrim.hidden = false;
    // Give the sheet the focus so Tab walks it rather than the page behind.
    inner.querySelector<HTMLElement>('button[tabindex="0"], button:not([tabindex="-1"])')?.focus();
  }

  function closeSheet(): void {
    if (!bar.classList.contains('is-open')) return;
    bar.classList.remove('is-open');
    fab?.setAttribute('aria-expanded', 'false');
    if (scrim) scrim.hidden = true;
    fab?.focus();
  }

  const onFab = (): void => {
    if (bar.classList.contains('is-open')) closeSheet();
    else openSheet();
  };
  fab?.addEventListener('click', onFab);
  scrim?.addEventListener('click', closeSheet);
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape' && bar.classList.contains('is-open')) {
      ev.stopPropagation();
      closeSheet();
    }
  };
  document.addEventListener('keydown', onKey, true);
  teardown.push(() => {
    fab?.removeEventListener('click', onFab);
    scrim?.removeEventListener('click', closeSheet);
    document.removeEventListener('keydown', onKey, true);
  });

  const sync = (): void => {
    for (const fn of syncs) fn();
  };
  sync();

  return {
    sync,
    openSheet,
    closeSheet,
    destroy(): void {
      for (const fn of teardown) fn();
      clear(inner);
    },
  };
}
