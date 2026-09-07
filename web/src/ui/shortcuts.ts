/**
 * Keyboard shortcuts and the `?` sheet that lists them.
 *
 * The sheet is a native `<dialog>` opened with `showModal()`, so the focus trap, the backdrop
 * and Escape-to-close are the platform's rather than ours. The key handler deliberately does
 * nothing while the reader is typing in a field (the date pill is one), and nothing while a
 * modal is open except closing it.
 */
import type { Store } from '../state';
import { announce, el, maybe } from '../dom';

export interface ShortcutRow {
  keys: string[];
  action: string;
}

/** The one list — the sheet renders it and the handler below implements exactly these. */
export const SHORTCUTS: ShortcutRow[] = [
  { keys: ['R'], action: 'Frontier Rating axis' },
  { keys: ['I'], action: 'Frontier Index axis' },
  { keys: ['S'], action: 'Range — story (2018→) / recent (2023→)' },
  { keys: ['F'], action: 'Forecast — next release / long chain' },
  { keys: ['B'], action: 'Family bands on / off' },
  { keys: ['T'], action: 'Tiers — flagship only / all tiers' },
  { keys: ['0'], action: 'Fit the axes to the visible data' },
  { keys: ['Esc'], action: 'Reset the zoom (or close this sheet)' },
  { keys: ['←', '→'], action: 'Move NOW by 30 days' },
  { keys: ['Shift', '←', '→'], action: 'Move NOW by one year' },
  { keys: ['Home'], action: 'Back to today' },
  { keys: ['+', '−'], action: 'Zoom the time axis in / out' },
  { keys: ['?'], action: 'This sheet' },
];

export interface ShortcutSheet {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  destroy(): void;
}

export function createShortcutSheet(): ShortcutSheet {
  const dialog = el('dialog', { class: 'sheet', 'aria-labelledby': 'shortcut-title' }) as HTMLDialogElement;

  const head = el('header', { class: 'sheet__head' });
  head.append(el('h2', { class: 'sheet__title', id: 'shortcut-title', text: 'Keyboard shortcuts' }));
  const close = el('button', { type: 'button', class: 'sheet__close', 'aria-label': 'Close', text: '×' });
  close.addEventListener('click', () => dialog.close());
  head.append(close);

  const list = el('dl', { class: 'sheet__list' });
  for (const row of SHORTCUTS) {
    const dt = el('dt');
    row.keys.forEach((k, i) => {
      if (i > 0) dt.append(el('span', { class: 'sheet__plus', text: row.keys.length > 2 && i === 1 ? '+' : '/' }));
      dt.append(el('kbd', { text: k }));
    });
    list.append(dt, el('dd', { text: row.action }));
  }

  const foot = el('p', {
    class: 'sheet__foot',
    text: 'Shortcuts are ignored while you are typing. On the chart itself: drag to pan, wheel to zoom time, shift + wheel to zoom the axis, and drag the NOW rule to replay the past.',
  });

  dialog.append(head, list, foot);
  document.body.append(dialog);

  return {
    open(): void {
      if (!dialog.open) dialog.showModal();
    },
    close(): void {
      if (dialog.open) dialog.close();
    },
    toggle(): void {
      if (dialog.open) dialog.close();
      else dialog.showModal();
    },
    isOpen(): boolean {
      return dialog.open;
    },
    destroy(): void {
      dialog.remove();
    },
  };
}

export interface ShortcutDeps {
  store: Store;
  sheet: ShortcutSheet;
  fit(): void;
  reset(): void;
  zoom(k: number): void;
}

/** True when the event came from somewhere a keystroke means text, not a command. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** Bind the shortcuts to the document. Returns the detach function. */
export function attachShortcuts(deps: ShortcutDeps): () => void {
  const { store, sheet } = deps;

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (typing(ev.target)) return;

    if (ev.key === 'Escape') {
      // Native <dialog> already closes itself; the drawer handles its own Escape. Anything left
      // over means "reset the chart".
      if (sheet.isOpen()) return;
      if (!maybe('[data-drawer]')?.hidden) return;
      deps.reset();
      announce('Zoom reset');
      return;
    }
    if (sheet.isOpen()) return;

    const hit = (msg: string): void => {
      ev.preventDefault();
      announce(msg);
    };

    switch (ev.key) {
      case '?':
        ev.preventDefault();
        sheet.open();
        return;
      case 'r':
      case 'R':
        store.setYMode('rating');
        hit('Axis: Frontier Rating');
        return;
      case 'i':
      case 'I':
        store.setYMode('index');
        hit('Axis: Frontier Index');
        return;
      case 's':
      case 'S': {
        const next = store.get().range === 'story' ? 'recent' : 'story';
        store.setRange(next);
        hit(next === 'story' ? 'Range: the whole story, from 2018' : 'Range: recent, from 2023');
        return;
      }
      case 'f':
      case 'F': {
        const next = store.get().forecast === 'next' ? 'long' : 'next';
        store.setForecast(next);
        hit(next === 'next' ? 'Forecast: the next release per lab' : 'Forecast: the full chain');
        return;
      }
      case 'b':
      case 'B': {
        const next = !store.get().bands;
        store.setBands(next);
        hit(next ? 'Family bands on' : 'Family bands off');
        return;
      }
      case 't':
      case 'T': {
        const next = store.get().tierView === 'flagship' ? 'all' : 'flagship';
        store.setTierView(next);
        hit(next === 'flagship' ? 'Tiers: flagship only' : 'Tiers: every tier');
        return;
      }
      case '0':
        deps.fit();
        hit('Axes fitted to the visible data');
        return;
      case 'ArrowLeft':
        store.nudgeAsOf(ev.shiftKey ? -365 : -30);
        ev.preventDefault();
        return;
      case 'ArrowRight':
        store.nudgeAsOf(ev.shiftKey ? 365 : 30);
        ev.preventDefault();
        return;
      case 'Home':
        store.backToToday();
        hit('Back to today');
        return;
      case '+':
      case '=':
        deps.zoom(1.4);
        ev.preventDefault();
        return;
      case '-':
      case '_':
        deps.zoom(1 / 1.4);
        ev.preventDefault();
        return;
      default:
    }
  };

  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}
