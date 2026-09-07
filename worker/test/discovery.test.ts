import { describe, expect, test } from 'bun:test';
import { buildDiscoveryQueries, buildModelListPrompt, discoverModels, screenCandidates, type DiscoveryRuntime } from '../src/researcher/discovery';
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
