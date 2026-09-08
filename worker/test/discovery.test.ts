import { describe, expect, test } from 'bun:test';
import {
  buildDiscoveryQueries,
  buildModelListPrompt,
  collectAnnouncementLinks,
  discoverModels,
  findLaunchPostInNewsIndex,
  isAnnouncementPath,
  isOverviewUrl,
  linkNameScore,
  rankLinksForName,
  screenCandidates,
  titleNamesModel,
  type DiscoveryRuntime,
} from '../src/researcher/discovery';
import { nameKey } from '../src/text';
import type { PageFetch } from '../src/fetcher';
import type { Lab } from '@agi/shared';

const lab: Lab = {
  id: 'openai',
  name: 'OpenAI',
  short: 'OpenAI',
  color: '#10A37F',
  color_note: '',
  website: 'https://openai.com',
  sources: [{ label: 'News RSS', url: 'https://openai.com/news/rss.xml', kind: 'rss' }],
  flagship_hints: ['^GPT-\d'],
};

describe('buildDiscoveryQueries', () => {
  test('one flagship query per year since 2018 plus one mid/small sweep', () => {
    const queries = buildDiscoveryQueries(lab, 2026);
    expect(queries).toHaveLength(2026 - 2018 + 2);
    expect(queries[0]?.label).toBe('flagship 2018');
    expect(queries.at(-1)?.label).toBe('mid and small tiers');
    expect(queries[0]?.prompt).toContain('OpenAI');
    expect(queries[0]?.prompt).toContain('2018');
  });
});

describe('buildModelListPrompt (the shared prompt builder, review item 17)', () => {
  test('flagship tier returns the year-targeted query', () => {
    const prompt = buildModelListPrompt(lab, { year: 2024, tier: 'flagship' });
    expect(prompt).toContain('OpenAI');
    expect(prompt).toContain('2024');
    expect(prompt).toContain('flagship');
  });

  test('mid-small tier returns the tier sweep query', () => {
    const prompt = buildModelListPrompt(lab, { year: 2026, tier: 'mid-small' });
    expect(prompt).toContain('mid');
    expect(prompt).toContain('small');
  });

  test('discoverModels routes every query through buildModelListPrompt', async () => {
    // The chatJson capture records which prompt each call carried; it must equal what the
    // shared builder produces for that query (single source of truth, no second prompt copy).
    const seen: string[] = [];
    const rt = {
      openRouter: {
        chatJson: async (req: { user: string }) => {
          seen.push(req.user.split('\n\nReturn JSON only')[0] ?? '');
          return { json: { models: [] }, content: '', usedJsonObjectFallback: false };
        },
      },
      log: { child: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
    } as unknown as DiscoveryRuntime;
    await discoverModels(rt, lab, 'google/gemini-3.1-flash-lite:online', 2024);
    const expected = buildDiscoveryQueries(lab, 2024).map((q) => q.prompt);
    expect(seen).toHaveLength(expected.length);
    for (const prompt of expected) expect(seen).toContain(prompt);
  });
});

describe('schema issues are logged verbatim (REDESIGN §12.6)', () => {
  test('a root-level mismatch logs "<root>: message", never an empty string', async () => {
    const warnings: { msg: string; fields: Record<string, unknown> }[] = [];
    const rt = {
      openRouter: {
        // A bare array is the shape the first live run saw: the issue sits at the root, so the
        // old `path.join('.')` produced `[""]`.
        chatJson: async () => ({ json: [], content: '[]', usedJsonObjectFallback: false }),
      },
      log: {
        child: () => ({
          info() {},
          warn(msg: string, fields: Record<string, unknown>) { warnings.push({ msg, fields }); },
          error() {},
          debug() {},
        }),
      },
    } as unknown as DiscoveryRuntime;
    const result = await discoverModels(rt, lab, 'm', 2018);
    expect(result.candidates).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    const schemaWarnings = warnings.filter((w) => w.msg === 'discovery response did not match schema');
    expect(schemaWarnings.length).toBeGreaterThan(0);
    for (const w of schemaWarnings) {
      const issues = w.fields['issues'] as string[];
      expect(issues.length).toBeGreaterThan(0);
      for (const issue of issues) {
        expect(issue).not.toBe('');
        expect(issue).toMatch(/^<root>: .+/);
      }
    }
  });

  test('a nested mismatch carries the path and zod message', async () => {
    const warnings: Record<string, unknown>[] = [];
    const rt = {
      openRouter: { chatJson: async () => ({ json: { models: [{ name: 7, launch_url: 'https://openai.com/x' }] }, content: '', usedJsonObjectFallback: false }) },
      log: { child: () => ({ info() {}, warn(_m: string, f: Record<string, unknown>) { warnings.push(f); }, error() {}, debug() {} }) },
    } as unknown as DiscoveryRuntime;
    await discoverModels(rt, lab, 'm', 2018);
    const issues = warnings.flatMap((w) => (w['issues'] as string[] | undefined) ?? []);
    expect(issues.some((i) => /^models\.0\.name: /.test(i))).toBe(true);
  });
});

describe('overview pages vs launch posts (REDESIGN §12.6)', () => {
  test('isOverviewUrl flags catalogues, docs, pricing and the homepage', () => {
    expect(isOverviewUrl('https://deepmind.google/models/gemini/')).toBe(true);
    expect(isOverviewUrl('https://docs.x.ai/docs/models')).toBe(true);
    expect(isOverviewUrl('https://openai.com/api/pricing/')).toBe(true);
    expect(isOverviewUrl('https://docs.anthropic.com/en/docs/about-claude/models/overview')).toBe(true);
    expect(isOverviewUrl('https://x.ai')).toBe(true);
    expect(isOverviewUrl('https://www.anthropic.com/')).toBe(true);
    expect(isOverviewUrl('https://www.anthropic.com/news/claude-opus-5')).toBe(false);
    expect(isOverviewUrl('https://openai.com/index/introducing-gpt-7/')).toBe(false);
    expect(isOverviewUrl('https://blog.google/technology/google-deepmind/gemini-3-8/')).toBe(false);
    expect(isOverviewUrl('not a url')).toBe(false);
  });

  test('isAnnouncementPath accepts news/blog wording (host or path) or a date in the path', () => {
    expect(isAnnouncementPath('https://x.ai/news/grok-4-6')).toBe(true);
    expect(isAnnouncementPath('https://openai.com/index/introducing-gpt-7/')).toBe(true);
    expect(isAnnouncementPath('https://mistral.ai/2026/08/30/large-3')).toBe(true);
    expect(isAnnouncementPath('https://qwenlm.github.io/blog/qwen3.8-max/')).toBe(true);
    expect(isAnnouncementPath('https://blog.google/technology/google-deepmind/gemini-3-5/')).toBe(true);
    expect(isAnnouncementPath('https://x.ai/about')).toBe(false);
    expect(isAnnouncementPath('https://deepmind.google/technologies/gemini/')).toBe(false);
  });

  const page = (raw: string, text = '', url = 'https://deepmind.google/models/gemini/'): PageFetch => ({
    url, fetchedUrl: url, status: 200, ok: true, text, raw, contentType: 'text/html', fetched_at: '2026-09-07T00:00:00Z', fromCache: false,
  });
  const hosts = ['deepmind.google', 'blog.google'];

  test('collectAnnouncementLinks keeps same-host dated links, resolves relative ones, drops overview pages, self and foreign hosts', () => {
    const raw =
      '<a href="/blog/gemini-3-8-flash/">Gemini 3.8 Flash</a>' +
      '<a href="https://blog.google/technology/google-deepmind/gemini-3-5/#top">Gemini 3.5</a>' +
      '<a href="/models/gemini/flash">Flash overview</a>' +
      '<a href="/models/gemini/">self</a>' +
      '<a href="https://twitter.com/deepmind/status/1">tweet</a>' +
      '<a href="/blog/gemini-3-8-flash/">dupe</a>' +
      '<a href="mailto:x@y.z">mail</a>';
    const links = collectAnnouncementLinks(page(raw), hosts);
    expect(links).toEqual([
      'https://deepmind.google/blog/gemini-3-8-flash/',
      'https://blog.google/technology/google-deepmind/gemini-3-5/',
    ]);
  });

  test('collectAnnouncementLinks reads Markdown links and bare URLs when the page came through the reader', () => {
    const text = 'Models\n\n[Gemini 3.8 Flash](https://deepmind.google/blog/gemini-3-8-flash/) and https://deepmind.google/blog/gemini-3-5-pro/ too.';
    const links = collectAnnouncementLinks(page('', text), hosts);
    expect(links).toEqual(['https://deepmind.google/blog/gemini-3-8-flash/', 'https://deepmind.google/blog/gemini-3-5-pro/']);
  });

  test('collectAnnouncementLinks is capped', () => {
    const raw = Array.from({ length: 60 }, (_, i) => `<a href="/blog/post-${i}/">p</a>`).join('');
    expect(collectAnnouncementLinks(page(raw), hosts, 5)).toHaveLength(5);
  });

  test('linkNameScore: whole-name containment scores 2, numbers plus a word 1, nothing 0', () => {
    expect(linkNameScore('https://www.anthropic.com/news/claude-opus-5', 'Claude Opus 5')).toBe(2);
    expect(linkNameScore('https://x.ai/news/grok-4-6', 'Grok 4.6')).toBe(2);
    expect(linkNameScore('https://deepmind.google/blog/gemini-3-8-flash-launch/', 'Gemini 3.8 Flash')).toBe(2);
    expect(linkNameScore('https://deepmind.google/blog/introducing-gemini-3-8-flash-lite/', 'Gemini 3.8 Flash-Lite')).toBe(2);
    expect(linkNameScore('https://deepmind.google/blog/flash-3-8-is-here/', 'Gemini 3.8 Flash')).toBe(1);
    expect(linkNameScore('https://deepmind.google/blog/gemini-3-5-pro/', 'Gemini 3.8 Flash')).toBe(0);
    expect(linkNameScore('https://deepmind.google/blog/safety-update/', 'Gemini 3.8 Flash')).toBe(0);
  });

  test('linkNameScore: a version token must be a path segment, not a digit hiding in a year', () => {
    // Substring matching on the squashed path found "5" in "2025" and "4" in "2024", so a
    // catalogue page with no exact link enqueued extractions for the wrong launch posts.
    expect(linkNameScore('https://openai.com/index/gpt-4o-2025-update/', 'GPT-5')).toBe(0);
    expect(linkNameScore('https://x.ai/news/grok-3-april-2024', 'Grok 4')).toBe(0);
    // The legitimate shapes still score: the version fused into one segment, or spelled out.
    expect(linkNameScore('https://openai.com/index/gpt5-is-here/', 'GPT-5')).toBe(2);
    expect(linkNameScore('https://openai.com/index/introducing-the-gpt-5-era/', 'GPT-5')).toBe(2);
    expect(linkNameScore('https://deepmind.google/blog/flash-38-benchmarks/', 'Gemini 3.8 Flash')).toBe(1);
    expect(linkNameScore('https://x.ai/news/our-fastest-grok-4-yet', 'Grok 4')).toBe(2);
    // Name split across the path: the version is still a segment of its own, so it scores 1.
    expect(linkNameScore('https://x.ai/news/4-is-here-grok-lands/', 'Grok 4')).toBe(1);
  });

  test('titleNamesModel refuses a newer sibling that merely contains the key', () => {
    // The caller allows exactly ONE retry, so a "GPT-7.5" post earlier in the feed used to
    // hijack the retry meant for "GPT-7" and the real post was never tried.
    expect(titleNamesModel('Introducing GPT-7.5', nameKey('GPT-7'))).toBe(false);
    expect(titleNamesModel('Introducing GPT-75', nameKey('GPT-7'))).toBe(false);
    expect(titleNamesModel('Introducing GPT-7', nameKey('GPT-7'))).toBe(true);
    expect(titleNamesModel('GPT-7 is available today', nameKey('GPT-7'))).toBe(true);
    // A title naming both still matches the older model.
    expect(titleNamesModel('GPT-7.5 follows GPT-7 by a month', nameKey('GPT-7'))).toBe(true);
    expect(titleNamesModel('Introducing GPT-7.5', nameKey('GPT-7.5'))).toBe(true);
    expect(titleNamesModel('Safety note', nameKey('GPT-7'))).toBe(false);
  });

  test('rankLinksForName returns only naming links, best first, capped', () => {
    const links = [
      'https://deepmind.google/blog/safety-update/',
      'https://deepmind.google/blog/flash-3-8-is-here/',
      'https://deepmind.google/blog/gemini-3-8-flash/',
      'https://deepmind.google/blog/gemini-3-8-flash-benchmarks/',
    ];
    expect(rankLinksForName(links, 'Gemini 3.8 Flash', 2)).toEqual([
      'https://deepmind.google/blog/gemini-3-8-flash/',
      'https://deepmind.google/blog/gemini-3-8-flash-benchmarks/',
    ]);
    expect(rankLinksForName(links, 'Gemini 3.8 Flash')).toHaveLength(3);
  });

  test('findLaunchPostInNewsIndex scans the lab rss/html sources for an item naming the model', async () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>OpenAI</title>
      <item><title>Safety note</title><link>https://openai.com/index/safety/</link></item>
      <item><title>Introducing GPT-7</title><link>https://openai.com/index/introducing-gpt-7/</link><pubDate>Sun, 30 Aug 2026 17:00:00 GMT</pubDate></item>
    </channel></rss>`;
    const fetched: string[] = [];
    const fetcher = (async (url: string): Promise<PageFetch> => {
      fetched.push(url);
      return { url, fetchedUrl: url, status: 200, ok: true, text: rss, raw: rss, contentType: 'application/rss+xml', fetched_at: 'x', fromCache: false };
    }) as unknown as import('../src/fetcher').Fetcher;
    const hit = await findLaunchPostInNewsIndex(fetcher, lab, 'GPT-7');
    expect(hit?.url).toBe('https://openai.com/index/introducing-gpt-7/');
    expect(hit?.title).toBe('Introducing GPT-7');
    expect(hit?.date).toContain('2026');
    expect(fetched).toEqual(['https://openai.com/news/rss.xml']);
    // The page we already tried is excluded; an unknown model is a miss.
    expect(await findLaunchPostInNewsIndex(fetcher, lab, 'GPT-7', { excludeUrls: new Set(['https://openai.com/index/introducing-gpt-7']) })).toBeNull();
    expect(await findLaunchPostInNewsIndex(fetcher, lab, 'GPT-9')).toBeNull();
  });

  test('findLaunchPostInNewsIndex skips a newer sibling post sitting earlier in the feed', async () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>OpenAI</title>
      <item><title>Introducing GPT-7.5</title><link>https://openai.com/index/introducing-gpt-7-5/</link><pubDate>Tue, 08 Sep 2026 17:00:00 GMT</pubDate></item>
      <item><title>Introducing GPT-7</title><link>https://openai.com/index/introducing-gpt-7/</link><pubDate>Sun, 30 Aug 2026 17:00:00 GMT</pubDate></item>
    </channel></rss>`;
    const fetcher = (async (url: string): Promise<PageFetch> => ({
      url, fetchedUrl: url, status: 200, ok: true, text: rss, raw: rss, contentType: 'application/rss+xml', fetched_at: 'x', fromCache: false,
    })) as unknown as import('../src/fetcher').Fetcher;
    // Only one retry is allowed, so picking the 7.5 post would burn it on the wrong model.
    expect((await findLaunchPostInNewsIndex(fetcher, lab, 'GPT-7'))?.url).toBe('https://openai.com/index/introducing-gpt-7/');
    expect((await findLaunchPostInNewsIndex(fetcher, lab, 'GPT-7.5'))?.url).toBe('https://openai.com/index/introducing-gpt-7-5/');
  });
});

describe('screenCandidates (host filter + dedupe)', () => {
  test('keeps official-host candidates and marks them official', () => {
    const out = screenCandidates(
      [{ name: 'GPT-7', family: 'GPT', tier: 'flagship', date: '2026-08-30', launch_url: 'https://openai.com/index/gpt-7/', confidence: 0.9 }],
      ['openai.com'],
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.official).toBe(true);
  });

  test('an allow-listed press host stays in the plan with official=false', () => {
    const out = screenCandidates(
      [{ name: 'GPT-7', family: 'GPT', tier: 'flagship', date: '2026-08-30', launch_url: 'https://techcrunch.com/2026/08/30/gpt-7/', confidence: 0.7 }],
      ['openai.com'],
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.official).toBe(false);
  });

  test('an unofficial, non-press host is dropped', () => {
    const out = screenCandidates(
      [{ name: 'GPT-7', family: 'GPT', tier: 'flagship', date: '2026-08-30', launch_url: 'https://some-forum.example/gpt-7/', confidence: 0.9 }],
      ['openai.com'],
    );
    expect(out).toHaveLength(0);
  });

  test('duplicate names keep the highest-confidence candidate', () => {
    const out = screenCandidates(
      [
        { name: 'GPT-7', family: 'GPT', tier: 'flagship', date: '2026-08-30', launch_url: 'https://openai.com/a/', confidence: 0.4 },
        { name: 'gpt 7', family: 'GPT', tier: 'flagship', date: '2026-08-30', launch_url: 'https://openai.com/b/', confidence: 0.9 },
      ],
      ['openai.com'],
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.launch_url).toBe('https://openai.com/b/');
  });
});
