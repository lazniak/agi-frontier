import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DRY_RUN_DISCOVERY,
  INCREMENTAL_WINDOW_DAYS,
  MAX_OVERVIEW_LINKS,
  formatBackfillSummary,
  incrementalSkip,
  indexDate,
  isWithinIncrementalWindow,
  planBackfill,
  runBackfillImpl,
} from '../src/researcher/backfill';
import { StateStore } from '../src/state';
import { nameKey as nameKeyOf } from '../src/text';
import type { DiscoveryResult } from '../src/researcher/discovery';
import type { DiscoveredModel } from '../src/researcher/discovery';
import type { LabFile, ModelRelease } from '@agi/shared';

const repoRoot = join(import.meta.dir, '..', '..');
const NOW = '2026-09-07T04:00:00Z';
const TODAY = '2026-09-07';

const discovered = (over: Partial<DiscoveredModel> = {}): DiscoveredModel => ({
  name: 'GPT-7',
  family: 'GPT',
  tier: 'flagship',
  date: '2026-08-30',
  launch_url: 'https://openai.com/index/gpt-7/',
  confidence: 0.9,
  ...over,
});

const PAGE_TEXT = [
  'Introducing GPT-7',
  '',
  'GPT-7 is available today in the API and in ChatGPT for all paid plans.',
  'On GPQA Diamond GPT-7 reaches 94.1% with no tools, pass@1.',
].join('\n');

/** What the fake OpenRouter always answers — a real extraction whose quotes live on PAGE_TEXT. */
const EXTRACTION_JSON = JSON.stringify({
  releases: [
    {
      name: 'GPT-7',
      family: 'GPT',
      tier: 'flagship',
      status: 'released',
      date: '2026-08-30',
      date_precision: 'day',
      announcement_quote: 'GPT-7 is available today in the API and in ChatGPT for all paid plans.',
      scores: [
        { benchmark: 'gpqa-diamond', value: 94.1, config: 'no tools', quote: 'On GPQA Diamond GPT-7 reaches 94.1% with no tools, pass@1.' },
      ],
      notes: null,
    },
  ],
});

const release = (over: Partial<ModelRelease> = {}): ModelRelease => ({
  id: 'openai-gpt-6',
  lab: 'openai',
  name: 'GPT-6',
  family: 'GPT',
  date: '2026-05-04',
  date_precision: 'day',
  status: 'released',
  announcement: { url: 'https://openai.com/x', quote: 'q', retrieved_at: NOW, verified: true },
  scores: [],
  ...over,
});

interface Harness {
  root: string;
  stateDir: string;
  dataDir: string;
  createRt: () => Promise<import('../src/runtime').Runtime>;
  fetchCalls: { url: string }[];
}

/** A temp repo with a single lab, a fake API key and a fully fake fetcher (no network). */
async function setup(opts: {
  modelsReleases?: ModelRelease[];
  pageText?: string;
  /** Per-URL page body (wins over `pageText`); `null` = 404. Matched against the fetched URL, proxy prefix included. */
  pageFor?: (url: string) => string | null | undefined;
  /** Override the LLM answer keyed by the request body (defaults to EXTRACTION_JSON). */
  extractionFor?: (chatKey: string) => string;
} = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'agi-backfill-'));
  const dataDir = join(root, 'data');
  const stateDir = join(root, 'state');
  await import('node:fs').then((fs) => {
    fs.mkdirSync(join(dataDir, 'models'), { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.copyFileSync(join(repoRoot, 'data', 'labs.json'), join(dataDir, 'labs.json'));
    fs.copyFileSync(join(repoRoot, 'data', 'benchmarks.json'), join(dataDir, 'benchmarks.json'));
    fs.writeFileSync(
      join(dataDir, 'models', 'openai.json'),
      JSON.stringify({ lab: 'openai', updated_at: NOW, releases: opts.modelsReleases ?? [] }),
      'utf8',
    );
  });
  const fetchCalls: { url: string }[] = [];
  const pageText = opts.pageText ?? PAGE_TEXT;
  return {
    root,
    stateDir,
    dataDir,
    fetchCalls,
    createRt: async () => {
      const { createRuntime } = await import('../src/runtime');
      return createRuntime({
        config: { repoRoot: root, dataDir, stateDir, gitPush: false, openRouterApiKey: 'test-key' },
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          const u = String(url);
          fetchCalls.push({ url: u });
          if (u.includes('openrouter')) {
            return new Response(
              JSON.stringify({
                choices: [{ message: { content: opts.extractionFor ? opts.extractionFor(String(init?.body ?? '')) : EXTRACTION_JSON } }],
                usage: { prompt_tokens: 500, completion_tokens: 100 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          const custom = opts.pageFor?.(u);
          if (custom === null) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
          const contentType = u.includes('rss.xml') ? 'application/rss+xml' : 'text/html';
          return new Response(custom ?? pageText, { status: 200, headers: { 'content-type': contentType } });
        }) as unknown as typeof fetch,
        minHostIntervalMs: 0,
      });
    },
  };
}

/** A fake `discoverModels` returning canned candidates, counting its calls. */
function fakeDiscovery(candidates: DiscoveredModel[], callsPerLab = 1) {
  const fn = async (): Promise<DiscoveryResult> => ({ candidates, errors: [], calls: callsPerLab });
  (fn as unknown as { callCount: number }).callCount = 0;
  const wrapped = ((...args: unknown[]) => {
    (wrapped as unknown as { callCount: number }).callCount++;
    return fn();
  }) as unknown as typeof import('../src/researcher/discovery').discoverModels;
  return wrapped;
}

describe('isWithinIncrementalWindow', () => {
  test('accepts recent dates and rejects old, future and missing ones', () => {
    expect(isWithinIncrementalWindow('2026-08-30', TODAY)).toBe(true);
    expect(isWithinIncrementalWindow('2026-05-15', TODAY)).toBe(true); // ~115 days
    expect(isWithinIncrementalWindow('2026-05-01', TODAY)).toBe(false); // > 120 days
    expect(isWithinIncrementalWindow('2024-01-01', TODAY)).toBe(false);
    expect(isWithinIncrementalWindow('2026-09-08', TODAY)).toBe(true); // 1 day ahead tolerated
    expect(isWithinIncrementalWindow('2026-09-10', TODAY)).toBe(false);
    expect(isWithinIncrementalWindow(null, TODAY)).toBe(false);
    expect(isWithinIncrementalWindow('not a date', TODAY)).toBe(false);
  });
});

describe('planBackfill', () => {
  test('without an API key and without a fake discovery it throws', async () => {
    const h = await setup();
    const { createRuntime } = await import('../src/runtime');
    const rt = createRuntime({
      config: { repoRoot: h.root, dataDir: h.dataDir, stateDir: h.stateDir, gitPush: false },
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      minHostIntervalMs: 0,
    });
    expect(rt.openRouter).toBeNull();
    expect(planBackfill(rt, {})).rejects.toThrow(/OPENROUTER_API_KEY/);
  });

  test('a dry run plans from the fixture without a key or network', async () => {
    const h = await setup();
    const rt = await h.createRt();
    const plan = await planBackfill(rt, { discoverImpl: DRY_RUN_DISCOVERY });
    expect(plan.labs.map((l) => l.lab.id)).toHaveLength(10);
    for (const { lab, candidates } of plan.labs) {
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.status).toBe('pending');
      expect(candidates[0]?.tier).toBe('flagship');
      void lab;
    }
  });

  test('respects the progress file, incremental window and data/models', async () => {
    const h = await setup({ modelsReleases: [release()] });
    const rt = await h.createRt();
    writeFileSync(
      join(h.stateDir, 'researcher-progress.json'),
      JSON.stringify({ updated_at: NOW, labs: { openai: { done: ['GPT-7 done'], failed: ['GPT-7 failed'] } } }),
      'utf8',
    );
    const plan = await planBackfill(rt, {
      incremental: true,
      discoverImpl: fakeDiscovery([
        discovered({ name: 'GPT-7 fresh' }),
        discovered({ name: 'GPT-7 done' }), // in progress.done -> done
        discovered({ name: 'GPT-7 failed' }), // in progress.failed -> failed-before
        discovered({ name: 'GPT-6' }), // in data/models, incremental -> already-in-models
        discovered({ name: 'GPT-1', date: '2018-06-11' }), // outside the window -> too-old
      ]),
    });
    const entries = plan.labs[0]?.candidates ?? [];
    expect(Object.fromEntries(entries.map((e) => [e.name, e.status]))).toEqual({
      'GPT-7 fresh': 'pending',
      'GPT-7 done': 'done',
      'GPT-7 failed': 'failed-before',
      'GPT-6': 'already-in-models',
      'GPT-1': 'too-old',
    });
  });

  test('the plan judges the prefixed name, so it agrees with the run it previews', async () => {
    // The run prefixes "Opus 5" to "Claude Opus 5" before the skip decision and records that
    // name in the progress file; a plan deciding on the bare name printed `pending` for a
    // candidate the run then skipped — and the plan is the operator's cost preview.
    const h = await setup();
    const rt = await h.createRt();
    writeFileSync(
      join(h.stateDir, 'researcher-progress.json'),
      JSON.stringify({ updated_at: NOW, labs: { anthropic: { done: ['Claude Opus 5'], failed: ['Claude Sonnet 5'] } } }),
      'utf8',
    );
    const plan = await planBackfill(rt, {
      lab: 'anthropic',
      discoverImpl: fakeDiscovery([
        discovered({ name: 'Opus 5', launch_url: 'https://www.anthropic.com/news/claude-opus-5' }),
        discovered({ name: 'Sonnet 5', launch_url: 'https://www.anthropic.com/news/claude-sonnet-5' }),
        discovered({ name: 'Haiku 5', launch_url: 'https://www.anthropic.com/news/claude-haiku-5' }),
      ]),
    });
    expect(Object.fromEntries((plan.labs[0]?.candidates ?? []).map((e) => [e.name, e.status]))).toEqual({
      'Claude Opus 5': 'done',
      'Claude Sonnet 5': 'failed-before',
      'Claude Haiku 5': 'pending',
    });

    // And the run really does skip the two: only the pending candidate's page is fetched.
    const before = h.fetchCalls.length;
    await runBackfillImpl(rt, {
      lab: 'anthropic',
      discoverImpl: fakeDiscovery([
        discovered({ name: 'Opus 5', launch_url: 'https://www.anthropic.com/news/claude-opus-5' }),
        discovered({ name: 'Sonnet 5', launch_url: 'https://www.anthropic.com/news/claude-sonnet-5' }),
        discovered({ name: 'Haiku 5', launch_url: 'https://www.anthropic.com/news/claude-haiku-5' }),
      ]),
    });
    const pageFetches = h.fetchCalls.slice(before).filter((c) => !c.url.includes('openrouter'));
    expect(pageFetches.length).toBeGreaterThan(0);
    expect(pageFetches.every((c) => c.url.includes('claude-haiku-5'))).toBe(true);
  });
});

describe('runBackfillImpl', () => {
  test('discovers, fetches, extracts through the quote gate and writes origin=researcher', async () => {
    const h = await setup();
    const rt = await h.createRt();
    // The page quote must be verbatim on the page or the release is dropped by the gate.
    const code = await runBackfillImpl(rt, { lab: 'openai', discoverImpl: fakeDiscovery([discovered()]) });
    expect(code).toBe(0);
    const out = JSON.parse(readFileSync(join(h.dataDir, 'researched', 'openai.json'), 'utf8')) as LabFile;
    expect(out.releases).toHaveLength(1);
    const rel = out.releases[0]!;
    expect(rel.name).toBe('GPT-7');
    expect(rel.origin).toBe('researcher');
    expect(rel.announcement.verified).toBe(true);
    expect(rel.announcement.quote).toContain('available today');
    expect(rel.scores[0]).toMatchObject({ benchmark: 'gpqa-diamond', value: 94.1, reported_by: 'official' });
    expect(rel.scores[0]?.source.verified).toBe(true);
    // Progress recorded the success.
    const progress = JSON.parse(readFileSync(join(h.stateDir, 'researcher-progress.json'), 'utf8')) as {
      labs: Record<string, { done: string[]; failed: string[] }>;
    };
    expect(progress.labs['openai']?.done).toEqual(['GPT-7']);
  });

  test('a quote invented by the model is dropped — the candidate lands in progress.failed', async () => {
    const h = await setup({ pageText: 'GPT-7 launch post with no benchmark numbers at all.' });
    const rt = await h.createRt();
    const code = await runBackfillImpl(rt, { lab: 'openai', discoverImpl: fakeDiscovery([discovered()]) });
    // Not a hard error: the run completes, the candidate is queued for retry via `failed`.
    expect(code).toBe(0);
    const out = JSON.parse(readFileSync(join(h.dataDir, 'researched', 'openai.json'), 'utf8')) as LabFile;
    expect(out.releases).toHaveLength(0);
    const progress = JSON.parse(readFileSync(join(h.stateDir, 'researcher-progress.json'), 'utf8')) as {
      labs: Record<string, { done: string[]; failed: string[] }>;
    };
    expect(progress.labs['openai']?.failed).toEqual(['GPT-7']);
    expect(progress.labs['openai']?.done).toEqual([]);
  });

  test('researcher.budget carries the per-run delta and the log keeps lifetime totals', async () => {
    const h = await setup();
    const rt = await h.createRt();
    // Simulate earlier runs on the shared client: lifetime totals already carry calls.
    await rt.openRouter!.chatJson({ model: 'm', system: 's', user: 'warm-up' });
    await rt.openRouter!.chatJson({ model: 'm', system: 's', user: 'warm-up-2' });
    const lifetimeBefore = rt.openRouter!.stats().calls; // 2
    await runBackfillImpl(rt, { lab: 'openai', discoverImpl: fakeDiscovery([discovered()]) });
    const run = new StateStore(h.stateDir).readRun();
    // Only the extraction call went through the client this run (the fake discovery bypasses
    // it) — the published budget must be the per-run delta (1), not the lifetime total (3).
    expect(run.researcher.budget?.calls).toBe(1);
    expect(rt.openRouter!.stats().calls).toBe(lifetimeBefore + 1);
    // Tokens land on the per-run delta too (the default test model is unpriced, so USD stays 0).
    expect(run.researcher.budget?.tokens_in).toBe(500);
  });

  test('the git commit sweeps data/researched only, with the backfill message', async () => {
    const h = await setup();
    // A real git repo in the temp dir: initial commit with everything except data/researched,
    // then the backfill must commit ONLY the researched file under the bot message.
    const git = (args: string[], cwd = h.root): void => {
      const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
      const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
      if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'test']);
    git(['add', 'data/labs.json', 'data/benchmarks.json', 'data/models/openai.json']);
    git(['commit', '-q', '-m', 'seed']);
    const rtReal = await h.createRt();
    const rtWithPush = { ...rtReal, config: { ...rtReal.config, gitPush: true } };
    await runBackfillImpl(rtWithPush, { lab: 'openai', discoverImpl: fakeDiscovery([discovered()]) });
    // HEAD is the bot commit; the rebase failed (no origin) but the commit stays local.
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const head = spawnSync('git', ['show', '--name-only', '--format=%s', 'HEAD'], { cwd: h.root, encoding: 'utf8' });
    const lines = (head.stdout ?? '').trim().split('\n');
    expect(lines[0]).toBe('data(bot): backfill openai');
    const files = lines.slice(1).filter((l) => l.trim().length > 0);
    expect(files).toEqual(['data/researched/openai.json']);
  });

  test('resumes from the progress file: done names are not re-fetched', async () => {
    const h = await setup();
    const rt = await h.createRt();
    writeFileSync(
      join(h.stateDir, 'researcher-progress.json'),
      JSON.stringify({ updated_at: NOW, labs: { openai: { done: ['GPT-7'], failed: [] } } }),
      'utf8',
    );
    await runBackfillImpl(rt, { lab: 'openai', discoverImpl: fakeDiscovery([discovered()]) });
    expect(h.fetchCalls).toHaveLength(0); // never fetched the launch page
    const out = JSON.parse(readFileSync(join(h.dataDir, 'researched', 'openai.json'), 'utf8')) as LabFile;
    expect(out.releases).toHaveLength(0);
  });

  test('progress is persisted per candidate and a re-run dedupes done/failed lists', async () => {
    // Extraction A succeeds; extraction B fails on an unreadable page. A re-run must not
    // refetch A (done) and must not grow the failed list beyond one entry per name.
    const h = await setup();
    // First page ok, second page 404 (r.jina.ai fallback included — both fail the gate).
    let pageCalls = 0;
    const rt0 = await h.createRt();
    const rt = {
      ...rt0,
      fetcher: (url: string, opts?: { minTextLength?: number }) => {
        void opts;
        pageCalls++;
        if (pageCalls <= 1) return rt0.fetcher(url, { minTextLength: 400 });
        return Promise.resolve({ ok: false, status: 404, text: '', url: String(url), error: 'not found' });
      },
    } as typeof rt0;
    const code = await runBackfillImpl(rt, {
      lab: 'openai',
      discoverImpl: fakeDiscovery([
        discovered(),
        discovered({ name: 'GPT-8', launch_url: 'https://openai.com/index/gpt-8/' }),
      ]),
    });
    void code;
    const progressPath = join(h.stateDir, 'researcher-progress.json');
    const after1 = JSON.parse(readFileSync(progressPath, 'utf8')) as {
      labs: Record<string, { done: string[]; failed: string[] }>;
    };
    expect(after1.labs['openai']?.done).toEqual(['GPT-7']);
    expect(after1.labs['openai']?.failed).toEqual(['GPT-8']);

    // A re-run: GPT-7 is done (never refetched), GPT-8 is retried and fails again —
    // the Set-deduped lists must stay exactly one entry per name.
    const fetchesBefore = pageCalls;
    await runBackfillImpl(rt, {
      lab: 'openai',
      discoverImpl: fakeDiscovery([
        discovered(),
        discovered({ name: 'GPT-8', launch_url: 'https://openai.com/index/gpt-8/' }),
      ]),
    });
    // Only GPT-8's page was attempted again (twice: direct + proxy fallback).
    expect(pageCalls - fetchesBefore).toBeLessThanOrEqual(2);
    const after2 = JSON.parse(readFileSync(progressPath, 'utf8')) as {
      labs: Record<string, { done: string[]; failed: string[] }>;
    };
    expect(after2.labs['openai']?.done).toEqual(['GPT-7']);
    expect(after2.labs['openai']?.failed).toEqual(['GPT-8']);
  });

  test('a budget of 1 stops after the first extraction attempt', async () => {
    const h = await setup();
    const rt0 = await h.createRt();
    const rt = { ...rt0, config: { ...rt0.config, researchMaxCalls: 1 } };
    const many = ['A', 'B', 'C'].map((n, i) =>
      discovered({ name: `GPT-7 ${n}`, launch_url: `https://openai.com/index/gpt-7-${i}/` }),
    );
    const code = await runBackfillImpl(rt, { lab: 'openai', discoverImpl: fakeDiscovery(many) });
    void code;
    // Discovery (1 fake call) spends the budget before any fetch... actually the budget is
    // spent per extraction; with max 1 only the first candidate is attempted.
    expect(h.fetchCalls.filter((c) => !c.url.includes('openrouter')).length).toBeLessThanOrEqual(1);
    const progress = JSON.parse(readFileSync(join(h.stateDir, 'researcher-progress.json'), 'utf8')) as {
      labs: Record<string, { done: string[]; failed: string[] }>;
    };
    // Exactly one candidate got its chance; the rest were cut by the budget stop.
    expect(progress.labs['openai']?.done.length + progress.labs['openai']?.failed.length).toBeLessThanOrEqual(1);
  });

  test('sets last_backfill_at (even on a budget-stopped run), so the weekly gate does not refire hourly', async () => {
    const h = await setup();
    const rt0 = await h.createRt();
    // The budget is exhausted before anything runs: the stamp must land anyway.
    const rt = { ...rt0, config: { ...rt0.config, researchMaxCalls: 0 } };
    const code = await runBackfillImpl(rt, { lab: 'openai', discoverImpl: fakeDiscovery([discovered()]) });
    void code;
    const run = new StateStore(h.stateDir).readRun();
    expect(run.researcher.last_backfill_at).toBeTypeOf('string');
    const { shouldBackfill } = await import('../src/commands/loop');
    expect(shouldBackfill(run.researcher.last_backfill_at, Date.now(), true)).toBe(false);
  });

  test('--incremental binds the real run: an in-models candidate and an old one are never fetched', async () => {
    const h = await setup({ modelsReleases: [release()] });
    const rt = await h.createRt();
    const before = h.fetchCalls.length;
    const code = await runBackfillImpl(rt, {
      lab: 'openai',
      incremental: true,
      discoverImpl: fakeDiscovery([
        discovered(), // fresh, not in data/models -> extracted
        discovered({ name: 'GPT-6' }), // already in data/models -> skipped
        discovered({ name: 'Legacy 1', date: '2020-01-01', launch_url: 'https://openai.com/index/legacy-1/' }), // outside the 120-day window
      ]),
    });
    expect(code).toBe(0);
    // Only the fresh candidate's launch page was fetched — directly and through the
    // r.jina.ai fallback proxy — and neither the in-models nor the too-old URL ever appears.
    const pageFetches = h.fetchCalls.slice(before).filter((c) => !c.url.includes('openrouter'));
    expect(pageFetches.length).toBeGreaterThan(0);
    expect(pageFetches.every((c) => c.url.includes('openai.com/index/gpt-7/'))).toBe(true);
    expect(pageFetches.some((c) => /gpt-6/i.test(c.url))).toBe(false);
    expect(pageFetches.some((c) => /legacy/i.test(c.url))).toBe(false);
  });

  test('incrementalSkip mirrors the plan predicate for done/failed/models/window', () => {
    const opts = {
      incremental: true,
      doneNames: new Set(['done model']),
      failedNames: new Set(['failed model']),
      modelNames: new Set([nameKeyOf('GPT-6')]),
      today: TODAY,
    };
    expect(incrementalSkip({ name: 'done model', date: TODAY }, opts)).toBe('done');
    expect(incrementalSkip({ name: 'failed model', date: TODAY }, opts)).toBe('failed-before');
    expect(incrementalSkip({ name: 'GPT-6', date: TODAY }, opts)).toBe('already-in-models');
    expect(incrementalSkip({ name: 'Ancient', date: '2020-01-01' }, opts)).toBe('too-old');
    expect(incrementalSkip({ name: 'GPT-7', date: TODAY }, opts)).toBeNull();
    // Non-incremental mode ignores the models/window checks entirely.
    expect(
      incrementalSkip({ name: 'GPT-6', date: '2020-01-01' }, { ...opts, incremental: false }),
    ).toBeNull();
    expect(INCREMENTAL_WINDOW_DAYS).toBe(120);
  });

  test('two candidates whose names slug to the same id get distinct ids', async () => {
    // "GPT-7 2026" and "GPT-7 2026." slug identically (the trailing dot is stripped by
    // slugify) but carry different nameKeys, so both pass the name-dedupe and collide in
    // releaseId — uniqueId must suffix the second one.
    const extractionFor = (chatKey: string): string => {
      const name = chatKey.includes('2026.') ? 'GPT-7 2026.' : 'GPT-7 2026';
      return JSON.stringify({
        releases: [
          {
            name,
            family: 'GPT',
            tier: 'flagship',
            status: 'released',
            date: '2026-08-30',
            date_precision: 'day',
            announcement_quote: 'GPT-7 is available today in the API and in ChatGPT for all paid plans.',
            scores: [
              { benchmark: 'gpqa-diamond', value: 94.1, config: 'no tools', quote: 'On GPQA Diamond GPT-7 reaches 94.1% with no tools, pass@1.' },
            ],
            notes: null,
          },
        ],
      });
    };
    const h = await setup({ extractionFor });
    const rt = await h.createRt();
    const a = discovered({ name: 'GPT-7 2026' });
    const b = discovered({ name: 'GPT-7 2026.', launch_url: 'https://openai.com/index/gpt-7-2026-b/' });
    await runBackfillImpl(rt, { lab: 'openai', discoverImpl: fakeDiscovery([a, b]) });
    const out = JSON.parse(readFileSync(join(h.dataDir, 'researched', 'openai.json'), 'utf8')) as LabFile;
    const ids = out.releases.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('openai-gpt-7-2026');
    expect(ids).toContain('openai-gpt-7-2026-2');
  });

  test('researcher.usage_total accumulates across runs and last_backfill_summary is one line', async () => {
    const h = await setup();
    const rt = await h.createRt();
    await runBackfillImpl(rt, { lab: 'openai', discoverImpl: fakeDiscovery([discovered()]) });
    const first = new StateStore(h.stateDir).readRun();
    expect(first.researcher.usage_total).toEqual({ calls: 1, tokens_in: 500, tokens_out: 100, usd_estimate: 0 });
    expect(first.researcher.budget).toEqual(first.researcher.usage_total);
    expect(first.researcher.last_backfill_summary).toBe('backfill: 1 lab, 1 candidate, 1 release / 1 score, 1 call · 0.00 USD');

    // A second run on a fresh client (a restart): the candidate is done, so 0 calls — the
    // lifetime total must survive the restart and the budget must show this run's 0.
    const rt2 = await h.createRt();
    await runBackfillImpl(rt2, { lab: 'openai', discoverImpl: fakeDiscovery([discovered()]) });
    const second = new StateStore(h.stateDir).readRun();
    expect(second.researcher.usage_total?.calls).toBe(1);
    expect(second.researcher.budget?.calls).toBe(0);
    expect(second.researcher.last_backfill_summary).toBe('backfill: 1 lab, 0 candidates, 0 releases / 0 scores, 0 calls · 0.00 USD');
  });

  test('formatBackfillSummary reads like the REDESIGN example', () => {
    const line = formatBackfillSummary(
      { labs: 10, candidates: 8, extracted: 1, releasesWritten: 1, scoresWritten: 0, llmCalls: 107, errors: 0, stoppedEarly: false },
      { calls: 107, tokens_in: 0, tokens_out: 0, usd_estimate: 2.03 },
    );
    expect(line).toBe('backfill: 10 labs, 8 candidates, 1 release / 0 scores, 107 calls · 2.03 USD');
    expect(
      formatBackfillSummary({ labs: 1, candidates: 3, extracted: 0, releasesWritten: 0, scoresWritten: 0, llmCalls: 2, errors: 1, stoppedEarly: true }, null),
    ).toBe('backfill: 1 lab, 3 candidates, 0 releases / 0 scores, 2 calls — budget stopped — 1 error');
  });

  test('a bare family member gets the lab prefix before the id is built ("Opus 5" → "Claude Opus 5")', async () => {
    const anthropicPage = [
      'Introducing Claude Opus 5',
      '',
      'Opus 5 is available today in the API and on claude.ai for all paid plans.',
      'On GPQA Diamond Opus 5 reaches 93.0% with no tools, pass@1.',
    ].join('\n');
    const extractionFor = (): string =>
      JSON.stringify({
        releases: [
          {
            name: 'Opus 5',
            family: 'Claude Opus',
            tier: 'flagship',
            status: 'released',
            date: '2026-07-24',
            date_precision: 'day',
            announcement_quote: 'Opus 5 is available today in the API and on claude.ai for all paid plans.',
            scores: [{ benchmark: 'gpqa-diamond', value: 93.0, config: 'no tools', quote: 'On GPQA Diamond Opus 5 reaches 93.0% with no tools, pass@1.' }],
            notes: null,
          },
        ],
      });
    const h = await setup({ pageText: anthropicPage, extractionFor });
    const rt = await h.createRt();
    const candidate = discovered({ name: 'Opus 5', family: 'Claude Opus', launch_url: 'https://www.anthropic.com/news/claude-opus-5', date: '2026-07-24' });
    const code = await runBackfillImpl(rt, { lab: 'anthropic', discoverImpl: fakeDiscovery([candidate]) });
    expect(code).toBe(0);
    const out = JSON.parse(readFileSync(join(h.dataDir, 'researched', 'anthropic.json'), 'utf8')) as LabFile;
    expect(out.releases).toHaveLength(1);
    expect(out.releases[0]?.name).toBe('Claude Opus 5');
    expect(out.releases[0]?.id).toBe('anthropic-claude-opus-5');
    // The candidate name was prefixed too, so progress records the canonical name.
    const progress = JSON.parse(readFileSync(join(h.stateDir, 'researcher-progress.json'), 'utf8')) as {
      labs: Record<string, { done: string[]; failed: string[] }>;
    };
    expect(progress.labs['anthropic']?.done).toEqual(['Claude Opus 5']);
  });

  test('an overview page is mined for launch-post links and never extracted itself', async () => {
    const overview = 'https://openai.com/models/gpt-7';
    const launch = 'https://openai.com/index/introducing-gpt-7/';
    const overviewHtml =
      '<html><body><h1>Models</h1>' +
      '<a href="/index/introducing-gpt-7/">Introducing GPT-7</a> ' +
      '<a href="/index/introducing-gpt-6/">Introducing GPT-6</a> ' +
      '<a href="/pricing">Pricing</a> <a href="https://x.com/openai">X</a> ' +
      '<a href="/models/gpt-7/docs/">Docs</a>' +
      `<p>${'GPT-7 is our most capable model. '.repeat(30)}</p></body></html>`;
    const h = await setup({
      pageFor: (u) => (u.includes('/models/gpt-7') ? overviewHtml : u.includes('introducing-gpt-7') ? PAGE_TEXT : undefined),
    });
    const rt = await h.createRt();
    const code = await runBackfillImpl(rt, { lab: 'openai', discoverImpl: fakeDiscovery([discovered({ launch_url: overview })]) });
    expect(code).toBe(0);
    const out = JSON.parse(readFileSync(join(h.dataDir, 'researched', 'openai.json'), 'utf8')) as LabFile;
    expect(out.releases).toHaveLength(1);
    // The release rests on the launch post, not on the catalogue page.
    expect(out.releases[0]?.announcement.url).toBe(launch);
    expect(out.releases[0]?.sources[0]?.url).toBe(launch);
    // Exactly one LLM call: the overview page cost a fetch, never an extraction.
    expect(h.fetchCalls.filter((c) => c.url.includes('openrouter')).length).toBe(1);
    expect(h.fetchCalls.some((c) => c.url.includes('introducing-gpt-6'))).toBe(false);
    expect(MAX_OVERVIEW_LINKS).toBe(3);
  });

  test('an overview page with no link naming the model fails the candidate without an LLM call', async () => {
    const overviewHtml = `<html><body><a href="/index/introducing-gpt-6/">GPT-6</a><p>${'catalogue text. '.repeat(40)}</p></body></html>`;
    const h = await setup({ pageFor: (u) => (u.includes('/models') ? overviewHtml : undefined) });
    const rt = await h.createRt();
    await runBackfillImpl(rt, { lab: 'openai', discoverImpl: fakeDiscovery([discovered({ launch_url: 'https://openai.com/models' })]) });
    expect(h.fetchCalls.filter((c) => c.url.includes('openrouter')).length).toBe(0);
    const progress = JSON.parse(readFileSync(join(h.stateDir, 'researcher-progress.json'), 'utf8')) as {
      labs: Record<string, { done: string[]; failed: string[] }>;
    };
    expect(progress.labs['openai']?.failed).toEqual(['GPT-7']);
  });

  test('a dateless extraction is retried once through the news index, then written from the launch post', async () => {
    const teaser = 'https://openai.com/index/gpt-7-teaser/';
    const launch = 'https://openai.com/index/introducing-gpt-7/';
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>OpenAI</title>
      <item><title>Introducing GPT-7</title><link>${launch}</link><pubDate>Sun, 30 Aug 2026 17:00:00 GMT</pubDate></item>
      <item><title>Safety note</title><link>https://openai.com/index/safety/</link></item>
    </channel></rss>`;
    const dateless = JSON.parse(EXTRACTION_JSON) as { releases: { date: string | null; date_precision: string }[] };
    dateless.releases[0]!.date = null;
    dateless.releases[0]!.date_precision = 'unknown';
    const h = await setup({
      pageFor: (u) => (u.includes('rss.xml') ? rss : u.includes('openai.com/news') ? null : undefined),
      // The teaser page yields no date; the launch post yields the full extraction.
      extractionFor: (chatKey) => (chatKey.includes('gpt-7-teaser') ? JSON.stringify(dateless) : EXTRACTION_JSON),
    });
    const rt = await h.createRt();
    const code = await runBackfillImpl(rt, { lab: 'openai', discoverImpl: fakeDiscovery([discovered({ launch_url: teaser })]) });
    expect(code).toBe(0);
    const out = JSON.parse(readFileSync(join(h.dataDir, 'researched', 'openai.json'), 'utf8')) as LabFile;
    expect(out.releases).toHaveLength(1);
    expect(out.releases[0]?.announcement.url).toBe(launch);
    expect(out.releases[0]?.date).toBe('2026-08-30');
    // Two extractions: the teaser and its single retry.
    expect(h.fetchCalls.filter((c) => c.url.includes('openrouter')).length).toBe(2);
    expect(h.fetchCalls.some((c) => c.url.includes('rss.xml'))).toBe(true);
  });

  test('a dateless extraction the news index cannot place is dropped after one attempt', async () => {
    const dateless = JSON.parse(EXTRACTION_JSON) as { releases: { date: string | null; date_precision: string }[] };
    dateless.releases[0]!.date = null;
    dateless.releases[0]!.date_precision = 'unknown';
    const h = await setup({
      pageFor: (u) => (u.includes('rss.xml') || u.includes('openai.com/news') ? null : undefined),
      extractionFor: () => JSON.stringify(dateless),
    });
    const rt = await h.createRt();
    await runBackfillImpl(rt, { lab: 'openai', discoverImpl: fakeDiscovery([discovered()]) });
    expect(h.fetchCalls.filter((c) => c.url.includes('openrouter')).length).toBe(1);
    const progress = JSON.parse(readFileSync(join(h.stateDir, 'researcher-progress.json'), 'utf8')) as {
      labs: Record<string, { done: string[]; failed: string[] }>;
    };
    expect(progress.labs['openai']?.failed).toEqual(['GPT-7']);
  });

  test('a launch post harvested from a press page is official — released, with its scores', async () => {
    // `official` describes the URL being extracted. A press homepage is an overview page, and
    // collectAnnouncementLinks filters its links to the LAB's hosts, so the post that comes out
    // is official by construction — inheriting the press candidate's `official: false` turned a
    // genuine launch post into a scoreless rumour.
    const launch = 'https://openai.com/index/introducing-gpt-7/';
    const pressHtml =
      `<html><body><h1>AI news</h1><a href="${launch}">OpenAI introduces GPT-7</a>` +
      `<p>${'Reporting on the model industry. '.repeat(30)}</p></body></html>`;
    const h = await setup({
      pageFor: (u) => (u.includes('techcrunch.com') ? pressHtml : u.includes('introducing-gpt-7') ? PAGE_TEXT : undefined),
    });
    const rt = await h.createRt();
    const code = await runBackfillImpl(rt, {
      lab: 'openai',
      discoverImpl: fakeDiscovery([discovered({ launch_url: 'https://techcrunch.com/' })]),
    });
    expect(code).toBe(0);
    const out = JSON.parse(readFileSync(join(h.dataDir, 'researched', 'openai.json'), 'utf8')) as LabFile;
    expect(out.releases).toHaveLength(1);
    expect(out.releases[0]?.status).toBe('released');
    expect(out.releases[0]?.scores).toHaveLength(1);
    expect(out.releases[0]?.announcement.url).toBe(launch);
  });

  test('the news-index date carries a dateless launch post: both extractions give no date', async () => {
    // The retry exists because the first page had no date; if the launch post states none either,
    // the rss pubDate the index carried is the date. Before, it was thrown away and the retry
    // failed on the very condition that triggered it.
    const teaser = 'https://openai.com/index/gpt-7-teaser/';
    const launch = 'https://openai.com/index/introducing-gpt-7/';
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>OpenAI</title>
      <item><title>Introducing GPT-7</title><link>${launch}</link><pubDate>Sun, 30 Aug 2026 17:00:00 GMT</pubDate></item>
    </channel></rss>`;
    const dateless = JSON.parse(EXTRACTION_JSON) as { releases: { date: string | null; date_precision: string }[] };
    dateless.releases[0]!.date = null;
    dateless.releases[0]!.date_precision = 'unknown';
    const h = await setup({
      pageFor: (u) => (u.includes('rss.xml') ? rss : u.includes('openai.com/news') ? null : undefined),
      extractionFor: () => JSON.stringify(dateless), // BOTH extractions are dateless
    });
    const rt = await h.createRt();
    // The candidate itself carries no date either, so nothing but the index can supply one.
    const code = await runBackfillImpl(rt, {
      lab: 'openai',
      discoverImpl: fakeDiscovery([discovered({ launch_url: teaser, date: null })]),
    });
    expect(code).toBe(0);
    const out = JSON.parse(readFileSync(join(h.dataDir, 'researched', 'openai.json'), 'utf8')) as LabFile;
    expect(out.releases).toHaveLength(1);
    expect(out.releases[0]?.date).toBe('2026-08-30');
    expect(out.releases[0]?.date_precision).toBe('day');
    expect(out.releases[0]?.status).toBe('released');
    expect(out.releases[0]?.announcement.url).toBe(launch);
  });

  test('indexDate is strict: an unparseable index date is null, never today', () => {
    expect(indexDate('Sun, 30 Aug 2026 17:00:00 GMT')).toEqual({ date: '2026-08-30', precision: 'day' });
    expect(indexDate('2026-08-30')).toEqual({ date: '2026-08-30', precision: 'day' });
    expect(indexDate('2026-08')).toEqual({ date: '2026-08-01', precision: 'month' });
    expect(indexDate('2026')).toEqual({ date: '2026-01-01', precision: 'year' });
    // A launch date is never guessed: no date, no knownDate.
    expect(indexDate('last spring')).toBeNull();
    expect(indexDate('')).toBeNull();
    expect(indexDate(null)).toBeNull();
    expect(indexDate(undefined)).toBeNull();
  });

  test('a press-host candidate is forced to rumored and carries zero scores', async () => {
    const h = await setup();
    const rt = await h.createRt();
    const press = discovered({ launch_url: 'https://techcrunch.com/2026/08/30/gpt-7-launch/' });
    const code = await runBackfillImpl(rt, { lab: 'openai', discoverImpl: fakeDiscovery([press]) });
    expect(code).toBe(0);
    const out = JSON.parse(readFileSync(join(h.dataDir, 'researched', 'openai.json'), 'utf8')) as LabFile;
    expect(out.releases).toHaveLength(1);
    const rel = out.releases[0]!;
    expect(rel.status).toBe('rumored');
    expect(rel.scores).toHaveLength(0);
    // Progress records success so the press candidate is not retried forever.
    const progress = JSON.parse(readFileSync(join(h.stateDir, 'researcher-progress.json'), 'utf8')) as {
      labs: Record<string, { done: string[]; failed: string[] }>;
    };
    expect(progress.labs['openai']?.done).toEqual(['GPT-7']);
  });
});