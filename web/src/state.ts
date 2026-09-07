/**
 * App state: the scrubbed `asOf` date, lab filters, the selected release (audit drawer)
 * and the chart's own view flags. Deliberately tiny — one store, typed channels, no framework.
 */
import { addDays, type ISODate, type LabId } from '@agi/shared';

export type Channel = 'asOf' | 'filters' | 'selection' | 'hover' | 'view';

/** Y axis labelling: both modes are linear in θ — only the tick labels differ. */
export type YMode = 'rating' | 'index';
/** Left edge of the chart: `story` = from the first release (2018), `recent` = 2023→. */
export type RangeMode = 'story' | 'recent';
/** Forecast depth: `next` = one release ahead per lab, `long` = the full chain (up to 24). */
export type ForecastMode = 'next' | 'long';
/** `all` also draws mid/small releases as small markers on the chart. */
export type TierView = 'flagship' | 'all';

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
  /** Y axis labels: Frontier Rating (default) or the bounded Frontier Index. */
  yMode: YMode;
  /** Left edge of the chart: the first release (`story`) or 2023 (`recent`). */
  range: RangeMode;
  /** Forecast depth: one release ahead (`next`) or the full chain (`long`). */
  forecast: ForecastMode;
  /** "Fit to data" y-axis toggle. */
  fitY: boolean;
  /** Family bands under the lab lines. */
  bands: boolean;
  /** Which tiers get markers on the chart. */
  tierView: TierView;
}

type Listener = (channels: Set<Channel>) => void;

export class Store {
  private state: StateShape;
  private listeners = new Set<Listener>();
  private queued = new Set<Channel>();
  private frame = 0;

  constructor(
    init: Pick<StateShape, 'asOf' | 'today' | 'minDate'> &
      Partial<Pick<StateShape, 'yMode' | 'range' | 'forecast' | 'bands' | 'tierView'>>,
  ) {
    this.state = {
      ...init,
      hidden: new Set<LabId>(),
      solo: null,
      selected: null,
      hover: null,
      hoverLab: null,
      // The pre-redesign page passes 'logit' — normalise anything unknown to the new default
      // so the transient old main.ts cannot put the axis in a dead mode (T34 rewrites main.ts).
      yMode: init.yMode === 'index' || init.yMode === 'rating' ? init.yMode : 'rating',
      range: init.range ?? 'story',
      forecast: init.forecast ?? 'next',
      fitY: false,
      bands: init.bands ?? true,
      tierView: init.tierView ?? 'flagship',
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

  private clamp(date: ISODate): ISODate {
    return date < this.state.minDate ? this.state.minDate : date > this.state.today ? this.state.today : date;
  }

  setAsOf(date: ISODate): void {
    const clamped = this.clamp(date);
    if (clamped === this.state.asOf) return;
    this.state.asOf = clamped;
    this.emit('asOf');
  }

  /** Move the scrubber by a signed number of days, clamped — the ◀ ▶ buttons. */
  nudgeAsOf(days: number): void {
    this.setAsOf(addDays(this.state.asOf, Math.round(days)));
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

  setYMode(mode: YMode): void {
    if (this.state.yMode === mode) return;
    this.state.yMode = mode;
    this.emit('view');
  }

  setRange(mode: RangeMode): void {
    if (this.state.range === mode) return;
    this.state.range = mode;
    this.emit('view');
  }

  setForecast(mode: ForecastMode): void {
    if (this.state.forecast === mode) return;
    this.state.forecast = mode;
    this.emit('view');
  }

  setFitY(on: boolean): void {
    if (this.state.fitY === on) return;
    this.state.fitY = on;
    this.emit('view');
  }

  setBands(on: boolean): void {
    if (this.state.bands === on) return;
    this.state.bands = on;
    this.emit('view');
  }

  setTierView(view: TierView): void {
    if (this.state.tierView === view) return;
    this.state.tierView = view;
    this.emit('view');
  }
}
