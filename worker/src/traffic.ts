/**
 * Traffic-scaled research cadence (REDESIGN §12.8).
 *
 * The user's ask: "research as often as people actually visit — weekly by default, daily once we
 * have 10 visitors a day, graded nicely." So the researcher's interval is derived from a measured
 * signal instead of a constant: the web container's nginx writes one line per `GET /latest.json`
 * (one per page load) to a log on a volume the worker mounts, and the worker turns that into a
 * count of *daily unique visitors*.
 *
 * Privacy is the constraint that shapes the whole design, because a visitor count is the only
 * thing we want and an address log is the thing we would otherwise be keeping:
 *
 *  - No raw address is ever written to the state file, to a log line, or anywhere else. Addresses
 *    exist only as local variables inside `ingestVisits`, and the nginx log that carries them is
 *    truncated as soon as it has been counted.
 *  - The *open* day stores `sha256(salt || ':' || address)` truncated to 12 hex characters. The
 *    salt is 16 random bytes generated when the day opens and thrown away when it closes, so the
 *    hashes of two different days are unlinkable even for the same visitor: there is no key that
 *    turns one day's set into another's. (A deterministic `sha256(ip + ':' + day)` would let
 *    anyone with the state file confirm "was address X here on day D" for every past day; a random
 *    per-day salt limits that to the single day currently open.)
 *  - A day that has closed keeps only `{ date, unique }` — a bare integer. Nothing per-visitor
 *    survives the day. At most 14 closed days are retained.
 *
 * Crash safety around the truncation (the "copytruncate" pattern — nginx holds the file open
 * `O_APPEND`, so truncating to zero makes it write from offset 0 again):
 *
 *   read the log  →  fold it into the state  →  **persist the state**  →  truncate
 *
 * A crash anywhere in that sequence re-reads the same lines on the next run, so the ordering is
 * only safe because re-ingesting is idempotent, and it is idempotent by construction:
 *   - lines belonging to the still-open day land in a *set*, so a second union changes nothing;
 *   - lines belonging to a day already present in `days` are skipped, because that day was closed
 *     by a state write that had already counted them.
 * The alternative ordering (truncate first) would silently lose a whole day's worth of visits to
 * any crash, and a counter-based fold would double-count them. Neither is acceptable for a number
 * shown on the site.
 *
 * The one loss that remains is inherent to copytruncate: a request logged between the read and the
 * truncate is discarded. `truncateTrafficLog` therefore refuses to truncate when the file grew
 * during the ingest and leaves those lines for the next run (harmless — see idempotence above),
 * falling back to an unconditional truncate only past `MAX_LOG_BYTES`, where unbounded growth is
 * the worse failure.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync, truncateSync } from 'node:fs';
import type { ResearchCadence } from '@agi/shared';

/* ------------------------------------------------------------------ shape */

/** A closed UTC day: the count survives, nothing per-visitor does. */
export interface TrafficDay {
  /** UTC date, `YYYY-MM-DD`. */
  date: string;
  unique: number;
}

/** The day still accepting visits: its throw-away salt and the hashes seen so far. */
export interface OpenTrafficDay {
  date: string;
  /** 16 random bytes, hex. Generated when the day opens, discarded when it closes. */
  salt: string;
  /** Truncated salted hashes, sorted. Never an address. */
  hashes: string[];
}

export interface TrafficState {
  /** Closed days, oldest first, at most `RETAIN_DAYS`. */
  days: TrafficDay[];
  open: OpenTrafficDay | null;
  /** Tier the cadence currently sits at — the anchor the hysteresis moves. */
  tier: TierId;
  /** Consecutive closed days whose mean fell below the current tier's band. */
  below_days: number;
  /** Newest closed day already counted into `below_days`, so an hourly loop steps once a day. */
  below_date: string | null;
  /** Month (`YYYY-MM`) the spend anchor belongs to. */
  spend_month: string | null;
  /** `researcher.usage_total.usd_estimate` as it stood when `spend_month` began. */
  spend_month_start_usd: number;
}

export const EMPTY_TRAFFIC_STATE: TrafficState = {
  days: [],
  open: null,
  tier: 'weekly',
  below_days: 0,
  below_date: null,
  spend_month: null,
  spend_month_start_usd: 0,
};

/** One counted page load. Holds an address, so it never leaves this module's memory. */
export interface TrafficVisit {
  /** UTC date of the request, `YYYY-MM-DD`. */
  day: string;
  address: string;
}

export interface ParsedTrafficLog {
  visits: TrafficVisit[];
  /** Requests dropped by the bot user-agent filter. */
  bots: number;
  /** Well-formed lines that were not a successful `GET /latest.json`. */
  ignored: number;
  /** Lines that did not parse at all (partial write, wrong format, bad address or date). */
  malformed: number;
}

/* -------------------------------------------------------------- constants */

/** Closed days kept in the state. Two weeks is plenty for a 7-day mean plus a look back. */
export const RETAIN_DAYS = 14;
/** Days averaged into `visitors_per_day`. */
export const MEAN_WINDOW_DAYS = 7;
/** Closed days a tier must stay below its band before the cadence slows down. */
export const HYSTERESIS_DAYS = 2;
/** Hash prefix length. 48 bits: collisions are negligible at any traffic this site will see. */
export const HASH_PREFIX_LEN = 12;
/** Past this size the log is truncated even if it grew mid-ingest; unbounded growth is worse. */
export const MAX_LOG_BYTES = 8 * 1024 * 1024;

/**
 * Automated clients, excluded from the count. Deliberately crude: a visitor number that is a
 * little low is honest, one inflated by crawlers is not, and this list costs nothing to widen.
 */
export const BOT_UA_RE = /bot|crawl|spider|curl|wget|python-requests|Go-http|HeadlessChrome/i;

/** The one path a page load fetches (`web/src/ui/progress.ts` repaints from memory, no refetch). */
export const VISIT_PATH = '/latest.json';

export type TierId = 'weekly' | 'often' | 'daily' | 'twice-daily' | 'frequent';

export interface CadenceTier {
  id: TierId;
  /** Lowest daily-visitor mean that reaches this tier. */
  minVisitors: number;
  intervalHours: number;
}

/**
 * REDESIGN §12.8. Ordered slowest → fastest; the index doubles as the hysteresis rank.
 * (§12.8 spells the top tier `hourly-ish`; the published contract in `shared/src/types.ts` calls
 * it `frequent`, and the contract is what the site renders, so `frequent` wins.)
 */
export const CADENCE_TIERS: readonly CadenceTier[] = [
  { id: 'weekly', minVisitors: 0, intervalHours: 24 * 7 },
  { id: 'often', minVisitors: 3, intervalHours: 24 * 3 },
  { id: 'daily', minVisitors: 10, intervalHours: 24 },
  { id: 'twice-daily', minVisitors: 30, intervalHours: 12 },
  { id: 'frequent', minVisitors: 100, intervalHours: 6 },
];

export const SLOWEST_TIER = CADENCE_TIERS[0] as CadenceTier;

export function tierById(id: TierId): CadenceTier {
  return CADENCE_TIERS.find((t) => t.id === id) ?? SLOWEST_TIER;
}

function tierRank(id: TierId): number {
  const i = CADENCE_TIERS.findIndex((t) => t.id === id);
  return i < 0 ? 0 : i;
}

/** The band a mean falls into. Highest tier whose threshold the mean reaches. */
export function tierFor(visitorsPerDay: number): CadenceTier {
  let chosen = SLOWEST_TIER;
  for (const t of CADENCE_TIERS) if (visitorsPerDay >= t.minVisitors) chosen = t;
  return chosen;
}

/* ----------------------------------------------------------------- dates */

/** UTC calendar date of an instant, `YYYY-MM-DD`. Days are UTC so the boundary never moves. */
export function utcDay(at: number | Date): string {
  const d = at instanceof Date ? at : new Date(at);
  return d.toISOString().slice(0, 10);
}

/** UTC month of an instant, `YYYY-MM` — the window the spend guard resets on. */
export function utcMonth(at: number | Date): string {
  const d = at instanceof Date ? at : new Date(at);
  return d.toISOString().slice(0, 7);
}

function addDaysUtc(date: string, days: number): string {
  return utcDay(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000);
}

/* ---------------------------------------------------------------- parsing */

/**
 * `log_format traffic '$http_x_forwarded_for|$time_iso8601|$request_method|$uri|$status|
 * $http_user_agent'`. Pipe-separated because none of the first five fields can contain a pipe;
 * the user-agent can, so everything after the fifth separator is re-joined.
 */
export function parseTrafficLine(line: string): TrafficVisit | 'ignored' | 'bot' | null {
  const trimmed = line.trim();
  if (!trimmed) return 'ignored';
  const parts = trimmed.split('|');
  if (parts.length < 6) return null;
  const [rawAddr = '', rawTs = '', method = '', uri = '', rawStatus = ''] = parts;
  const ua = parts.slice(5).join('|');

  // The host nginx sets X-Forwarded-For; a proxy chain appends, so the client is the first entry.
  const address = (rawAddr.split(',')[0] ?? '').trim();
  if (!address || address === '-' || !/^[0-9a-fA-F:.]+$/.test(address)) return null;

  const at = Date.parse(rawTs);
  if (!Number.isFinite(at)) return null;

  const status = Number.parseInt(rawStatus, 10);
  if (!Number.isFinite(status)) return null;

  // A conditional request answered 304 is still a page load (the bundle is cached for 300 s);
  // an error is not a visit.
  const served = (status >= 200 && status < 300) || status === 304;
  if (method !== 'GET' || uri !== VISIT_PATH || !served) return 'ignored';

  if (BOT_UA_RE.test(ua)) return 'bot';
  return { day: utcDay(at), address };
}

export function parseTrafficLog(text: string): ParsedTrafficLog {
  const out: ParsedTrafficLog = { visits: [], bots: 0, ignored: 0, malformed: 0 };
  for (const line of text.split('\n')) {
    const r = parseTrafficLine(line);
    if (r === null) out.malformed++;
    else if (r === 'bot') out.bots++;
    else if (r === 'ignored') out.ignored++;
    else out.visits.push(r);
  }
  return out;
}

/* --------------------------------------------------------------- counting */

export function newSalt(): string {
  return randomBytes(16).toString('hex');
}

/** The only representation of a visitor that is ever persisted. */
export function hashAddress(address: string, salt: string): string {
  return createHash('sha256').update(salt).update(':').update(address).digest('hex').slice(0, HASH_PREFIX_LEN);
}

/**
 * Fold a batch of visits into the state, then close every day that is no longer today.
 *
 * Idempotent by construction (see the file header): a day already in `days` is skipped, and the
 * open day is a set. Out-of-order lines are handled by bucketing the whole batch before merging,
 * so the fold does not depend on nginx writing in timestamp order.
 */
export function ingestVisits(
  state: TrafficState,
  visits: readonly TrafficVisit[],
  now: number | Date = Date.now(),
  saltFn: () => string = newSalt,
): TrafficState {
  const today = utcDay(now);
  const closed = new Set(state.days.map((d) => d.date));
  const horizon = addDaysUtc(today, -RETAIN_DAYS);

  const buckets = new Map<string, { salt: string; hashes: Set<string> }>();
  if (state.open) buckets.set(state.open.date, { salt: state.open.salt, hashes: new Set(state.open.hashes) });

  for (const v of visits) {
    // Already counted before a crash, or older than anything we still retain.
    if (closed.has(v.day) || v.day < horizon) continue;
    let bucket = buckets.get(v.day);
    if (!bucket) {
      bucket = { salt: saltFn(), hashes: new Set<string>() };
      buckets.set(v.day, bucket);
    }
    bucket.hashes.add(hashAddress(v.address, bucket.salt));
  }

  const dates = [...buckets.keys()].sort();
  const newestDate = dates[dates.length - 1];
  const days = [...state.days];
  let open: OpenTrafficDay | null = null;

  for (const date of dates) {
    const bucket = buckets.get(date) as { salt: string; hashes: Set<string> };
    if (date === newestDate && date >= today) {
      // Still accepting visits: keep the salt and the set.
      open = { date, salt: bucket.salt, hashes: [...bucket.hashes].sort() };
    } else {
      // Closing: the count is all that survives, and the salt goes with the hashes.
      days.push({ date, unique: bucket.hashes.size });
    }
  }

  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { ...state, days: days.slice(Math.max(0, days.length - RETAIN_DAYS)), open };
}

/** Mean unique visitors over the last `MEAN_WINDOW_DAYS` *closed* days (the open one is partial). */
export function visitorsPerDay(state: TrafficState): { mean: number; days: number } {
  const window = state.days.slice(Math.max(0, state.days.length - MEAN_WINDOW_DAYS));
  if (window.length === 0) return { mean: 0, days: 0 };
  const total = window.reduce((s, d) => s + d.unique, 0);
  return { mean: Math.round((total / window.length) * 100) / 100, days: window.length };
}

/**
 * Move the tier towards `target`, asymmetrically (REDESIGN §12.8): up immediately — traffic that
 * has arrived deserves fresher data now — but down only after `HYSTERESIS_DAYS` consecutive closed
 * days below the band, so a quiet weekend does not undo a week of growth.
 *
 * The counter advances at most once per closed day (`below_date`), because the loop calls this
 * hourly and "two consecutive days" must mean days, not iterations.
 */
export function applyHysteresis(state: TrafficState, target: TierId): TrafficState {
  const current = state.tier;
  if (tierRank(target) > tierRank(current)) {
    return { ...state, tier: target, below_days: 0, below_date: null };
  }
  if (tierRank(target) === tierRank(current)) {
    return state.below_days === 0 && state.below_date === null ? state : { ...state, below_days: 0, below_date: null };
  }
  const newest = state.days[state.days.length - 1]?.date ?? null;
  if (newest === null || newest === state.below_date) return state; // same day: do not advance twice
  const below = state.below_days + 1;
  if (below >= HYSTERESIS_DAYS) return { ...state, tier: target, below_days: 0, below_date: null };
  return { ...state, below_days: below, below_date: newest };
}

/**
 * Month-to-date OpenRouter spend. `researcher.usage_total` is a lifetime counter, so the
 * month-to-date figure is the difference from an anchor taken when the month rolled over. The
 * anchor is re-taken (and can only move forward) whenever the UTC month changes.
 */
export function monthToDateUsd(
  state: TrafficState,
  usageTotalUsd: number,
  now: number | Date = Date.now(),
): { state: TrafficState; usd: number } {
  const month = utcMonth(now);
  if (state.spend_month !== month) {
    return { state: { ...state, spend_month: month, spend_month_start_usd: usageTotalUsd }, usd: 0 };
  }
  // A lifetime total that went backwards (a wiped state file) would give a negative month; clamp.
  return { state, usd: Math.max(0, usageTotalUsd - state.spend_month_start_usd) };
}

/* ---------------------------------------------------------------- cadence */

export interface CadenceInput {
  traffic: TrafficState;
  /** `researcher.usage_total.usd_estimate`, or 0 when nothing has been spent yet. */
  usageTotalUsd: number;
  /** `RESEARCH_MONTHLY_USD`. Zero or negative disables the guard. */
  monthlyBudgetUsd: number;
  /** `researcher.last_backfill_at` — null means "never ran", i.e. run now. */
  lastResearchAt: string | null;
  now?: number | Date;
}

/**
 * The published cadence plus the traffic state it advanced (hysteresis and the spend anchor are
 * both stateful, so this returns the state rather than mutating it).
 */
export function computeCadence(input: CadenceInput): { traffic: TrafficState; cadence: ResearchCadence } {
  const now = input.now ?? Date.now();
  const measured = visitorsPerDay(input.traffic);
  let traffic = applyHysteresis(input.traffic, tierFor(measured.mean).id);

  const spend = monthToDateUsd(traffic, input.usageTotalUsd, now);
  traffic = spend.state;
  const capped = input.monthlyBudgetUsd > 0 && spend.usd >= input.monthlyBudgetUsd;

  // The cap overrides the tier for as long as the month is over budget, but it does not rewrite
  // `traffic.tier`: when the month rolls over the cadence snaps back to what the traffic earned.
  const tier = capped ? SLOWEST_TIER : tierById(traffic.tier);
  const lastMs = input.lastResearchAt ? Date.parse(input.lastResearchAt) : Number.NaN;
  const next = Number.isFinite(lastMs) ? new Date(lastMs + tier.intervalHours * 3_600_000) : null;

  return {
    traffic,
    cadence: {
      tier: tier.id,
      interval_hours: tier.intervalHours,
      visitors_per_day: measured.mean,
      days_measured: measured.days,
      capped,
      next_research_at: next ? next.toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
    },
  };
}

/* ------------------------------------------------------------------- I/O */

export interface TrafficLogRead {
  text: string;
  /** Bytes consumed — `truncateTrafficLog` refuses to discard anything beyond them. */
  bytes: number;
}

/** Null when the log does not exist yet (no deploy, no traffic, or a dev machine). */
export function readTrafficLog(path: string): TrafficLogRead | null {
  if (!existsSync(path)) return null;
  try {
    const buf = readFileSync(path);
    return { text: buf.toString('utf8'), bytes: buf.byteLength };
  } catch {
    return null;
  }
}

/**
 * Truncate to zero (copytruncate: nginx keeps writing through its `O_APPEND` handle, which now
 * lands at offset 0). Skipped when the file grew during the ingest — those lines have not been
 * counted, and re-reading them next run is free because the fold is idempotent. Past
 * `MAX_LOG_BYTES` it truncates anyway: a handful of lost lines beats a log that never shrinks.
 */
export function truncateTrafficLog(path: string, bytesRead: number): boolean {
  try {
    const size = statSync(path).size;
    if (size !== bytesRead && size <= MAX_LOG_BYTES) return false;
    truncateSync(path, 0);
    return true;
  } catch {
    return false;
  }
}

export interface IngestOptions {
  path: string;
  state: TrafficState;
  /**
   * Persist the folded state. Called **before** the log is truncated — that ordering is what makes
   * a crash re-read rather than lose, so it is a parameter instead of a caller convention.
   */
  commit: (next: TrafficState) => void;
  now?: number | Date;
  saltFn?: () => string;
}

export interface IngestResult extends ParsedTrafficLog {
  state: TrafficState;
  /** False when there was no log to read at all. */
  read: boolean;
  truncated: boolean;
}

/**
 * Read → fold → persist → truncate. See the file header for why the order matters.
 *
 * The fold runs even when there is no log to read (no deploy yet, or an empty hour): it is also
 * what rolls yesterday's open day into a closed count, and the mean and the hysteresis both need
 * that to happen on schedule rather than only when somebody visits.
 */
export function ingestTrafficLog(opts: IngestOptions): IngestResult {
  const now = opts.now ?? Date.now();
  const saltFn = opts.saltFn ?? newSalt;
  const raw = readTrafficLog(opts.path);
  const parsed = raw ? parseTrafficLog(raw.text) : { visits: [], bots: 0, ignored: 0, malformed: 0 };

  const state = ingestVisits(opts.state, parsed.visits, now, saltFn);
  opts.commit(state);
  const truncated = raw ? truncateTrafficLog(opts.path, raw.bytes) : false;
  return { ...parsed, state, read: raw !== null, truncated };
}
