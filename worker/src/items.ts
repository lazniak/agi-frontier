/**
 * Turn a fetched page into a list of "items" (candidate announcements) per source kind,
 * and produce the stable fingerprint that the hash-diff in `poll` compares between runs.
 */
import { XMLParser } from 'fast-xml-parser';
import type { LabSource } from '@agi/shared';
import { htmlToText } from './fetcher';
import type { PageFetch } from './fetcher';
import { normaliseText, sha256 } from './text';

export interface SourceItem {
  /** Stable identity used for "have we seen this before": the link when there is one. */
  key: string;
  title: string;
  link?: string;
  /** ISO date/timestamp as published, when the source gives one. */
  date?: string;
}

const MAX_ITEMS = 400;

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  processEntities: true,
});

export function extractItems(kind: LabSource['kind'], page: PageFetch, baseUrl: string): SourceItem[] {
  const body = page.raw || page.text;
  const primary =
    kind === 'rss' ? parseFeed(body)
    : kind === 'hf-org' ? parseHuggingFace(body)
    : kind === 'json' ? parseJson(body, baseUrl)
    : parseHtml(page.raw, page.text, baseUrl);
  // A page read through r.jina.ai comes back as Markdown, so the XML/JSON/HTML parsers find
  // nothing. Fall back to the Markdown reader rather than silently reporting an empty source.
  const items = primary.length > 0 ? primary : parseMarkdown(page.text, baseUrl);
  return dedupe(items).slice(0, MAX_ITEMS);
}

/** Text whose sha256 is stored in `.state/hashes.json`. Item list, not raw HTML — raw HTML churns on every request. */
export function itemsFingerprint(items: SourceItem[]): string {
  return items
    .map((i) => `${i.key}\t${normaliseText(i.title)}\t${i.date ?? ''}`)
    .sort()
    .join('\n');
}

export function hashItems(items: SourceItem[]): string {
  return sha256(itemsFingerprint(items));
}

function dedupe(items: SourceItem[]): SourceItem[] {
  const seen = new Set<string>();
  const out: SourceItem[] = [];
  for (const item of items) {
    if (!item.key || seen.has(item.key)) continue;
    seen.add(item.key);
    out.push(item);
  }
  return out;
}

function textOf(v: unknown): string {
  if (typeof v === 'string') return normaliseText(v);
  if (typeof v === 'number') return String(v);
  if (v && typeof v === 'object') {
    const rec = v as Record<string, unknown>;
    if (typeof rec['#text'] === 'string') return normaliseText(rec['#text']);
    if (typeof rec['@_href'] === 'string') return normaliseText(rec['@_href']);
  }
  return '';
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** RSS 2.0 `<item>` and Atom `<entry>`. */
export function parseFeed(body: string): SourceItem[] {
  let doc: Record<string, unknown>;
  try {
    doc = xml.parse(body) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: SourceItem[] = [];

  const rss = doc['rss'] as Record<string, unknown> | undefined;
  const channels = asArray<Record<string, unknown>>(
    (rss?.['channel'] ?? doc['channel']) as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );
  for (const channel of channels) {
    for (const raw of asArray<Record<string, unknown>>(channel['item'] as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
      const title = textOf(raw['title']);
      const link = textOf(raw['link']) || textOf(raw['guid']);
      const date = textOf(raw['pubDate']) || textOf(raw['dc:date']) || textOf(raw['published']);
      const item: SourceItem = { key: link || `t:${title}`, title };
      if (link) item.link = link;
      if (date) item.date = date;
      if (item.key) out.push(item);
    }
  }

  const feed = doc['feed'] as Record<string, unknown> | undefined;
  for (const raw of asArray<Record<string, unknown>>(feed?.['entry'] as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
    const title = textOf(raw['title']);
    const link = atomLink(raw['link']) || textOf(raw['id']);
    const date = textOf(raw['updated']) || textOf(raw['published']);
    const item: SourceItem = { key: link || `t:${title}`, title };
    if (link) item.link = link;
    if (date) item.date = date;
    if (item.key) out.push(item);
  }

  return out;
}

function atomLink(v: unknown): string {
  for (const l of asArray<Record<string, unknown> | string>(
    v as Record<string, unknown> | string | (Record<string, unknown> | string)[] | undefined,
  )) {
    if (typeof l === 'string') return normaliseText(l);
    const rel = typeof l['@_rel'] === 'string' ? l['@_rel'] : 'alternate';
    const href = typeof l['@_href'] === 'string' ? l['@_href'] : '';
    if (href && (rel === 'alternate' || rel === '')) return normaliseText(href);
  }
  return '';
}

const ANCHOR_RE = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const HEADING_RE = /<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
const TIME_RE = /<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i;

/** Anchors (hrefs resolved against the page) plus headings. */
export function parseHtml(html: string, text: string, baseUrl: string): SourceItem[] {
  const out: SourceItem[] = [];
  if (!html || !/<a\b/i.test(html)) {
    // Proxy output or a disk-cache hit: Markdown, not HTML. Plain lines are the last resort.
    const markdown = parseMarkdown(text, baseUrl);
    return markdown.length > 0 ? markdown : textLines(text);
  }
  for (const m of html.matchAll(ANCHOR_RE)) {
    const href = m[1];
    const inner = m[2];
    if (href === undefined || inner === undefined) continue;
    const link = resolveUrl(href, baseUrl);
    if (!link) continue;
    const title = normaliseText(htmlToText(inner));
    if (title.length < 3 || title.length > 300) continue;
    const item: SourceItem = { key: link, title, link };
    const time = TIME_RE.exec(m[0]);
    if (time?.[1]) item.date = time[1];
    out.push(item);
  }
  for (const m of html.matchAll(HEADING_RE)) {
    const inner = m[2];
    if (inner === undefined) continue;
    const title = normaliseText(htmlToText(inner));
    if (title.length < 3 || title.length > 300) continue;
    out.push({ key: `t:${title}`, title });
  }
  return out;
}

/** Last resort when a page yields neither anchors nor Markdown links: its own text lines. */
function textLines(text: string): SourceItem[] {
  return text
    .split('\n')
    .map((l) => normaliseText(l))
    .filter((l) => l.length > 8 && l.length < 200)
    .map((title) => ({ key: `t:${title}`, title }))
    .slice(0, MAX_ITEMS);
}

const MD_LINK_RE = /(!?)\[([^\]\n]{0,300})\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const MD_HEADING_RE = /^ {0,3}#{1,4}\s+(.+?)\s*#*\s*$/gm;

/** Markdown, as produced by r.jina.ai: `[title](url)` links plus `#` headings. */
export function parseMarkdown(text: string, baseUrl: string): SourceItem[] {
  const out: SourceItem[] = [];
  for (const m of text.matchAll(MD_LINK_RE)) {
    if (m[1] === '!') continue; // image
    const label = m[2];
    const href = m[3];
    if (label === undefined || href === undefined) continue;
    // Jina numbers repeated labels: "Image 3: Meta", "Link 12: Introducing GPT-6".
    const title = normaliseText(label.replace(/^(?:Image|Link)\s+\d+:\s*/i, ''));
    if (title.length < 3 || title.length > 300) continue;
    const link = resolveUrl(href, baseUrl);
    if (!link) continue;
    out.push({ key: link, title, link });
  }
  for (const m of text.matchAll(MD_HEADING_RE)) {
    const title = normaliseText(m[1] ?? '');
    if (title.length < 3 || title.length > 300) continue;
    out.push({ key: `t:${title}`, title });
  }
  return out;
}

export function resolveUrl(href: string, baseUrl: string): string | null {
  const h = href.trim();
  if (!h || h.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(h)) return null;
  try {
    const u = new URL(h, baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/** `https://huggingface.co/api/models?author=...` — model ids plus lastModified. */
export function parseHuggingFace(body: string): SourceItem[] {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return [];
  }
  const list = Array.isArray(json) ? json : [];
  const out: SourceItem[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const id = typeof rec['id'] === 'string' ? rec['id'] : typeof rec['modelId'] === 'string' ? rec['modelId'] : '';
    if (!id) continue;
    const item: SourceItem = { key: `hf:${id}`, title: id, link: `https://huggingface.co/${id}` };
    const mod = rec['lastModified'] ?? rec['createdAt'];
    if (typeof mod === 'string') item.date = mod;
    out.push(item);
  }
  return out;
}

/** Generic JSON: an array, or an object with `items` / `data` / `models` / `results`. */
export function parseJson(body: string, baseUrl: string): SourceItem[] {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return [];
  }
  let list: unknown[] = [];
  if (Array.isArray(json)) list = json;
  else if (json && typeof json === 'object') {
    const rec = json as Record<string, unknown>;
    for (const key of ['items', 'data', 'models', 'results', 'entries', 'posts']) {
      const v = rec[key];
      if (Array.isArray(v)) {
        list = v;
        break;
      }
    }
  }
  const out: SourceItem[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const title = firstString(rec, ['title', 'name', 'headline', 'id', 'slug']);
    const rawLink = firstString(rec, ['url', 'link', 'href', 'permalink']);
    const date = firstString(rec, ['date', 'published_at', 'publishedAt', 'created_at', 'lastModified', 'updated_at']);
    if (!title && !rawLink) continue;
    const link = rawLink ? resolveUrl(rawLink, baseUrl) : null;
    const item: SourceItem = { key: link ?? `t:${title}`, title: title || (link ?? '') };
    if (link) item.link = link;
    if (date) item.date = date;
    out.push(item);
  }
  return out;
}

function firstString(rec: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim()) return normaliseText(v);
  }
  return '';
}
