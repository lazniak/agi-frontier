import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeEval,
  datesWithinTolerance,
  formatEvalSummary,
  formatEvalTable,
  matchReleases,
  readCandidateDir,
  releasesMatch,
  scoreTolerance,
  unverifiedExtras,
  type EvalReport,
} from '../src/researcher/eval';
import { RESEARCHER_EVAL_FILE } from '../src/researcher/common';
import type { Benchmark, Lab, ModelRelease, ResearcherEval } from '@agi/shared';

const repoRoot = join(import.meta.dir, '..', '..');
const BENCHMARKS = JSON.parse(readFileSync(join(repoRoot, 'data', 'benchmarks.json'), 'utf8')) as Benchmark[];
const LABS = JSON.parse(readFileSync(join(repoRoot, 'data', 'labs.json'), 'utf8')) as Lab[];
const NOW = '2026-09-07T04:00:00Z';

const release = (over: Partial<ModelRelease> = {}): ModelRelease => ({
  id: 'openai-gpt-6',
  lab: 'openai',
  name: 'GPT-6',
  family: 'GPT',
  date: '2026-05-04',
  date_precision: 'day',
  status: 'released',
  announcement: { url: 'https://openai.com/x', quote: 'q', retrieved_at: NOW, verified: true },
  scores: [
    { benchmark: 'gpqa-diamond', value: 92.4, reported_by: 'official', source: { url: 'https://openai.com/x', quote: '92.4%', retrieved_at: NOW, verified: true } },
    { benchmark: 'lmarena-text', value: 1450, reported_by: 'maintainer', source: { url: 'https://lmarena.ai/x', quote: '1450', retrieved_at: NOW, verified: true } },
  ],
  ...over,
});

describe('matching rules', () => {
  test('dates within 45 days match; beyond do not', () => {
    expect(datesWithinTolerance('2026-05-04', '2026-05-10')).toBe(true);
    expect(datesWithinTolerance('2026-05-04', '2026-06-15')).toBe(true); // 42 days
    expect(datesWithinTolerance('2026-05-04', '2026-06-20')).toBe(false); // 47 days
    expect(datesWithinTolerance('2026-05-04', 'nonsense')).toBe(false);
  });

  test('releases match on canonical name (equal or contained) plus date proximity', () => {
    expect(releasesMatch(release(), release())).toBe(true);
    expect(releasesMatch(release({ name: 'GPT-6' }), release({ name: 'gpt 6', date: '2026-05-20' }))).toBe(true);
    expect(releasesMatch(release(), release({ date: '2026-07-30' }))).toBe(false);
    expect(releasesMatch(release(), release({ name: 'Claude Opus 5' }))).toBe(false);
  });

  test('"Opus 5" matches "Claude Opus 5" by containment while the dates sit within 45 days (T43 item 7)', () => {
    // The first live run's 0/102: the gold set simply had no Claude Opus 5 row — the rule
    // itself matches a bare family member against its full name.
    const gold = release({ id: 'anthropic-claude-opus-5', lab: 'anthropic', name: 'Claude Opus 5', date: '2026-07-24' });
    expect(releasesMatch(gold, release({ id: 'anthropic-opus-5', lab: 'anthropic', name: 'Opus 5', date: '2026-07-24' }))).toBe(true);
    expect(releasesMatch(gold, release({ name: 'Opus 5', date: '2026-09-06' }))).toBe(true); // 44 days
    expect(releasesMatch(gold, release({ name: 'Opus 5', date: '2026-09-08' }))).toBe(false); // 46 days: the window, not the name, fails
  });

  test('score tolerances follow the benchmark unit', () => {
    expect(scoreTolerance({ unit: '%' })).toBe(1.0);
    expect(scoreTolerance({ unit: 'elo' })).toBe(15);
  });

  test('greedy matching pairs each gold release at most once', () => {
    const gold = [release(), release({ id: 'openai-gpt-5', name: 'GPT-5', date: '2025-08-07' })];
    const candidate = [release(), release({ id: 'openai-gpt-5', name: 'GPT-5', date: '2025-08-10' })];
    const { pairs, unmatchedGold, extraFound } = matchReleases(gold, candidate);
    expect(pairs).toHaveLength(2);
    expect(unmatchedGold).toHaveLength(0);
    expect(extraFound).toHaveLength(0);
    // One candidate cannot satisfy two gold releases.
    const single = matchReleases([release(), release({ id: 'x', name: 'GPT-6', date: '2026-05-06' })], [release()]);
    expect(single.pairs).toHaveLength(1);
    expect(single.unmatchedGold).toHaveLength(1);
  });
});

describe('computeEval metrics', () => {
  const gold = [
    {
      lab: 'openai' as const,
      releases: [
        release(),
        release({
          id: 'openai-gpt-5', name: 'GPT-5', date: '2025-08-07',
          scores: [{ benchmark: 'gpqa-diamond', value: 90.0, reported_by: 'official' as const, source: { url: 'u', quote: '90', retrieved_at: NOW } }],
        }),
      ],
    },
    { lab: 'anthropic' as const, releases: [release({ id: 'anthropic-claude-opus-5', name: 'Claude Opus 5', lab: 'anthropic' })] },
  ];
  const candidate = [
    {
      lab: 'openai' as const,
      releases: [
        // Match: within 1 point on both scores.
        release({ scores: [
          { benchmark: 'gpqa-diamond', value: 92.0, reported_by: 'official', source: { url: 'u', quote: '92.0%', retrieved_at: NOW, verified: true } },
          { benchmark: 'lmarena-text', value: 1462, reported_by: 'maintainer', source: { url: 'u', quote: '1462', retrieved_at: NOW, verified: true } },
        ] }),
        // Match on name, but the GPQA value is off by 2 points -> score not matched.
        release({ id: 'openai-gpt-5', name: 'GPT-5', date: '2025-08-10', scores: [
          { benchmark: 'gpqa-diamond', value: 88.0, reported_by: 'official', source: { url: 'u', quote: '88', retrieved_at: NOW, verified: true } },
        ] }),
        // Extra release the gold set never had -> hurts precision.
        release({ id: 'openai-gpt-9', name: 'GPT-9' }),
      ],
    },
    { lab: 'anthropic' as const, releases: [] },
  ];

  const evalResult = computeEval(gold, candidate, BENCHMARKS, NOW);

  test('release precision and recall reflect matches / found / gold', () => {
    expect(evalResult.gold_releases).toBe(3);
    expect(evalResult.found_releases).toBe(3);
    expect(evalResult.matched_releases).toBe(2);
    expect(evalResult.precision_releases).toBeCloseTo(2 / 3, 4);
    expect(evalResult.recall_releases).toBeCloseTo(2 / 3, 4);
  });

  test('score recall honours the per-unit tolerance and MAE averages matched deltas', () => {
    // Gold scores are summed over ALL gold releases (not only matched ones):
    // 2 (GPT-6) + 1 (GPT-5) + 2 (Claude Opus 5, release never matched) = 5.
    // Matched: GPQA |92.0-92.4|=0.4 ✓, lmarena |1462-1450|=12 ≤ 15 ✓, GP5 GPQA |88-90|=2 ✗.
    // One perfectly-matched release can therefore never fake a 1.0 score recall.
    expect(evalResult.gold_scores).toBe(5);
    expect(evalResult.matched_scores).toBe(2);
    expect(evalResult.score_recall).toBeCloseTo(2 / 5, 4);
    expect(evalResult.score_mae).toBeCloseTo((0.4 + 12) / 2, 4);
  });

  test("quote stats come from the candidate's verified flags", () => {
    // Matched candidate releases carry 1 announcement + 2|1 scores, all verified:true.
    expect(evalResult.quotes_total).toBe(1 + 2 + 1 + 1);
    expect(evalResult.quotes_verified).toBe(5);
    expect(evalResult.quote_verified_rate).toBe(1);
  });

  test('the per-lab table separates labs with no gold and no findings', () => {
    expect(evalResult.by_lab['openai']).toEqual({ gold: 2, found: 3, matched: 2, scores_gold: 3, scores_matched: 2 });
    // The Claude release was never found: its 2 gold scores still count against the lab.
    expect(evalResult.by_lab['anthropic']).toEqual({ gold: 1, found: 0, matched: 0, scores_gold: 2, scores_matched: 0 });
    const table = formatEvalTable(evalResult);
    expect(table).toContain('openai');
    expect(table).toContain('anthropic');
    expect(table).toContain('precision');
  });

  test('a candidate-only lab (no gold file) counts its findings and lowers precision', () => {
    const withMistral = [
      ...candidate,
      { lab: 'mistral' as const, releases: [release({ id: 'mistral-large-3', name: 'Mistral Large 3', lab: 'mistral' })] },
    ];
    const r = computeEval(gold, withMistral, BENCHMARKS, NOW);
    expect(r.by_lab['mistral']).toEqual({ gold: 0, found: 1, matched: 0, scores_gold: 0, scores_matched: 0 });
    expect(r.found_releases).toBe(evalResult.found_releases + 1);
    expect(r.precision_releases).toBeLessThan(evalResult.precision_releases);
  });

  test('a perfect candidate passes the promote gates shape', () => {
    const perfect = computeEval(gold, gold.map((g) => ({ ...g })), BENCHMARKS, NOW);
    expect(perfect.recall_releases).toBe(1);
    expect(perfect.precision_releases).toBe(1);
    expect(perfect.score_recall).toBe(1);
    expect(perfect.unverified_extras).toEqual([]);
  });
});

describe('unverified extras (REDESIGN §12.6)', () => {
  const anthropic = LABS.find((l) => l.id === 'anthropic')!;
  const opus5 = release({
    id: 'anthropic-claude-opus-5', lab: 'anthropic', name: 'Claude Opus 5', date: '2026-07-24', scores: [],
    announcement: { url: 'https://www.anthropic.com/news/claude-opus-5', quote: 'q', retrieved_at: NOW, verified: true },
    sources: [{ url: 'https://www.anthropic.com/news/claude-opus-5', quote: 'q', retrieved_at: NOW, verified: true }],
  });
  const pressOnly = release({
    id: 'anthropic-claude-opus-6', lab: 'anthropic', name: 'Claude Opus 6', date: '2026-08-24', status: 'rumored', scores: [],
    announcement: { url: 'https://techcrunch.com/2026/08/24/opus-6/', quote: 'q', retrieved_at: NOW },
    sources: [{ url: 'https://techcrunch.com/2026/08/24/opus-6/', quote: 'q', retrieved_at: NOW }],
  });

  test('unverifiedExtras keeps extras whose first source is on an official host (subdomains included)', () => {
    const docs = release({ ...opus5, id: 'x', sources: [{ url: 'https://docs.anthropic.com/en/docs/models', quote: 'q', retrieved_at: NOW }] });
    const out = unverifiedExtras(anthropic, [opus5, pressOnly, docs]);
    expect(out).toEqual([
      { lab: 'anthropic', name: 'Claude Opus 5', date: '2026-07-24', url: 'https://www.anthropic.com/news/claude-opus-5' },
      { lab: 'anthropic', name: 'Claude Opus 5', date: '2026-07-24', url: 'https://docs.anthropic.com/en/docs/models' },
    ]);
  });

  test('computeEval lists official-host extras, still counts them against precision, and prints them under the table', () => {
    const gold = [{ lab: 'anthropic' as const, releases: [release({ id: 'anthropic-claude-fable-5', lab: 'anthropic', name: 'Claude Fable 5', date: '2026-06-09', scores: [] })] }];
    const candidate = [{ lab: 'anthropic' as const, releases: [opus5, pressOnly] }];
    const r: EvalReport = computeEval(gold, candidate, BENCHMARKS, NOW, LABS);
    expect(r.matched_releases).toBe(0);
    expect(r.found_releases).toBe(2);
    expect(r.precision_releases).toBe(0); // extras never help precision
    expect(r.unverified_extras).toEqual([{ lab: 'anthropic', name: 'Claude Opus 5', date: '2026-07-24', url: 'https://www.anthropic.com/news/claude-opus-5' }]);
    const table = formatEvalTable(r);
    expect(table).toContain('unverified extras (1)');
    expect(table).toContain('anthropic  2026-07-24  Claude Opus 5  https://www.anthropic.com/news/claude-opus-5');
    expect(table).not.toContain('techcrunch');
    // Without labs.json the list is empty rather than wrong.
    expect(computeEval(gold, candidate, BENCHMARKS, NOW).unverified_extras).toEqual([]);
    expect(formatEvalSummary(r, false)).toBe('eval: 0/1 gold matched, precision 0, recall 0, score recall 0, 1 unverified extra → promote NOT MET');
  });
});

describe('runEval', () => {
  test('writes the eval report to the state dir and updates the run state', async () => {
    const { createRuntime } = await import('../src/runtime');
    const { runEval } = await import('../src/researcher/eval');
    const { StateStore } = await import('../src/state');
    const root = mkdtempSync(join(tmpdir(), 'agi-eval-'));
    mkdirSync(join(root, 'data', 'gold'), { recursive: true });
    copyFileSync(join(repoRoot, 'data', 'labs.json'), join(root, 'data', 'labs.json'));
    copyFileSync(join(repoRoot, 'data', 'benchmarks.json'), join(root, 'data', 'benchmarks.json'));
    writeFileSync(join(root, 'data', 'gold', 'openai.json'), JSON.stringify({ lab: 'openai', updated_at: NOW, releases: [release()] }), 'utf8');

    const rt = createRuntime({
      log: { child: () => ({ info() {}, warn() {}, error() {}, debug() {} }) } as never,
      config: {
        dataDir: join(root, 'data'),
        stateDir: join(root, 'state'),
        repoRoot: root,
        researcherVersion: '2.0.0',
        promoteMinRecall: 0.85,
        promoteMinPrecision: 0.95,
        promoteMinScoreRecall: 0.8,
      },
    });
    const code = await runEval(rt, { now: NOW });
    expect(code).toBe(0);

    const written = JSON.parse(readFileSync(join(root, 'state', RESEARCHER_EVAL_FILE), 'utf8')) as ResearcherEval;
    expect(written.gold_releases).toBe(1);
    expect(written.found_releases).toBe(0);
    const run = new StateStore(join(root, 'state')).readRun();
    expect(run.researcher.eval?.matched_releases).toBe(written.matched_releases);
    expect(run.researcher.last_eval_at).toBe(NOW);
    expect(run.researcher.last_backfill_summary).toBe('eval: 0/1 gold matched, precision 0, recall 0, score recall 0 → promote NOT MET');
  });
});

describe('readCandidateDir', () => {
  test('returns empty lists for labs without files and skips malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agi-cand-'));
    writeFileSync(join(dir, 'openai.json'), '{"lab":"openai","releases":[]}', 'utf8');
    writeFileSync(join(dir, 'anthropic.json'), '{broken', 'utf8');
    const out = readCandidateDir(dir);
    const openai = out.find((o) => o.lab === 'openai');
    const anthropic = out.find((o) => o.lab === 'anthropic');
    expect(openai?.releases).toEqual([]);
    expect(anthropic?.releases).toEqual([]);
  });
});
