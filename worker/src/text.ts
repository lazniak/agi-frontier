/**
 * Text normalisation, quote matching, slugs and hashing.
 *
 * The same normaliser is used for (a) hashing polled pages, (b) checking that an LLM-produced
 * quote really occurs on the page, and (c) `verify`. Nothing reaches `data/` without passing
 * `quoteMatches` against the fetched page text.
 */
import { createHash } from 'node:crypto';

/** Curly quotes / apostrophes / dashes / ellipsis folded to ASCII. NFKC does not do these. */
const CHAR_FOLD: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'",
  '´': "'", '`': "'", 'ʼ': "'", '‵': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"',
  '«': '"', '»': '"', '‶': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-',
  '―': '-', '−': '-', '⁃': '-', '－': '-',
  '…': '...',
};

const FOLD_RE = new RegExp(
  '[' + Object.keys(CHAR_FOLD).map((c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('') + ']',
  'g',
);
/** Zero-width, bidi and soft-hyphen characters that HTML extraction leaves behind. */
const INVISIBLE_RE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g;

/**
 * NFKC, fold quotes/dashes, drop invisibles, collapse all whitespace to single spaces, trim.
 * Case is preserved — use {@link normaliseForMatch} for comparisons.
 */
export function normaliseText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(INVISIBLE_RE, '')
    .replace(FOLD_RE, (c) => CHAR_FOLD[c] ?? c)
    .replace(/\s+/g, ' ')
    .trim();
}

export function normaliseForMatch(input: string): string {
  return normaliseText(input).toLowerCase();
}

/** `1,234` -> `1234` (thousands separators only; `80.9` is untouched). */
export function stripNumberCommas(s: string): string {
  return s.replace(/(\d),(?=\d)/g, '$1');
}

function stripSpaces(s: string): string {
  return s.replace(/ /g, '');
}

/** `[GPT-5 Turbo](https://…)` -> `GPT-5 Turbo`. r.jina.ai returns Markdown, and a quoted
 *  sentence very often runs straight through a link. */
export function stripMarkdownLinks(s: string): string {
  return s.replace(/\[([^\]\n]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1');
}

/** Screen-reader text that lab sites inject inside link labels. */
const LINK_BOILERPLATE_RE = /\(\s*opens?(?:\s+up)?\s+in\s+(?:a\s+)?new\s+(?:window|tab)[^)]*\)/gi;

/** Remove link syntax and accessibility decorations, then re-collapse whitespace. */
export function stripLinkDecoration(s: string): string {
  return stripMarkdownLinks(s).replace(LINK_BOILERPLATE_RE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * True when `quote` occurs in `pageText` after normalisation.
 *
 * Three passes, cheapest first: exact (normalised), thousands-separators removed, and — for
 * quotes long enough that a collision is implausible — spaces removed as well (HTML-to-text
 * extraction frequently inserts or drops a space inside a sentence). All three run a second
 * time on both sides with Markdown link syntax and "(opens in a new window)" stripped out.
 */
export function quoteMatches(pageText: string, quote: string | undefined | null): boolean {
  const quoteNorm = normaliseForMatch(quote ?? '');
  const pageNorm = normaliseForMatch(pageText);
  if (!quoteNorm || !pageNorm) return false;
  if (contains(pageNorm, quoteNorm)) return true;

  const pageClean = stripLinkDecoration(pageNorm);
  if (pageClean === pageNorm) return false;
  return contains(pageClean, stripLinkDecoration(quoteNorm));
}

function contains(page: string, quote: string): boolean {
  if (!quote) return false;
  if (page.includes(quote)) return true;
  const page2 = stripNumberCommas(page);
  const quote2 = stripNumberCommas(quote);
  if (page2.includes(quote2)) return true;
  return quote.length >= 12 && stripSpaces(page2).includes(stripSpaces(quote2));
}

/** Number spellings we accept as "the quote contains the value". */
export function valueVariants(value: number): string[] {
  const out = new Set<string>([
    String(value),
    value.toFixed(1),
    value.toFixed(2),
    String(Math.round(value)),
  ]);
  if (Number.isInteger(value)) out.add(value.toFixed(0));
  return [...out];
}

/** A score quote is only usable if the number itself appears in it. */
export function quoteContainsValue(quote: string, value: number): boolean {
  const q = stripNumberCommas(normaliseForMatch(quote));
  return valueVariants(value).some((v) => q.includes(v));
}

/**
 * `GPT-5.1` -> `gpt-5.1`, `Claude Opus 4.5` -> `claude-opus-4.5`.
 * Lowercase, spaces to dashes, dots and digits kept, everything else dropped.
 */
export function slugify(name: string): string {
  return normaliseForMatch(name)
    .replace(/[\s_/]+/g, '-')
    .replace(/[^a-z0-9.-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '');
}

/** `<lab>-<slug>` — must satisfy the schema's id regex. */
export function releaseId(lab: string, name: string): string {
  return `${lab}-${slugify(name)}`;
}

export const RELEASE_ID_RE = /^[a-z0-9]+(-[a-z0-9.]+)+$/;

export function isValidReleaseId(id: string): boolean {
  return RELEASE_ID_RE.test(id);
}

/** Case- and space-insensitive key for matching a model name against existing releases. */
export function nameKey(name: string): string {
  return normaliseForMatch(name).replace(/[^a-z0-9.]/g, '');
}

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function sha1(s: string): string {
  return createHash('sha1').update(s, 'utf8').digest('hex');
}

/** Cut long page text for the LLM prompt without splitting mid-word. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.9 ? cut.slice(0, lastSpace) : cut) + '\n[...truncated]';
}
