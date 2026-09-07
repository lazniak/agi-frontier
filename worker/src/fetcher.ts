/**
 * HTTP fetching with a browser-like User-Agent, timeout, retries, per-host rate limiting,
 * an `r.jina.ai` fallback for pages that block bots, and a page-text cache.
 *
 * The `fetch` implementation is injectable so tests never touch the network.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha1 } from './text';
import type { Logger } from './log';

export interface PageFetch {
  /** URL we were asked for. */
  url: string;
  /** URL actually fetched (may be the r.jina.ai proxy). */
  fetchedUrl: string;
  status: number;
  ok: boolean;
  /** Plain text of the page (HTML stripped). Empty on failure. */
  text: string;
  /** Raw body — HTML or JSON. Empty when served from the disk cache. */
  raw: string;
  contentType: string;
  /** Set to `r.jina.ai` when the fallback reader was used. */
  via?: string;
  fetched_at: string;
  fromCache: boolean;
  error?: string;
}

export type Fetcher = (url: string, opts?: FetchPageOptions) => Promise<PageFetch>;

export interface FetchPageOptions {
  /** `never` disables the r.jina.ai fallback (used when fetching the proxy itself). */
  fallback?: 'auto' | 'never';
  /** Treat a successful but suspiciously short HTML page as blocked and retry via the proxy. */
  minTextLength?: number;
  accept?: string;
}

export interface FetcherOptions {
  userAgent: string;
  timeoutMs: number;
  retries?: number;
  /** Directory for `<sha1>.txt` page caches. Omit to disable the disk cache. */
  cacheDir?: string;
  /** Reuse a disk cache entry younger than this. 0 = never (the per-run memory cache still applies). */
  cacheTtlMs?: number;
  /** Minimum gap between two requests to the same host. */
  minHostIntervalMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: Logger;
}

export interface FetcherStats {
  requests: number;
  cacheHits: number;
  fallbacks: number;
  failures: number;
}

const JINA_PREFIX = 'https://r.jina.ai/';
/**
 * r.jina.ai answers 403 to browser-like User-Agents; a plain bot identity gets a 200.
 * It also answers 200 with a warning line when the target itself failed — that is a failure.
 */
const PROXY_USER_AGENT = 'agi-frontier-bot/0.1 (+https://agi.pablogfx.com)';

/** r.jina.ai puts `Warning: Target URL returned error 404` in its header block. */
export function proxyReportedTargetError(text: string): boolean {
  return text.slice(0, 600).includes('Warning: Target URL returned error');
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createFetcher(opts: FetcherOptions): Fetcher & { stats: FetcherStats } {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const retries = opts.retries ?? 2;
  const cacheTtlMs = opts.cacheTtlMs ?? 0;
  const minHostIntervalMs = opts.minHostIntervalMs ?? 1000;
  const log = opts.log;

  const stats: FetcherStats = { requests: 0, cacheHits: 0, fallbacks: 0, failures: 0 };
  /** Per-run cache: one network request per URL per run, always. */
  const memory = new Map<string, PageFetch>();
  const hostNextFree = new Map<string, number>();

  async function throttle(url: string): Promise<void> {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return;
    }
    const free = hostNextFree.get(host) ?? 0;
    const t = now();
    const wait = free - t;
    if (wait > 0) await sleep(wait);
    hostNextFree.set(host, Math.max(t, free) + minHostIntervalMs);
  }

  async function once(url: string, accept: string | undefined, proxied = false): Promise<PageFetch> {
    await throttle(url);
    stats.requests++;
    const headers: Record<string, string> = proxied
      ? { 'User-Agent': PROXY_USER_AGENT, Accept: 'text/plain' }
      : {
          'User-Agent': opts.userAgent,
          Accept: accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        };
    const fetched_at = isoNow();
    try {
      const res = await fetchImpl(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      const raw = await res.text();
      const contentType = res.headers.get('content-type') ?? '';
      return {
        url,
        fetchedUrl: url,
        status: res.status,
        ok: res.ok,
        raw,
        text: bodyToText(raw, contentType),
        contentType,
        fetched_at,
        fromCache: false,
      };
    } catch (e) {
      return {
        url,
        fetchedUrl: url,
        status: 0,
        ok: false,
        raw: '',
        text: '',
        contentType: '',
        fetched_at,
        fromCache: false,
        error: (e as Error).message,
      };
    }
  }

  /** 403/401/429/451 and transport errors mean "try the reader proxy". */
  function looksBlocked(r: PageFetch): boolean {
    return r.status === 0 || r.status === 401 || r.status === 403 || r.status === 429 || r.status === 451;
  }

  const fetcher = async (url: string, options: FetchPageOptions = {}): Promise<PageFetch> => {
    const cached = memory.get(url);
    if (cached) {
      stats.cacheHits++;
      return { ...cached, fromCache: true };
    }
    const disk = readCache(opts.cacheDir, url, cacheTtlMs, now());
    if (disk) {
      stats.cacheHits++;
      memory.set(url, disk);
      return disk;
    }

    let result = await once(url, options.accept);
    for (let attempt = 0; attempt < retries && !result.ok && !looksBlocked(result); attempt++) {
      await sleep(500 * (attempt + 1));
      result = await once(url, options.accept);
    }

    const thin = result.ok && (options.minTextLength ?? 0) > 0 && result.text.length < (options.minTextLength ?? 0);
    if (options.fallback !== 'never' && (looksBlocked(result) || !result.ok || thin)) {
      log?.debug('fetch fallback via r.jina.ai', { url, status: result.status, thin, error: result.error });
      const proxied = await once(JINA_PREFIX + url, options.accept, true);
      if (proxied.ok && proxyReportedTargetError(proxied.text)) {
        log?.debug('r.jina.ai reported the target itself failed', { url });
      } else if (proxied.ok && proxied.text.length > result.text.length) {
        stats.fallbacks++;
        result = { ...proxied, url, fetchedUrl: proxied.url, via: 'r.jina.ai' };
      }
    }

    if (!result.ok) {
      stats.failures++;
      log?.warn('fetch failed', { url, status: result.status, error: result.error });
    }
    memory.set(url, result);
    if (result.ok) writeCache(opts.cacheDir, result);
    return result;
  };

  return Object.assign(fetcher, { stats });
}

export function isoNow(d: Date = new Date()): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function readCache(dir: string | undefined, url: string, ttlMs: number, nowMs: number): PageFetch | null {
  if (!dir || ttlMs <= 0) return null;
  try {
    const body = readFileSync(cachePath(dir, url), 'utf8');
    const nl = body.indexOf('\n');
    if (nl < 0) return null;
    const head = JSON.parse(body.slice(0, nl)) as { url: string; fetched_at: string; via?: string; status?: number };
    if (nowMs - Date.parse(head.fetched_at) > ttlMs) return null;
    const out: PageFetch = {
      url,
      fetchedUrl: head.url,
      status: head.status ?? 200,
      ok: true,
      raw: '',
      text: body.slice(nl + 1),
      contentType: '',
      fetched_at: head.fetched_at,
      fromCache: true,
    };
    if (head.via) out.via = head.via;
    return out;
  } catch {
    return null;
  }
}

function writeCache(dir: string | undefined, page: PageFetch): void {
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    const head = JSON.stringify({ url: page.fetchedUrl, fetched_at: page.fetched_at, status: page.status, via: page.via ?? null });
    writeFileSync(cachePath(dir, page.url), head + '\n' + page.text, 'utf8');
  } catch {
    /* cache is best-effort */
  }
}

function cachePath(dir: string, url: string): string {
  return join(dir, sha1(url) + '.txt');
}

/** JSON bodies are passed through; everything else goes through the HTML stripper. */
export function bodyToText(raw: string, contentType: string): string {
  if (/json/i.test(contentType) || /^\s*[[{]/.test(raw)) return raw;
  return htmlToText(raw);
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', middot: '·',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  times: '×', deg: '°', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', euro: '€', pound: '£',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,10});/g, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

const BLOCK_CLOSE_RE =
  /<\/(p|div|li|tr|td|th|h[1-6]|section|article|header|footer|main|table|ul|ol|dl|dd|dt|blockquote|pre|figcaption)>/gi;

/** Strip HTML to readable text. Deliberately simple: quotes are matched after normalisation. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|template|iframe|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(script|style|noscript|svg|template|iframe)\b[^>]*\/>/gi, ' ')
      .replace(BLOCK_CLOSE_RE, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
