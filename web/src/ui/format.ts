/** Formatting helpers. English, en-dash for ranges, no emoji (see CLAUDE.md § Style). */
import { RATING_PER_LOGIT } from '@agi/shared';
import type { DatePrecision, ISODate, ISOTimestamp } from '@agi/shared';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const EN_DASH = '–';

function parts(iso: ISODate): [number, number, number] {
  return [Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10))];
}

/** `14 Mar 2023` */
export function fmtDate(iso: ISODate): string {
  const [y, m, d] = parts(iso);
  return `${d} ${MONTHS[m - 1] ?? '?'} ${y}`;
}

/** `Mar 2023` */
export function fmtMonth(iso: ISODate): string {
  const [y, m] = parts(iso);
  return `${MONTHS[m - 1] ?? '?'} ${y}`;
}

/** Date rendered at the precision the dataset actually claims. */
export function fmtDatePrecision(iso: ISODate, precision: DatePrecision): string {
  const [y, m] = parts(iso);
  switch (precision) {
    case 'day':
      return fmtDate(iso);
    case 'month':
      return fmtMonth(iso);
    case 'quarter':
      return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
    case 'year':
      return String(y);
    default:
      return `${fmtMonth(iso)} (date unknown)`;
  }
}

export function precisionLabel(precision: DatePrecision): string {
  return precision === 'day' ? 'exact day' : precision === 'unknown' ? 'date unknown' : `${precision} precision`;
}

/** `6 Sep 2026, 22:00 UTC` */
export function fmtTimestamp(ts: ISOTimestamp | null): string {
  if (!ts) return 'never';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const day = d.getUTCDate();
  const mon = MONTHS[d.getUTCMonth()] ?? '?';
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day} ${mon} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

/** `3 h ago`, `2 d ago` — for the change feed. */
export function fmtAgo(ts: ISOTimestamp, now = Date.now()): string {
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return '';
  const mins = Math.max(0, Math.round((now - t) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days} d ago`;
  return `${Math.round(days / 30)} mo ago`;
}

export function fmtNumber(v: number, digits = 1): string {
  return v.toFixed(digits);
}

/** Thin space between thousands — `1 305`, never `1,305` (the site is English but metric). */
const THIN = ' ';

/** `1 305` — the house format for a Frontier Rating. */
export function fmtRating(v: number): string {
  const n = Math.round(v);
  const sign = n < 0 ? '−' : '';
  const digits = String(Math.abs(n));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += THIN;
    out += digits[i];
  }
  return sign + out;
}

/** `± 34` — the rating half-width of one standard error (REDESIGN §1.2: 173.72 · se). */
export function fmtRatingSe(se: number): string {
  return `± ${Math.round(se * RATING_PER_LOGIT)}`;
}

/** `+42 d` / `−17 d` / en-dash when there is nothing to report. */
export function fmtSignedDays(days: number | null): string {
  if (days === null || !Number.isFinite(days)) return EN_DASH;
  const d = Math.round(days);
  if (d === 0) return '0 d';
  return `${d > 0 ? '+' : '−'}${Math.abs(d)} d`;
}

/** `42 min` / `3 h 10 min` / `2 d 4 h` — a countdown, never negative. */
export function fmtDuration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rest = mins % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days} d ${rest} h` : `${days} d`;
}

/** `Mar 2028` for a level crossing, `Q2 2028` once the window is wider than a year. */
export function fmtMonthRange(a: ISODate, b: ISODate): string {
  return `${fmtMonth(a)} ${EN_DASH} ${fmtMonth(b)}`;
}

/** Pace regimes read as prose in the Stages panel. */
export function regimeLabel(regime: string): string {
  return regime.charAt(0).toUpperCase() + regime.slice(1);
}

/** `86.4` — the house format for an index value. */
export function fmtIndex(v: number): string {
  return v.toFixed(1);
}

export function fmtSigned(v: number, digits = 2): string {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;
}

export function fmtPercent(p: number, digits = 0): string {
  return `${(p * 100).toFixed(digits)}%`;
}

export function fmtDays(days: number): string {
  const d = Math.round(days);
  if (Math.abs(d) < 45) return `${d} day${Math.abs(d) === 1 ? '' : 's'}`;
  const months = d / 30.44;
  if (Math.abs(months) < 24) return `${months.toFixed(months < 10 ? 1 : 0)} months`;
  return `${(d / 365.25).toFixed(1)} years`;
}

export function fmtRange(a: ISODate, b: ISODate): string {
  return `${fmtDate(a)} ${EN_DASH} ${fmtDate(b)}`;
}

export function pluralise(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Guard every user-visible string that ends up inside innerHTML. */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Trim a URL down to something readable in the audit drawer. */
export function shortUrl(url: string, max = 58): string {
  const clean = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/* ---------------------------------------------------------- research cadence */
/* How often the researcher runs is decided by how many people actually read the site
   (REDESIGN §12.8), so the tier ids the worker publishes have to read as English in three places:
   the header countdown, its tooltip and the Researcher panel. */

const CADENCE_TIER: Record<string, string> = {
  weekly: 'weekly',
  often: 'every 3 days',
  daily: 'daily',
  'twice-daily': 'twice a day',
  frequent: 'every 6 hours',
};

/** A tier id as a phrase. An id this build does not know prints itself rather than nothing. */
export function cadenceTier(tier: string): string {
  return CADENCE_TIER[tier] ?? tier;
}

/** The readership the cadence was chosen from, or why there is none yet. */
export function cadenceReaders(c: { visitors_per_day: number; days_measured: number }): string {
  if (c.days_measured <= 0) return 'no traffic measured yet';
  return `${fmtNumber(c.visitors_per_day, 1)} readers a day over ${pluralise(c.days_measured, 'day')}`;
}
