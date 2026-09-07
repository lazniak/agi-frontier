import { describe, expect, test } from 'bun:test';
import {
  extractItems,
  hashItems,
  itemsFingerprint,
  parseFeed,
  parseHtml,
  parseHuggingFace,
  parseJson,
  parseMarkdown,
  resolveUrl,
} from '../src/items';
import type { PageFetch } from '../src/fetcher';
import { htmlToText, decodeEntities } from '../src/fetcher';

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>OpenAI News</title>
    <item>
      <title><![CDATA[Introducing GPT-5.1]]></title>
      <link>https://openai.com/index/introducing-gpt-5-1/</link>
      <pubDate>Mon, 12 Jan 2026 17:00:00 GMT</pubDate>
    </item>
    <item>
      <title>A note on safety</title>
      <link>https://openai.com/index/safety-note/</link>
      <pubDate>Tue, 13 Jan 2026 09:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const ATOM_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Meta AI</title>
  <entry>
    <title>Llama 5 is here</title>
    <link rel="alternate" href="https://ai.meta.com/blog/llama-5/"/>
    <updated>2026-03-01T10:00:00Z</updated>
  </entry>
  <entry>
    <title>Research roundup</title>
    <link href="https://ai.meta.com/blog/roundup/"/>
    <published>2026-02-01T10:00:00Z</published>
  </entry>
</feed>`;

function page(raw: string, text = ''): PageFetch {
  return {
    url: 'https://example.com/feed',
    fetchedUrl: 'https://example.com/feed',
    status: 200,
    ok: true,
    raw,
    text: text || raw,
    contentType: 'application/xml',
    fetched_at: '2026-09-07T00:00:00Z',
    fromCache: false,
  };
}

describe('parseFeed (RSS 2.0)', () => {
  const items = parseFeed(RSS_FIXTURE);

  test('extracts every item with title, link and date', () => {
    expect(items).toHaveLength(2);
    expect(items[0]?.title).toBe('Introducing GPT-5.1');
    expect(items[0]?.link).toBe('https://openai.com/index/introducing-gpt-5-1/');
    expect(items[0]?.date).toBe('Mon, 12 Jan 2026 17:00:00 GMT');
    expect(items[0]?.key).toBe('https://openai.com/index/introducing-gpt-5-1/');
  });

  test('unwraps CDATA titles', () => {
    expect(items[0]?.title).not.toContain('CDATA');
  });

  test('returns nothing for junk instead of throwing', () => {
    expect(parseFeed('not xml at all <<<')).toEqual([]);
    expect(parseFeed('')).toEqual([]);
  });
});

describe('parseFeed (Atom)', () => {
  test('reads entries and prefers rel="alternate" links', () => {
    const items = parseFeed(ATOM_FIXTURE);
    expect(items).toHaveLength(2);
    expect(items[0]?.title).toBe('Llama 5 is here');
    expect(items[0]?.link).toBe('https://ai.meta.com/blog/llama-5/');
    expect(items[0]?.date).toBe('2026-03-01T10:00:00Z');
    expect(items[1]?.link).toBe('https://ai.meta.com/blog/roundup/');
  });
});

describe('parseHtml', () => {
  const html = `<html><body>
    <h1>News</h1>
    <a href="/news/claude-opus-5">Introducing Claude Opus 5</a>
    <a href="https://other.example/x">External</a>
    <a href="#skip">anchor</a>
    <a href="javascript:void(0)">js</a>
    <a href="/news/x">ab</a>
    <h2>Claude Opus 5 is available today</h2>
  </body></html>`;
  const items = parseHtml(html, htmlToText(html), 'https://www.anthropic.com/news');

  test('resolves relative hrefs against the page URL', () => {
    expect(items.map((i) => i.link)).toContain('https://www.anthropic.com/news/claude-opus-5');
  });

  test('keeps absolute links and drops anchors, javascript and too-short labels', () => {
    const links = items.map((i) => i.link);
    expect(links).toContain('https://other.example/x');
    expect(links.some((l) => l?.includes('#skip'))).toBe(false);
    expect(links.some((l) => l?.startsWith('javascript'))).toBe(false);
    expect(items.some((i) => i.title === 'ab')).toBe(false);
  });

  test('includes headings as link-less items', () => {
    const heading = items.find((i) => i.title === 'Claude Opus 5 is available today');
    expect(heading).toBeDefined();
    expect(heading?.link).toBeUndefined();
    expect(heading?.key.startsWith('t:')).toBe(true);
  });
});

describe('parseHuggingFace', () => {
  test('maps model ids to items with a model-page link', () => {
    const items = parseHuggingFace(
      JSON.stringify([
        { id: 'deepseek-ai/DeepSeek-V4', lastModified: '2026-04-02T08:00:00.000Z' },
        { id: 'deepseek-ai/DeepSeek-OCR' },
        { notAModel: true },
      ]),
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      key: 'hf:deepseek-ai/DeepSeek-V4',
      title: 'deepseek-ai/DeepSeek-V4',
      link: 'https://huggingface.co/deepseek-ai/DeepSeek-V4',
      date: '2026-04-02T08:00:00.000Z',
    });
  });

  test('survives malformed JSON', () => {
    expect(parseHuggingFace('{')).toEqual([]);
  });
});

describe('parseJson', () => {
  test('reads a bare array and an { items: [...] } envelope', () => {
    expect(parseJson(JSON.stringify([{ title: 'A', url: '/a', date: '2026-01-01' }]), 'https://x.ai/news')).toEqual([
      { key: 'https://x.ai/a', title: 'A', link: 'https://x.ai/a', date: '2026-01-01' },
    ]);
    expect(parseJson(JSON.stringify({ items: [{ name: 'Grok 6' }] }), 'https://x.ai')).toHaveLength(1);
  });
});

describe('resolveUrl', () => {
  test.each([
    ['/a', 'https://x.ai/news', 'https://x.ai/a'],
    ['https://y.example/b', 'https://x.ai', 'https://y.example/b'],
    ['/a#frag', 'https://x.ai', 'https://x.ai/a'],
  ])('%s -> %s', (href, base, expected) => {
    expect(resolveUrl(href, base)).toBe(expected);
  });

  test.each(['#top', 'javascript:x', 'mailto:a@b.c', '', 'ftp://x/y'])('rejects %s', (href) => {
    expect(resolveUrl(href, 'https://x.ai')).toBeNull();
  });
});

describe('fingerprint and hash', () => {
  const items = parseFeed(RSS_FIXTURE);

  test('is order-independent', () => {
    expect(hashItems(items)).toBe(hashItems([...items].reverse()));
  });

  test('changes when an item is added, and not when it is not', () => {
    const same = parseFeed(RSS_FIXTURE);
    expect(hashItems(items)).toBe(hashItems(same));
    const extra = [...items, { key: 'https://openai.com/index/gpt-6/', title: 'GPT-6' }];
    expect(hashItems(extra)).not.toBe(hashItems(items));
  });

  test('fingerprint carries key, title and date', () => {
    expect(itemsFingerprint(items)).toContain('Introducing GPT-5.1');
  });
});

describe('extractItems dispatch', () => {
  test('routes by source kind', () => {
    expect(extractItems('rss', page(RSS_FIXTURE), 'https://openai.com/news/rss.xml')).toHaveLength(2);
    expect(extractItems('hf-org', page('[{"id":"Qwen/Qwen4-Max"}]'), 'https://huggingface.co')).toHaveLength(1);
    expect(extractItems('json', page('{"items":[{"title":"x","url":"/x"}]}'), 'https://x.ai')).toHaveLength(1);
    expect(extractItems('html', page('<a href="/a">Introducing GPT-6</a>'), 'https://openai.com/news')).toHaveLength(1);
  });

  test('deduplicates repeated links', () => {
    const html = '<a href="/a">Introducing GPT-6</a><a href="/a">Introducing GPT-6</a>';
    expect(extractItems('html', page(html), 'https://openai.com/news')).toHaveLength(1);
  });
});

describe('htmlToText', () => {
  test('drops scripts and styles, keeps prose', () => {
    const text = htmlToText('<style>a{}</style><script>var x=1;</script><p>Hello <b>world</b></p>');
    expect(text).toContain('Hello');
    expect(text).toContain('world');
    expect(text).not.toContain('var x');
    expect(text).not.toContain('a{}');
  });

  test('decodes entities', () => {
    expect(decodeEntities('a &amp; b &#8212; c &mdash; d &#x2014;')).toBe('a & b — c — d —');
    expect(htmlToText('<p>Claude&rsquo;s</p>')).toBe('Claude’s');
  });
});

/** What r.jina.ai actually returns: a header block, then Markdown. */
const JINA_FIXTURE = `Title: AI at Meta Blog

URL Source: https://ai.meta.com/blog/

Markdown Content:
[](https://ai.meta.com/blog/# "Go up one level")[![Image 1: Meta](https://scontent.example/logo.svg)](https://ai.meta.com/)

## Latest

[Link 4: Introducing Muse Spark 1.1](https://ai.meta.com/blog/muse-spark-1-1/)

[Introducing Llama 5](/blog/llama-5/)

![Image 9: thumbnail](https://scontent.example/thumb.jpg)
`;

describe('parseMarkdown (r.jina.ai output)', () => {
  const items = parseMarkdown(JINA_FIXTURE, 'https://ai.meta.com/blog/');

  test('reads links and resolves relative hrefs', () => {
    const byTitle = new Map(items.map((i) => [i.title, i.link]));
    expect(byTitle.get('Introducing Muse Spark 1.1')).toBe('https://ai.meta.com/blog/muse-spark-1-1/');
    expect(byTitle.get('Introducing Llama 5')).toBe('https://ai.meta.com/blog/llama-5/');
  });

  test('strips the "Link N:" prefix jina adds', () => {
    expect(items.some((i) => i.title.startsWith('Link 4'))).toBe(false);
  });

  test('skips images', () => {
    expect(items.some((i) => i.title.includes('thumbnail'))).toBe(false);
    expect(items.some((i) => i.link?.endsWith('.jpg'))).toBe(false);
  });

  test('picks up headings', () => {
    expect(items.some((i) => i.title === 'Latest' && i.link === undefined)).toBe(true);
  });
});

describe('extractItems markdown fallback', () => {
  test('an html source read through the proxy still yields items', () => {
    const proxied: PageFetch = {
      ...page(''),
      url: 'https://ai.meta.com/blog/',
      raw: '',
      text: JINA_FIXTURE,
      via: 'r.jina.ai',
    };
    const items = extractItems('html', proxied, 'https://ai.meta.com/blog/');
    expect(items.some((i) => i.title === 'Introducing Muse Spark 1.1')).toBe(true);
  });

  test('an rss source read through the proxy falls back to markdown too', () => {
    const proxied: PageFetch = { ...page(''), raw: '', text: JINA_FIXTURE, via: 'r.jina.ai' };
    expect(extractItems('rss', proxied, 'https://ai.meta.com/blog/rss/').length).toBeGreaterThan(0);
  });
});
