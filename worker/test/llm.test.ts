import { describe, expect, test } from 'bun:test';
import {
  EXTRACTION_JSON_SCHEMA,
  ExtractedReleaseSchema,
  ExtractionSchema,
  MAX_QUOTE_CHARS,
  OpenRouterClient,
  OpenRouterError,
  buildUserPrompt,
  estimateUsd,
  parseJsonContent,
  priceFor,
  resolveTier,
  scoreInRange,
  validateExtraction,
  withRetry,
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

  test('drops a community benchmark score (LMArena is maintainer-only)', () => {
    // A lab post saying "tops LMArena at 1462" must never become an `official` score.
    const arenaBenchmarks = [
      { id: 'gpqa-diamond', unit: '%', min: 0, max: 100 },
      { id: 'lmarena-text', unit: 'elo', min: 0, max: 4000, community: true },
    ] as unknown as Benchmark[];
    const { releases, dropped } = validateExtraction(
      extraction({
        scores: [
          { benchmark: 'gpqa-diamond', value: 92.4, config: 'no tools', quote: 'it reaches 92.4% with no tools' },
          { benchmark: 'lmarena-text', value: 1462, config: null, quote: 'GPT-6 tops LMArena at 1462' },
        ],
      }),
      { ...OPTS, benchmarkIds: new Set([...BENCHMARK_IDS, 'lmarena-text']), benchmarks: arenaBenchmarks },
    );
    expect(releases[0]?.scores.map((s) => s.benchmark)).toEqual(['gpqa-diamond']);
    expect(dropped[0]).toMatchObject({ kind: 'score', benchmark: 'lmarena-text', reason: 'community benchmark — maintainer only' });
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
    expect(prompt).toContain('unit: percentage 0-100');
    expect(prompt).toContain('TIER RULES');
    // The benchmark line carries its preferred evaluation config.
    expect(prompt).toContain('preferred config: no tools, pass@1');
  });

  test('community benchmarks (LMArena) never appear in the basket', () => {
    const withArena = buildUserPrompt({
      lab,
      today: '2026-09-07',
      benchmarks: [
        { id: 'gpqa-diamond', name: 'GPQA Diamond', short: 'GPQA', unit: '%', min: 0, max: 100 } as unknown as Benchmark,
        { id: 'lmarena-text', name: 'LMArena Text', short: 'LMArena', unit: 'elo', min: 0, max: 4000, community: true } as unknown as Benchmark,
      ],
      pageUrl: 'https://openai.com/x',
      pageText: PAGE,
    });
    expect(withArena).toContain('gpqa-diamond');
    expect(withArena).not.toContain('lmarena-text');
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

describe('tier', () => {
  test('the schema carries the raw tier enum and it is required', () => {
    const item = EXTRACTION_JSON_SCHEMA.schema.properties.releases.items;
    expect(item.properties.tier).toBeDefined();
    expect(item.required).toContain('tier');
  });

  test('a response without a tier degrades to unknown instead of failing', () => {
    const parsed = ExtractedReleaseSchema.safeParse({
      name: 'GPT-6', family: 'GPT', status: 'released', date: '2026-05-04',
      date_precision: 'day', announcement_quote: 'q', scores: [], notes: null,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.tier).toBe('unknown');
  });

  test('resolveTier maps unknown via flagship hints, else leaves the tier unset', () => {
    // Like the real labs.json hints: a negative lookahead keeps sub-tiers out of flagship.
    const hints = [/^gpt-\d(?!.*(mini|nano))/i, /opus/i];
    expect(resolveTier('flagship', 'anything', hints)).toBe('flagship');
    expect(resolveTier('mid', 'anything', hints)).toBe('mid');
    expect(resolveTier('small', 'anything', hints)).toBe('small');
    expect(resolveTier('unknown', 'GPT-6 Turbo', hints)).toBe('flagship');
    // A non-hinted name resolves to undefined — never a hint-derived `mid` that would demote
    // a real flagship (unset = flagship by contract).
    expect(resolveTier('unknown', 'GPT-6 mini', hints)).toBeUndefined();
    expect(resolveTier(undefined, 'mystery model', hints)).toBeUndefined();
    expect(resolveTier('nonsense', 'mystery model', [])).toBeUndefined();
  });

  test('an explicit tier survives even when hints would disagree', () => {
    expect(resolveTier('small', 'GPT-6', [/^gpt/])).toBe('small');
  });
});

describe('scoreInRange', () => {
  const benchmarks = [
    { id: 'gpqa-diamond', unit: '%', min: 0, max: 100 },
    { id: 'lmarena-text', unit: 'elo', min: 0, max: 4000 },
  ] as unknown as Benchmark[];
  const ids = new Set(['gpqa-diamond', 'lmarena-text']);

  test('percent benchmarks reject values above 100', () => {
    expect(scoreInRange('gpqa-diamond', 92.4, benchmarks, ids)).toBe(true);
    expect(scoreInRange('gpqa-diamond', 1493, benchmarks, ids)).toBe(false);
  });

  test('elo benchmarks accept Elo ratings and reject percentages-of-100 scale nonsense', () => {
    expect(scoreInRange('lmarena-text', 1493, benchmarks, ids)).toBe(true);
    expect(scoreInRange('lmarena-text', 2400, benchmarks, ids)).toBe(true);
    expect(scoreInRange('lmarena-text', 4200, benchmarks, ids)).toBe(false);
  });

  test('without a benchmark table it falls back to the 0-100 rule for basket ids', () => {
    expect(scoreInRange('gpqa-diamond', 92.4, undefined, ids)).toBe(true);
    expect(scoreInRange('gpqa-diamond', 120, undefined, ids)).toBe(false);
  });

  test('non-finite values are always out of range', () => {
    expect(scoreInRange('gpqa-diamond', Number.NaN, benchmarks, ids)).toBe(false);
  });
});

describe('usage accounting', () => {
  const base = { apiKey: 'k', baseUrl: 'https://openrouter.test/api/v1', referer: 'https://agi.pablogfx.com', title: 'AGI Frontier' };

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  test('chatJson books prompt/completion tokens onto the running totals', async () => {
    let call = 0;
    const client = new OpenRouterClient({
      ...base,
      fetchImpl: (async () => {
        call++;
        return jsonResponse({
          choices: [{ message: { content: '{"releases":[]}' } }],
          usage: { prompt_tokens: 1000, completion_tokens: 200 },
        });
      }) as unknown as typeof fetch,
    });
    await client.chatJson({ model: 'google/gemini-3.1-flash-lite', system: 's', user: 'u' });
    await client.chatJson({ model: 'google/gemini-3.1-flash-lite', system: 's', user: 'u' });
    const stats = client.stats();
    expect(stats.calls).toBe(2);
    expect(stats.tokens_in).toBe(2000);
    expect(stats.tokens_out).toBe(400);
    // 2 × (1000/1M × $0.25 + 200/1M × $1.0) = 0.0009
    expect(stats.usd_estimate).toBeCloseTo(0.0009, 10);
    // A copy: mutating it must not touch the client's books.
    stats.calls = 99;
    expect(client.stats().calls).toBe(2);
  });

  test('responses without usage still succeed and still count as a call', async () => {
    const client = new OpenRouterClient({
      ...base,
      fetchImpl: (async () => jsonResponse({ choices: [{ message: { content: '{"releases":[]}' } }] })) as unknown as typeof fetch,
    });
    await client.chatJson({ model: 'm', system: 's', user: 'u' });
    // Calls are always counted (the per-run budget depends on it); only tokens stay 0.
    expect(client.stats()).toEqual({ calls: 1, tokens_in: 0, tokens_out: 0, usd_estimate: 0 });
  });

  test('priceFor honours env overrides and the :online per-call surcharge', () => {
    expect(priceFor('google/gemini-3.1-flash-lite')).toEqual({ inPerM: 0.25, outPerM: 1.0 });
    const online = priceFor('google/gemini-3.1-flash-lite:online');
    expect(online.perCall).toBe(0.02);
    expect(estimateUsd(online, 0, 0)).toBe(0.02);
    expect(priceFor('unknown/model').inPerM).toBe(0);
    const overridden = priceFor('unknown/model', { inPerM: 2, outPerM: 8 });
    expect(overridden).toEqual({ inPerM: 2, outPerM: 8 });
  });
});

describe('withRetry', () => {
  const noSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 0)));

  test('a non-retryable status (401) rethrows immediately — exactly one attempt', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new OpenRouterError('chat/completions 401', 401, 'invalid key');
        },
        { maxAttempts: 6, sleepImpl: noSleep },
      ),
    ).rejects.toThrow('401');
    expect(attempts).toBe(1);
  });

  test('a retryable 429 is retried and succeeds on the next attempt', async () => {
    let attempts = 0;
    const delays: number[] = [];
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts === 1) throw new OpenRouterError('chat/completions 429', 429, 'rate limited');
        return 'ok';
      },
      { maxAttempts: 6, sleepImpl: noSleep, random: () => 0.5, onRetry: (_a, d) => delays.push(d) },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThan(0);
  });

  test('exhausting all attempts rethrows the last error', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new OpenRouterError('chat/completions 503', 503, 'upstream');
        },
        { maxAttempts: 3, sleepImpl: noSleep },
      ),
    ).rejects.toThrow('503');
    expect(attempts).toBe(3);
  });

  test('the client wires onRetry into a warn log carrying the status only', async () => {
    const warnings: unknown[] = [];
    const client = new OpenRouterClient({
      apiKey: 'k',
      baseUrl: 'https://openrouter.test/api/v1',
      referer: 'https://agi.pablogfx.com',
      title: 'AGI Frontier',
      maxAttempts: 2,
      sleepImpl: () => Promise.resolve(),
      random: () => 0.5,
      log: {
        child: () => { throw new Error('not used'); },
        info: () => {},
        debug: () => {},
        error: () => {},
        warn: (msg: string, data?: Record<string, unknown>) => warnings.push([msg, data]),
      } as never,
      fetchImpl: (async (attempt: number = 0) => {
        void attempt;
        return new Response('{"error":{"message":"rate limited"}}', { status: 429, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch,
    });
    await expect(client.chatJson({ model: 'm', system: 's', user: 'u' })).rejects.toThrow();
    expect(warnings).toHaveLength(1);
    const [msg, data] = warnings[0] as [string, Record<string, unknown>];
    expect(msg).toBe('openrouter retry');
    expect(data?.status).toBe(429);
    expect(data?.delay_ms).toBeGreaterThan(0);
    expect(data?.attempt).toBe(0);
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
