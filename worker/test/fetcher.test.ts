import { describe, expect, test } from 'bun:test';
import { bodyToText, createFetcher, isoNow, proxyReportedTargetError } from '../src/fetcher';

const noSleep = async (): Promise<void> => {};

function respond(body: string, status = 200, contentType = 'text/html'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

describe('createFetcher', () => {
  test('sends the configured User-Agent and strips HTML to text', async () => {
    const seen: { url: string; ua: string }[] = [];
    const fetcher = createFetcher({
      userAgent: 'agi-frontier-bot/test',
      timeoutMs: 1000,
      sleepImpl: noSleep,
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url, ua: (init.headers as Record<string, string>)['User-Agent'] ?? '' });
        return respond('<html><body><h1>Introducing GPT-6</h1></body></html>');
      }) as unknown as typeof fetch,
    });
    const page = await fetcher('https://openai.com/news');
    expect(page.ok).toBe(true);
    expect(page.text).toBe('Introducing GPT-6');
    expect(page.raw).toContain('<h1>');
    expect(seen[0]?.ua).toBe('agi-frontier-bot/test');
  });

  test('caches per run: the same URL is fetched once', async () => {
    let calls = 0;
    const fetcher = createFetcher({
      userAgent: 'ua', timeoutMs: 1000, sleepImpl: noSleep,
      fetchImpl: (async () => { calls++; return respond('<p>hi</p>'); }) as unknown as typeof fetch,
    });
    await fetcher('https://x.ai/news');
    const second = await fetcher('https://x.ai/news');
    expect(calls).toBe(1);
    expect(second.fromCache).toBe(true);
    expect(fetcher.stats.cacheHits).toBe(1);
  });

  test('retries a 500 twice before giving up', async () => {
    let calls = 0;
    const fetcher = createFetcher({
      userAgent: 'ua', timeoutMs: 1000, retries: 2, sleepImpl: noSleep,
      fetchImpl: (async () => { calls++; return respond('boom', 500); }) as unknown as typeof fetch,
    });
    const page = await fetcher('https://x.ai/news', { fallback: 'never' });
    expect(page.ok).toBe(false);
    expect(calls).toBe(3); // initial + 2 retries
    expect(fetcher.stats.failures).toBe(1);
  });

  test('a 403 goes straight to the r.jina.ai reader and records `via`', async () => {
    const urls: string[] = [];
    const fetcher = createFetcher({
      userAgent: 'ua', timeoutMs: 1000, sleepImpl: noSleep,
      fetchImpl: (async (url: string) => {
        urls.push(url);
        if (url.startsWith('https://r.jina.ai/')) return respond('Claude Opus 5 is available today', 200, 'text/plain');
        return respond('Forbidden', 403);
      }) as unknown as typeof fetch,
    });
    const page = await fetcher('https://www.anthropic.com/news');
    expect(page.ok).toBe(true);
    expect(page.via).toBe('r.jina.ai');
    expect(page.url).toBe('https://www.anthropic.com/news'); // the caller's URL, not the proxy
    expect(page.text).toContain('Claude Opus 5 is available today');
    expect(urls).toEqual(['https://www.anthropic.com/news', 'https://r.jina.ai/https://www.anthropic.com/news']);
    expect(fetcher.stats.fallbacks).toBe(1);
  });

  test('a 403 does not retry directly before falling back', async () => {
    let direct = 0;
    const fetcher = createFetcher({
      userAgent: 'ua', timeoutMs: 1000, sleepImpl: noSleep,
      fetchImpl: (async (url: string) => {
        if (!url.startsWith('https://r.jina.ai/')) direct++;
        return respond('nope', 403);
      }) as unknown as typeof fetch,
    });
    await fetcher('https://x.ai/news');
    expect(direct).toBe(1);
  });

  test('a JS-only page that returns almost no text falls back too', async () => {
    const fetcher = createFetcher({
      userAgent: 'ua', timeoutMs: 1000, sleepImpl: noSleep,
      fetchImpl: (async (url: string) =>
        url.startsWith('https://r.jina.ai/')
          ? respond('A long article about the new flagship model and its benchmark scores.', 200, 'text/plain')
          : respond('<html><body><div id="root"></div></body></html>')) as unknown as typeof fetch,
    });
    const page = await fetcher('https://x.ai/news', { minTextLength: 400 });
    expect(page.via).toBe('r.jina.ai');
  });

  test('keeps the direct response when the fallback is not better', async () => {
    const fetcher = createFetcher({
      userAgent: 'ua', timeoutMs: 1000, sleepImpl: noSleep,
      fetchImpl: (async (url: string) =>
        url.startsWith('https://r.jina.ai/') ? respond('', 200, 'text/plain') : respond('short', 403)) as unknown as typeof fetch,
    });
    const page = await fetcher('https://x.ai/news');
    expect(page.via).toBeUndefined();
    expect(page.ok).toBe(false);
  });

  test('rate-limits to one request per second per host, independently per host', async () => {
    const waits: number[] = [];
    let clock = 0;
    const fetcher = createFetcher({
      userAgent: 'ua', timeoutMs: 1000, minHostIntervalMs: 1000,
      now: () => clock,
      sleepImpl: async (ms) => { waits.push(ms); clock += ms; },
      fetchImpl: (async () => respond('<p>x</p>')) as unknown as typeof fetch,
    });
    await fetcher('https://a.example/1');
    await fetcher('https://a.example/2');
    await fetcher('https://b.example/1');
    expect(waits).toEqual([1000]); // only the second a.example request waits
  });

  test('a transport error is reported, not thrown', async () => {
    const fetcher = createFetcher({
      userAgent: 'ua', timeoutMs: 1000, sleepImpl: noSleep,
      fetchImpl: (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch,
    });
    const page = await fetcher('https://x.ai/news', { fallback: 'never' });
    expect(page.ok).toBe(false);
    expect(page.status).toBe(0);
    expect(page.error).toBe('ECONNRESET');
  });
});

const JINA_MARKDOWN = [
  'Title: News',
  '',
  'URL Source: https://x.ai/news',
  '',
  'Markdown Content:',
  '[Grok 6](https://x.ai/news/grok-6)',
].join('\n');

const JINA_TARGET_ERROR = [
  'Title: 404 Not Found',
  '',
  'URL Source: https://z.ai/blog',
  '',
  'Warning: Target URL returned error 404: Not Found',
  '',
  'Markdown Content:',
  'nginx',
].join('\n');

describe('r.jina.ai specifics', () => {
  test('the proxy is called with a plain bot identity — it 403s browser User-Agents', async () => {
    const headers: Record<string, string>[] = [];
    const fetcher = createFetcher({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0',
      timeoutMs: 1000, sleepImpl: noSleep,
      fetchImpl: (async (url: string, init: RequestInit) => {
        headers.push(init.headers as Record<string, string>);
        return url.startsWith('https://r.jina.ai/')
          ? respond(JINA_MARKDOWN, 200, 'text/plain')
          : respond('blocked', 403);
      }) as unknown as typeof fetch,
    });
    const page = await fetcher('https://x.ai/news');
    expect(page.via).toBe('r.jina.ai');
    expect(headers[0]?.['User-Agent']).toContain('Mozilla/5.0');
    expect(headers[1]?.['User-Agent']).not.toContain('Mozilla');
    expect(headers[1]?.['Accept']).toBe('text/plain');
  });

  test('the proxy reporting the target failed is not treated as content', async () => {
    const fetcher = createFetcher({
      userAgent: 'ua', timeoutMs: 1000, sleepImpl: noSleep,
      fetchImpl: (async (url: string) =>
        url.startsWith('https://r.jina.ai/')
          ? respond(JINA_TARGET_ERROR, 200, 'text/plain')
          : respond('<html>404</html>', 404)) as unknown as typeof fetch,
    });
    const page = await fetcher('https://z.ai/blog');
    expect(page.ok).toBe(false);
    expect(page.status).toBe(404);
    expect(page.via).toBeUndefined();
  });

  test('proxyReportedTargetError only looks at the header block', () => {
    expect(proxyReportedTargetError(JINA_TARGET_ERROR)).toBe(true);
    expect(proxyReportedTargetError(JINA_MARKDOWN)).toBe(false);
    expect(proxyReportedTargetError('x'.repeat(700) + 'Warning: Target URL returned error 404')).toBe(false);
  });
});

describe('bodyToText', () => {
  test('passes JSON through untouched and strips HTML', () => {
    expect(bodyToText('[{"id":"a"}]', 'application/json')).toBe('[{"id":"a"}]');
    expect(bodyToText('[{"id":"a"}]', '')).toBe('[{"id":"a"}]');
    expect(bodyToText('<p>Hi</p>', 'text/html')).toBe('Hi');
  });
});

describe('isoNow', () => {
  test('produces a schema-shaped UTC stamp without milliseconds', () => {
    expect(isoNow(new Date('2026-09-07T04:05:06.789Z'))).toBe('2026-09-07T04:05:06Z');
    expect(isoNow()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});
