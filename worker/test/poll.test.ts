/**
 * End-to-end `poll`, with the network and OpenRouter both mocked.
 * Covers what the unit tests cannot: bootstrap, hash-diff, budget, the quote gate,
 * the write/validate/bundle sequence and idempotence of the whole command.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger } from '../src/log';
import { createRuntime, type Runtime } from '../src/runtime';
import { runPoll } from '../src/commands/poll';
import { bundlePath, changesPath, labFilePath, readChanges } from '../src/data-store';
import { validateData } from '../src/validate';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let dataDir: string;
let stateDir: string;

const ANNOUNCEMENT_URL = 'https://openai.com/index/introducing-gpt-6/';

const ARTICLE = `Introducing GPT-6

GPT-6 is available today in the API and in ChatGPT.

On GPQA Diamond, GPT-6 reaches 93.1% with no tools. On SWE-bench Verified it reaches 84.2%.
We also measured 61.4% on Humanity's Last Exam.`;

function feed(items: { title: string; link: string; date: string }[]): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>OpenAI News</title>${items
    .map((i) => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${i.date}</pubDate></item>`)
    .join('')}</channel></rss>`;
}

const OLD_POST = { title: 'A note on safety', link: 'https://openai.com/index/safety-note/', date: 'Mon, 01 Jun 2026 10:00:00 GMT' };
const NEW_POST = { title: 'Introducing GPT-6', link: ANNOUNCEMENT_URL, date: 'Mon, 04 May 2026 17:00:00 GMT' };

const LLM_ANSWER = {
  releases: [
    {
      name: 'GPT-6',
      family: 'GPT',
      status: 'released',
      date: '2026-05-04',
      date_precision: 'day',
      announcement_quote: 'GPT-6 is available today in the API and in ChatGPT.',
      scores: [
        { benchmark: 'gpqa-diamond', value: 93.1, config: 'no tools', quote: 'GPT-6 reaches 93.1% with no tools' },
        { benchmark: 'swe-bench-verified', value: 84.2, config: null, quote: 'On SWE-bench Verified it reaches 84.2%' },
        // Invented: this sentence is not on the page, so it must be dropped.
        { benchmark: 'aime', value: 99.9, config: null, quote: 'GPT-6 scores 99.9% on AIME 2025' },
      ],
      notes: null,
    },
    {
      // Not on the page either — the whole release must be dropped.
      name: 'GPT-6 Turbo',
      family: 'GPT',
      status: 'released',
      date: '2026-05-04',
      date_precision: 'day',
      announcement_quote: 'GPT-6 Turbo is available today for enterprise customers.',
      scores: [],
      notes: null,
    },
  ],
};

interface MockState {
  feedItems: { title: string; link: string; date: string }[];
  llmCalls: number;
  fetched: string[];
}

let mock: MockState;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const fetchImpl = (async (url: string, init?: RequestInit): Promise<Response> => {
  mock.fetched.push(url);
  if (url.endsWith('/api/v1/models')) return json({ data: [{ id: 'google/gemini-2.5-flash-lite' }] });
  if (url.endsWith('/chat/completions')) {
    mock.llmCalls++;
    void init;
    return json({ choices: [{ message: { content: JSON.stringify(LLM_ANSWER) } }] });
  }
  if (url === 'https://openai.com/news/rss.xml') {
    return new Response(feed(mock.feedItems), { status: 200, headers: { 'content-type': 'application/xml' } });
  }
  if (url === 'https://openai.com/news/') {
    const links = mock.feedItems.map((i) => `<a href="${i.link}">${i.title}</a>`).join('');
    return new Response(`<html><body>${links}</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
  }
  if (url === ANNOUNCEMENT_URL) {
    return new Response(`<html><body><article>${ARTICLE}</article></body></html>`, {
      status: 200, headers: { 'content-type': 'text/html' },
    });
  }
  return new Response('not found', { status: 404 });
}) as unknown as typeof fetch;

function runtime(): Runtime {
  return createRuntime({
    log: new Logger('error', {}, () => {}),
    fetchImpl,
    minHostIntervalMs: 0,
    config: {
      dataDir,
      stateDir,
      repoRoot: dataDir,
      openRouterApiKey: 'test-key',
      openRouterBaseUrl: 'https://openrouter.test/api/v1',
      openRouterModel: 'google/gemini-2.5-flash-lite',
      gitPush: false,
      maxLlmCallsPerRun: 20,
      pageCacheTtlMs: 0,
    },
  });
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'agi-poll-'));
  dataDir = join(root, 'data');
  stateDir = join(root, 'state');
  mkdirSync(join(dataDir, 'models'), { recursive: true });
  mkdirSync(join(dataDir, 'history'), { recursive: true });
  mkdirSync(join(dataDir, 'public'), { recursive: true });
  copyFileSync(join(repoRoot, 'data', 'benchmarks.json'), join(dataDir, 'benchmarks.json'));
  // A single-lab labs.json keeps the mock small.
  const labs = JSON.parse(readFileSync(join(repoRoot, 'data', 'labs.json'), 'utf8')) as { id: string }[];
  writeFileSync(join(dataDir, 'labs.json'), JSON.stringify(labs.filter((l) => l.id === 'openai'), null, 2), 'utf8');
  writeFileSync(changesPath(dataDir), '', 'utf8');
  mock = { feedItems: [OLD_POST], llmCalls: 0, fetched: [] };
});

afterEach(() => rmSync(dirname(dataDir), { recursive: true, force: true }));

describe('poll', () => {
  test('the first run records a baseline and calls no LLM', async () => {
    expect(await runPoll(runtime(), {})).toBe(0);
    expect(mock.llmCalls).toBe(0);
    expect(existsSync(labFilePath(dataDir, 'openai'))).toBe(false);
    expect(existsSync(join(stateDir, 'hashes.json'))).toBe(true);
    expect(existsSync(bundlePath(dataDir))).toBe(true);
  });

  test('an unchanged source on the next run still calls no LLM', async () => {
    await runPoll(runtime(), {});
    mock.fetched = [];
    expect(await runPoll(runtime(), {})).toBe(0);
    expect(mock.llmCalls).toBe(0);
    expect(mock.fetched.some((u) => u === ANNOUNCEMENT_URL)).toBe(false);
  });

  test('a new post is extracted, quote-checked, merged and bundled', async () => {
    await runPoll(runtime(), {}); // bootstrap
    mock.feedItems = [NEW_POST, OLD_POST];
    expect(await runPoll(runtime(), {})).toBe(0);

    expect(mock.llmCalls).toBeGreaterThan(0);
    const file = JSON.parse(readFileSync(labFilePath(dataDir, 'openai'), 'utf8')) as {
      releases: { id: string; name: string; status: string; date: string; scores: { benchmark: string; value: number }[] }[];
    };
    expect(file.releases).toHaveLength(1);
    const gpt6 = file.releases[0]!;
    expect(gpt6.id).toBe('openai-gpt-6');
    expect(gpt6.status).toBe('released');
    expect(gpt6.date).toBe('2026-05-04');

    // The invented AIME score and the invented "GPT-6 Turbo" release are gone.
    expect(gpt6.scores.map((s) => s.benchmark).sort()).toEqual(['gpqa-diamond', 'swe-bench-verified']);
    expect(file.releases.some((r) => r.name === 'GPT-6 Turbo')).toBe(false);

    expect(validateData(dataDir).errors).toEqual([]);
    expect(readChanges(dataDir).some((c) => c.kind === 'release_added')).toBe(true);

    const bundle = JSON.parse(readFileSync(bundlePath(dataDir), 'utf8')) as {
      releases: unknown[]; worker: { llm_model: string | null; pages_polled: number };
    };
    expect(bundle.releases).toHaveLength(1);
    expect(bundle.worker.llm_model).toBe('google/gemini-2.5-flash-lite');
    expect(bundle.worker.pages_polled).toBeGreaterThan(0);
    // A poll feeds the lifetime total but never `budget` — that stays the last *research*
    // run's delta (REDESIGN §12.6: showing the poll's delta there read as "the LLM is broken").
    const withUsage = JSON.parse(readFileSync(bundlePath(dataDir), 'utf8')) as {
      worker: { researcher: { budget: { calls: number } | null; usage_total: { calls: number } | null; last_backfill_summary: string | null } };
    };
    expect(withUsage.worker.researcher.usage_total?.calls).toBe(mock.llmCalls);
    expect(withUsage.worker.researcher.budget).toBeNull();
    expect(withUsage.worker.researcher.last_backfill_summary).toBeNull();
  });

  test('re-running after a successful extraction changes nothing', async () => {
    await runPoll(runtime(), {});
    mock.feedItems = [NEW_POST, OLD_POST];
    await runPoll(runtime(), {});
    const file = readFileSync(labFilePath(dataDir, 'openai'), 'utf8');
    const changes = readChanges(dataDir).length;

    // Force the item to look new again: the merge, not the hash, must be what stops us.
    rmSync(join(stateDir, 'hashes.json'), { force: true });
    await runPoll(runtime(), {}); // re-bootstraps
    mock.feedItems = [{ ...NEW_POST, title: 'Introducing GPT-6 (updated)' }, OLD_POST];
    await runPoll(runtime(), {});

    expect(readFileSync(labFilePath(dataDir, 'openai'), 'utf8')).toBe(file);
    expect(readChanges(dataDir)).toHaveLength(changes);
  });

  test('the LLM budget caps a run', async () => {
    await runPoll(runtime(), {});
    mock.feedItems = [
      NEW_POST,
      { title: 'Introducing model A', link: 'https://openai.com/index/a/', date: 'Mon, 05 May 2026 10:00:00 GMT' },
      { title: 'Introducing model B', link: 'https://openai.com/index/b/', date: 'Mon, 06 May 2026 10:00:00 GMT' },
      OLD_POST,
    ];
    const rt = runtime();
    rt.config.maxLlmCallsPerRun = 1;
    await runPoll(rt, {});
    expect(mock.llmCalls).toBe(1);
  });

  test('--dry-run writes nothing and calls nothing', async () => {
    mock.feedItems = [NEW_POST, OLD_POST];
    expect(await runPoll(runtime(), { dryRun: true })).toBe(0);
    expect(mock.llmCalls).toBe(0);
    expect(existsSync(labFilePath(dataDir, 'openai'))).toBe(false);
    expect(existsSync(join(stateDir, 'hashes.json'))).toBe(false);
    expect(existsSync(bundlePath(dataDir))).toBe(false);
  });
});
