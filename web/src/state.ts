/**
 * App state: the scrubbed `asOf` date, lab filters, the selected release (audit drawer)
 * and the chart's own view flags. Deliberately tiny — one store, typed channels, no framework.
 */
import type { ISODate, LabId } from '@agi/shared';

export type Channel = 'asOf' | 'filters' | 'selection' | 'hover' | 'view';

export type YMode = 'logit' | 'linear';

export interface StateShape {
  /** Everything on the page is computed as of this date. */
  asOf: ISODate;
  /** Today (UTC) — the upper bound of the scrubber. */
  today: ISODate;
  /** Earliest date the scrubber may reach. */
  minDate: ISODate;
  /** Labs the user switched off in the legend. */
  hidden: Set<LabId>;
  /** Double-click on a chip solos a lab; null = no solo. */
  solo: LabId | null;
  /** Release id shown in the audit drawer. */
  selected: string | null;
  /** Release id under the pointer / keyboard focus. */
  hover: string | null;
  /** Lab under the pointer in the legend — focuses that lab on the chart. */
  hoverLab: LabId | null;
  /** Y axis: linear in latent ability θ (logit) or in the 0–100 index. */
  yMode: YMode;
  /** Left edge of the chart: the first release (true) or the start of the modern basket era, 2023 (false). */
  fullHistory: boolean;
  /** "Fit to data" y-axis toggle. */
  fitY: boolean;
  /**
   * "Long-range forecast (3 years)": the full chained forecast and the 3-year right edge.
   * Off by default — see `chart/forecast.ts` for what the default view draws instead.
   */
  longRange: boolean;
}

type Listener = (channels: Set<Channel>) => void;

export class Store {
  private state: StateShape;
  private listeners = new Set<Listener>();
  private queued = new Set<Channel>();
  private frame = 0;

  constructor(
    init: Pick<StateShape, 'asOf' | 'today' | 'minDate'> & { longRange?: boolean; yMode?: YMode; fullHistory?: boolean },
  ) {
    this.state = {
      ...init,
      hidden: new Set<LabId>(),
      solo: null,
      selected: null,
      hover: null,
      hoverLab: null,
      yMode: init.yMode ?? 'logit',
      fullHistory: init.fullHistory ?? true,
      fitY: false,
      longRange: init.longRange ?? false,
    };
  }

  get(): Readonly<StateShape> {
    return this.state;
  }

  /** True when the scrubber has been moved off today. */
  get scrubbed(): boolean {
    return this.state.asOf !== this.state.today;
  }

  /** Is this lab drawn right now (solo wins over hidden)? */
  visible(lab: LabId): boolean {
    if (this.state.solo) return this.state.solo === lab;
    return !this.state.hidden.has(lab);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(channel: Channel): void {
    this.queued.add(channel);
    if (this.frame) return;
    // rAF coalesces bursts (scrubber drags) into one render per frame — but it never fires in a
    // hidden tab, so fall back to a macrotask there rather than queueing changes indefinitely.
    const schedule =
      typeof document !== 'undefined' && document.hidden
        ? (fn: () => void) => window.setTimeout(fn, 0)
        : (fn: () => void) => requestAnimationFrame(fn);
    this.frame = schedule(() => {
      this.frame = 0;
      const channels = this.queued;
      this.queued = new Set();
      for (const fn of this.listeners) fn(channels);
    });
  }

  setAsOf(date: ISODate): void {
    const clamped = date < this.state.minDate ? this.state.minDate : date > this.state.today ? this.state.today : date;
    if (clamped === this.state.asOf) return;
    this.state.asOf = clamped;
    this.emit('asOf');
  }

  backToToday(): void {
    this.setAsOf(this.state.today);
  }

  toggleLab(lab: LabId): void {
    if (this.state.solo) {
      // Leaving solo mode by clicking any chip restores everything, then applies the click.
      this.state.solo = null;
      this.state.hidden.clear();
    }
    if (this.state.hidden.has(lab)) this.state.hidden.delete(lab);
    else this.state.hidden.add(lab);
    this.emit('filters');
  }

  soloLab(lab: LabId): void {
    this.state.solo = this.state.solo === lab ? null : lab;
    this.state.hidden.clear();
    this.emit('filters');
  }

  resetLabs(): void {
    this.state.solo = null;
    this.state.hidden.clear();
    this.emit('filters');
  }

  select(id: string | null): void {
    if (this.state.selected === id) return;
    this.state.selected = id;
    this.emit('selection');
  }

  setHover(id: string | null): void {
    if (this.state.hover === id) return;
    this.state.hover = id;
    this.emit('hover');
  }

  setHoverLab(lab: LabId | null): void {
    if (this.state.hoverLab === lab) return;
    this.state.hoverLab = lab;
    this.emit('hover');
  }

  setFullHistory(on: boolean): void {
    if (this.state.fullHistory === on) return;
    this.state.fullHistory = on;
    this.emit('view');
  }

  setYMode(mode: YMode): void {
    if (this.state.yMode === mode) return;
    this.state.yMode = mode;
    this.emit('view');
  }

  setFitY(on: boolean): void {
    if (this.state.fitY === on) return;
    this.state.fitY = on;
    this.emit('view');
  }

  setLongRange(on: boolean): void {
    if (this.state.longRange === on) return;
    this.state.longRange = on;
    this.emit('view');
  }
}
