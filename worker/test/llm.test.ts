import { describe, expect, test } from 'bun:test';
import {
  EXTRACTION_JSON_SCHEMA,
  ExtractionSchema,
  MAX_QUOTE_CHARS,
  OpenRouterClient,
  buildUserPrompt,
  parseJsonContent,
  validateExtraction,
  type Extraction,
} from '../src/llm';
import type { Benchmark, Lab } from '@agi/shared';

const PAGE = `Introducing GPT-6

GPT-6 is available today in the API and in ChatGPT for all paid plans.
On GPQA Diamond it reaches 92.4% with no tools, and it scores 1,234 points on an internal eval.
On SWE-bench Verified GPT-6 reaches 84.2%.`;

const BENCHMARK_IDS = new Set(['gpqa-diamond', 'swe-bench-verified', 'aime', 'hle']);
const OPTS = {
  pageText: PAGE,
  benchmarkIds: BENCHMARK_IDS,
  today: '2026-09-07',
  fallbackDate: '2026-09-01',
};

function extraction(over: Partial<Extraction['releases'][number]> = {}): Extraction {
  return {
    releases: [
      {
        name: 'GPT-6',
        family: 'GPT',
        status: 'released',
        date: '2026-05-04',
        date_precision: 'day',
        announcement_quote: 'GPT-6 is available today in the API',
        scores: [{ benchmark: 'gpqa-diamond', value: 92.4, config: 'no tools', quote: 'it reaches 92.4% with no tools' }],
        notes: null,
        ...over,
      },
    ],
  };
}

describe('validateExtraction — releases', () => {
  test('keeps a release whose announcement quote is on the page', () => {
    const { releases, dropped } = validateExtraction(extraction(), OPTS);
    expect(releases).toHaveLength(1);
    expect(dropped).toHaveLength(0);
    expect(releases[0]?.date).toBe('2026-05-04');
  });

  test('drops a release whose announcement quote is invented', () => {
    const { releases, dropped } = validateExtraction(
      extraction({ announcement_quote: 'GPT-6 is the most capable model ever built' }),
      OPTS,
    );
    expect(releases).toHaveLength(0);
    expect(dropped[0]).toMatchObject({ kind: 'release', reason: 'announcement quote not found on page' });
  });

  test('drops a release whose announcement quote exceeds the 300-char limit', () => {
    const long = 'x'.repeat(MAX_QUOTE_CHARS + 1);
    const { releases, dropped } = validateExtraction(extraction({ announcement_quote: long }), OPTS);
    expect(releases).toHaveLength(0);
    expect(dropped[0]?.reason).toContain('300');
  });

  test('drops a duplicate release from the same response', () => {
    const two = extraction();
    two.releases.push({ ...two.releases[0]! });
    const { releases, dropped } = validateExtraction(two, OPTS);
    expect(releases).toHaveLength(1);
    expect(dropped[0]?.reason).toBe('duplicate in response');
  });
});

describe('validateExtraction — scores', () => {
  test('drops a score whose quote is not on the page', () => {
    const { releases, dropped } = validateExtraction(
      extraction({ scores: [{ benchmark: 'aime', value: 99.1, config: null, quote: 'GPT-6 scores 99.1% on AIME 2025' }] }),
      OPTS,
    );
    expect(releases[0]?.scores).toHaveLength(0);
    expect(dropped[0]).toMatchObject({ kind: 'score', benchmark: 'aime', reason: 'quote not found on page' });
  });

  test('drops a score whose quote is real but does not contain the number', () => {
    const { releases, dropped } = validateExtraction(
      extraction({ scores: [{ benchmark: 'aime', value: 99.1, config: null, quote: 'GPT-6 is available today in the API' }] }),
      OPTS,
    );
    expect(releases[0]?.scores).toHaveLength(0);
    expect(dropped[0]?.reason).toContain('does not contain the value');
  });

  test('drops a benchmark that is not in the basket', () => {
    const { releases, dropped } = validateExtraction(
      extraction({ scores: [{ benchmark: 'mmlu-super', value: 92.4, config: null, quote: 'it reaches 92.4% with no tools' }] }),
      OPTS,
    );
    expect(releases[0]?.scores).toHaveLength(0);
    expect(dropped[0]?.reason).toBe('benchmark not in basket');
  });

  test('drops an out-of-range value', () => {
    const { releases, dropped } = validateExtraction(
      extraction({ scores: [{ benchmark: 'gpqa-diamond', value: 1234, config: null, quote: 'it scores 1,234 points on an internal eval' }] }),
      OPTS,
    );
    expect(releases[0]?.scores).toHaveLength(0);
    expect(dropped[0]?.reason).toContain('out of range');
  });

  test('keeps the good scores and drops only the bad one', () => {
    const { releases, dropped } = validateExtraction(
      extraction({
        scores: [
          { benchmark: 'gpqa-diamond', value: 92.4, config: 'no tools', quote: 'it reaches 92.4% with no tools' },
          { benchmark: 'swe-bench-verified', value: 84.2, config: null, quote: 'On SWE-bench Verified GPT-6 reaches 84.2%' },
          { benchmark: 'hle', value: 61.0, config: null, quote: 'GPT-6 scores 61% on Humanity’s Last Exam' },
        ],
      }),
      OPTS,
    );
    expect(releases[0]?.scores.map((s) => s.benchmark)).toEqual(['gpqa-diamond', 'swe-bench-verified']);
    expect(dropped).toHaveLength(1);
  });

  test('drops a duplicate benchmark+config pair', () => {
    const { releases, dropped } = validateExtraction(
      extraction({
        scores: [
          { benchmark: 'gpqa-diamond', value: 92.4, config: 'no tools', quote: 'it reaches 92.4% with no tools' },
          { benchmark: 'gpqa-diamond', value: 92.4, config: 'no tools', quote: 'it reaches 92.4% with no tools' },
        ],
      }),
      OPTS,
    );
    expect(releases[0]?.scores).toHaveLength(1);
    expect(dropped[0]?.reason).toContain('duplicate');
  });
});

describe('validateExtraction — dates and status', () => {
  test('expands YYYY-MM to the first of the month and caps precision', () => {
    const { releases } = validateExtraction(extraction({ date: '2026-05', date_precision: 'day' }), OPTS);
    expect(releases[0]?.date).toBe('2026-05-01');
    expect(releases[0]?.date_precision).toBe('month');
  });

  test('a released model with no date is dropped', () => {
    const { releases, dropped } = validateExtraction(extraction({ date: null }), OPTS);
    expect(releases).toHaveLength(0);
    expect(dropped[0]?.reason).toBe('no usable date');
  });

  test('an announced model with no date falls back to the item date with unknown precision', () => {
    const { releases } = validateExtraction(extraction({ status: 'announced', date: null }), OPTS);
    expect(releases[0]?.date).toBe('2026-09-01');
    expect(releases[0]?.date_precision).toBe('unknown');
  });

  test('a released model dated in the future is dropped', () => {
    const { releases, dropped } = validateExtraction(extraction({ date: '2027-01-01' }), OPTS);
    expect(releases).toHaveLength(0);
    expect(dropped[0]?.reason).toContain('in the future');
  });

  test('forceStatus and dropScores turn press coverage into a bare rumor', () => {
    const { releases } = validateExtraction(extraction(), { ...OPTS, forceStatus: 'rumored', dropScores: true });
    expect(releases[0]?.status).toBe('rumored');
    expect(releases[0]?.scores).toHaveLength(0);
  });
});

describe('prompt', () => {
  const lab = {
    id: 'openai', name: 'OpenAI', short: 'OpenAI', color: '#10A37F', color_note: '',
    website: 'https://openai.com', sources: [], flagship_hints: [],
  } as unknown as Lab;
  const benchmarks = [
    { id: 'gpqa-diamond', name: 'GPQA Diamond', short: 'GPQA', preferred_config: 'no tools, pass@1' },
  ] as unknown as Benchmark[];
  const prompt = buildUserPrompt({
    lab, today: '2026-09-07', benchmarks, pageUrl: 'https://openai.com/x', pageText: PAGE,
  });

  test('carries the lab, the date, the flagship definition and the basket', () => {
    expect(prompt).toContain('OpenAI');
    expect(prompt).toContain('TODAY: 2026-09-07');
    expect(prompt).toContain('mini, nano, flash');
    expect(prompt).toContain('gpqa-diamond — GPQA Diamond');
    expect(prompt).toContain('no tools, pass@1');
  });

  test('carries the availability wording rules and the page text', () => {
    expect(prompt).toContain('available today');
    expect(prompt).toContain('rolling out to');
    expect(prompt).toContain('coming soon');
    expect(prompt).toContain('GPT-6 is available today in the API');
  });

  test('the JSON schema is strict and requires every field', () => {
    expect(EXTRACTION_JSON_SCHEMA.strict).toBe(true);
    const item = EXTRACTION_JSON_SCHEMA.schema.properties.releases.items;
    expect(item.additionalProperties).toBe(false);
    expect([...item.required]).toEqual(Object.keys(item.properties));
  });
});

describe('parseJsonContent', () => {
  test.each([
    ['{"releases":[]}'],
    ['```json\n{"releases":[]}\n```'],
    ['```\n{"releases":[]}\n```'],
    ['Sure! {"releases":[]}'],
  ])('parses %s', (content) => {
    expect(ExtractionSchema.safeParse(parseJsonContent(content)).success).toBe(true);
  });

  test('throws on content with no JSON at all', () => {
    expect(() => parseJsonContent('I cannot help with that.')).toThrow();
  });
});

describe('OpenRouterClient', () => {
  const base = { apiKey: 'k', baseUrl: 'https://openrouter.test/api/v1', referer: 'https://agi.pablogfx.com', title: 'AGI Frontier' };

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  test('sends the documented headers and returns parsed JSON', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const client = new OpenRouterClient({
      ...base,
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return jsonResponse({ choices: [{ message: { content: '{"releases":[]}' } }] });
      }) as unknown as typeof fetch,
    });
    const res = await client.chatJson({ model: 'm', system: 's', user: 'u', jsonSchema: EXTRACTION_JSON_SCHEMA });
    expect(res.json).toEqual({ releases: [] });
    expect(res.usedJsonObjectFallback).toBe(false);
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(seen[0]?.url).toBe('https://openrouter.test/api/v1/chat/completions');
    expect(headers['Authorization']).toBe('Bearer k');
    expect(headers['HTTP-Referer']).toBe('https://agi.pablogfx.com');
    expect(headers['X-Title']).toBe('AGI Frontier');
    const body = JSON.parse(String(seen[0]?.init.body)) as { response_format: { type: string } };
    expect(body.response_format.type).toBe('json_schema');
  });

  test('falls back to json_object when the model rejects json_schema', async () => {
    const formats: string[] = [];
    const client = new OpenRouterClient({
      ...base,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { response_format: { type: string } };
        formats.push(body.response_format.type);
        if (body.response_format.type === 'json_schema') {
          return new Response('{"error":{"message":"response_format json_schema is not supported"}}', { status: 400 });
        }
        return jsonResponse({ choices: [{ message: { content: '{"releases":[]}' } }] });
      }) as unknown as typeof fetch,
    });
    const res = await client.chatJson({ model: 'm', system: 's', user: 'u', jsonSchema: EXTRACTION_JSON_SCHEMA });
    expect(formats).toEqual(['json_schema', 'json_object']);
    expect(res.usedJsonObjectFallback).toBe(true);
  });

  test('listModelIds collects catalogue ids', async () => {
    const client = new OpenRouterClient({
      ...base,
      fetchImpl: (async () => jsonResponse({ data: [{ id: 'google/gemini-2.5-flash-lite' }, { id: 'x/y' }] })) as unknown as typeof fetch,
    });
    const ids = await client.listModelIds();
    expect(ids.has('google/gemini-2.5-flash-lite')).toBe(true);
    expect(ids.size).toBe(2);
  });
});
