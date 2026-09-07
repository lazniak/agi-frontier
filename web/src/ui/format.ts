/** Formatting helpers. English, en-dash for ranges, no emoji (see CLAUDE.md § Style). */
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
