import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARENA_BENCHMARK,
  ARENA_CONFIG,
  applyArenaMatches,
  arenaCommitMessage,
  arenaScore,
  formatArenaSummary,
  mapRowToRelease,
  organizationConsistent,
  parseArenaLeaderboard,
  runArena,
  stripOrganisation,
  type ArenaMatch,
  type ArenaRow,
  parseFlattenedLeaderboard,
  isPlainRow,
  stripVariantSuffixes,
} from '../src/researcher/arena';
import type { LabFile, ModelRelease } from '@agi/shared';
import { quoteMatches } from '../src/text';

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'lmarena-text.md');
const fixture = readFileSync(fixturePath, 'utf8');
const liveFixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'lmarena-text-live.txt'), 'utf8');
const directFixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'lmarena-text-direct.txt'), 'utf8');
const NOW = '2026-09-07T04:00:00Z';
const repoRoot = join(import.meta.dir, '..', '..');

describe('parseArenaLeaderboard', () => {
  const rows = parseArenaLeaderboard(fixture);

  test('parses the /text/i section only — legacy snapshot rows are excluded', () => {
    expect(rows.length).toBeGreaterThanOrEqual(20);
    expect(rows.length).toBeLessThanOrEqual(21);
    const first = rows.find((r) => r.model === 'Gemini 3.1 Pro');
    expect(first).toMatchObject({ rank: 1, score: 1493, votes: 41203, organization: 'Google' });
    expect(first?.raw).toContain('1493');
    // Section awareness: the "Legacy snapshot" table must NOT be parsed.
    expect(rows.some((r) => r.model === 'GPT-4')).toBe(false);
    expect(rows.some((r) => r.model === 'Claude 3 Opus')).toBe(false);
    expect(rows.some((r) => r.model === 'Mistral Large')).toBe(false);
  });

  test('skips page chrome, headers and the votes-only rows', () => {
    expect(rows.some((r) => /leaderboard/i.test(r.model))).toBe(false);
    expect(rows.some((r) => /^sign in$/i.test(r.model))).toBe(false);
    for (const r of rows) {
      expect(r.score).toBeGreaterThanOrEqual(200);
      expect(r.score).toBeLessThanOrEqual(2200);
    }
  });

  test('the row line survives as a ≤300-char quote', () => {
    for (const r of rows) {
      expect(r.raw.length).toBeLessThanOrEqual(300);
      expect(r.raw).toContain(String(r.score));
    }
  });

  test('handles a plain-text (non-Markdown) rendering', () => {
    const text = [
      '# Text Leaderboard',
      '',
      '1  Gemini 3 Pro  1485  12034',
      '2  GPT-5.1  1402  33518',
      '',
    ].join('\n');
    const rows = parseArenaLeaderboard(text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ rank: 1, model: 'Gemini 3 Pro', score: 1485, votes: 12034 });
  });

  test('without a /text/i heading, only the FIRST table is parsed', () => {
    const text = [
      '# Vision Leaderboard',
      '',
      '| Rank | Model | Score | Votes |',
      '|:----|:------|------:|------:|',
      '| 1 | Vision-L 9000 | 1500 | 5000 |',
      '',
      '# WebDev Leaderboard',
      '',
      '| Rank | Model | Score | Votes |',
      '|:----|:------|------:|------:|',
      '| 1 | Should-Not-Appear | 1400 | 4000 |',
    ].join('\n');
    const rows = parseArenaLeaderboard(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.model).toBe('Vision-L 9000');
  });

  test('dedupes a model listed twice, keeping the first', () => {
    const text = '| 1 | GPT-5.1 | 1402 | 100 | OpenAI |\n| 2 | GPT-5.1 | 1399 | 100 | OpenAI |';
    expect(parseArenaLeaderboard(text)).toHaveLength(1);
  });

  test('lines without an Elo-sized number produce nothing', () => {
    expect(parseArenaLeaderboard('| Rank | Model | Org |\n| 1 | GPT-5.1 | OpenAI |')).toHaveLength(0);
  });
});

describe('parseArenaLeaderboard — live flattened rendering (r.jina.ai of the React table)', () => {
  const rows = parseArenaLeaderboard(liveFixture);

  test('parses every row block of the text table and stops at the page chrome', () => {
    expect(rows.length).toBeGreaterThanOrEqual(20);
    expect(rows.length).toBeLessThanOrEqual(30);
    expect(rows.map((r) => r.model)).not.toContain('Search the Web');
    expect(rows.map((r) => r.model)).not.toContain('Vision');
  });

  test('rank, slug, org, score and votes come from the right lines', () => {
    const first = rows[0]!;
    expect(first.rank).toBe(1);
    expect(first.model).toBe('claude-fable-5');
    expect(first.organization).toBe('Anthropic');
    expect(first.score).toBe(1507);
    expect(first.votes).toBe(27189);
    // The quote is the block joined by single spaces — whitespace-normalised, it is on the page.
    expect(first.raw).toContain('claude-fable-5 Anthropic · Proprietary 1507 ±5 27,189');
    expect(quoteMatches(liveFixture, first.raw)).toBe(true);
  });

  test('annotated slugs keep their annotation in the row (matching strips it later)', () => {
    expect(rows.some((r) => r.model === 'muse-spark-1.2 (xHigh)')).toBe(true);
  });

  test('the direct HTML rendering (htmlToText, cells split across blank lines) parses the same rows', () => {
    const direct = parseArenaLeaderboard(directFixture);
    expect(direct.length).toBeGreaterThanOrEqual(20);
    expect(direct[0]).toEqual(rows[0]);
    expect(direct.map((r) => r.model).slice(0, 10)).toEqual(rows.map((r) => r.model).slice(0, 10));
    expect(quoteMatches(directFixture, direct[0]!.raw)).toBe(true);
  });

  test('a row without an organisation cell (bare license) still parses', () => {
    const text = [
      'Rank', 'Rank Spread', 'Model', 'Score', 'Votes', 'Price $/M', 'Context',
      '325', '321 330', 'yi-1.5-34b-chat', 'Apache-2.0', '1212 ±5', '24,146', 'N/A',
      '326', '316 332', 'zephyr-orpo-141b', 'Apache 2.0', '1212 ±11', '4,652',
    ].join('\n');
    expect(parseArenaLeaderboard(text).map((r) => [r.model, r.score, r.votes, r.organization])).toEqual([
      ['yi-1.5-34b-chat', 1212, 24146, null],
      ['zephyr-orpo-141b', 1212, 4652, null],
    ]);
  });

  test('the Markdown-table fixture is untouched by the flattened parser', () => {
    expect(parseFlattenedLeaderboard(fixture)).toEqual([]);
  });
});

describe('mapRowToRelease — live slugs', () => {
  const rel = (id: string, name: string, lab: LabFile['lab']) => ({ id, name, lab });
  const releases = [
    rel('anthropic-claude-opus-4.6', 'Claude Opus 4.6', 'anthropic'),
    rel('anthropic-claude-fable-5.1', 'Claude Fable 5.1', 'anthropic'),
    rel('google-gemini-3.1-pro', 'Gemini 3.1 Pro', 'google'),
    rel('meta-muse-spark-1.2', 'Muse Spark 1.2', 'meta'),
    rel('deepseek-v4-pro', 'DeepSeek V4 Pro', 'deepseek'),
    rel('anthropic-claude-sonnet-4.5', 'Claude Sonnet 4.5', 'anthropic'),
  ];
  const row = (model: string): ArenaRow => ({ rank: 1, model, score: 1500, votes: 1000, organization: null, raw: model });

  test('hyphenated slugs match dotted release names', () => {
    expect(mapRowToRelease(row('claude-opus-4-6'), releases)?.id).toBe('anthropic-claude-opus-4.6');
  });

  test('effort, preview, snapshot-date and context suffixes are stripped', () => {
    expect(mapRowToRelease(row('claude-opus-4-6-high'), releases)?.id).toBe('anthropic-claude-opus-4.6');
    expect(mapRowToRelease(row('claude-fable-5.1-max'), releases)?.id).toBe('anthropic-claude-fable-5.1');
    expect(mapRowToRelease(row('gemini-3.1-pro-preview'), releases)?.id).toBe('google-gemini-3.1-pro');
    expect(mapRowToRelease(row('deepseek-v4-pro-high-20260813'), releases)?.id).toBe('deepseek-v4-pro');
    expect(mapRowToRelease(row('claude-sonnet-4-5-20250929-high-32k'), releases)?.id).toBe('anthropic-claude-sonnet-4.5');
    expect(mapRowToRelease(row('muse-spark-1.2 (xHigh)'), releases)?.id).toBe('meta-muse-spark-1.2');
  });

  test('a different model number never matches through the slug path', () => {
    expect(mapRowToRelease(row('claude-opus-4-7-high'), releases)).toBeNull();
    expect(mapRowToRelease(row('gemini-3-pro'), releases)).toBeNull();
  });

  test('isPlainRow tells the bare row from its variants', () => {
    expect(isPlainRow(row('claude-opus-4-6'), 'Claude Opus 4.6')).toBe(true);
    expect(isPlainRow(row('claude-opus-4-6-high'), 'Claude Opus 4.6')).toBe(false);
  });

  test('stripVariantSuffixes is idempotent and leaves plain names alone', () => {
    expect(stripVariantSuffixes('gpt-5.4')).toBe('gpt-5.4');
    expect(stripVariantSuffixes('gpt-5.2-chat-latest-20260210')).toBe('gpt-5.2');
    expect(stripVariantSuffixes(stripVariantSuffixes('glm-5-thinking'))).toBe('glm-5');
  });
});

describe('mapRowToRelease', () => {
  const releases = [
    { id: 'google-gemini-3-pro', name: 'Gemini 3 Pro', lab: 'google' },
    { id: 'openai-gpt-5.1', name: 'GPT-5.1', lab: 'openai' },
    { id: 'anthropic-claude-opus-4.5', name: 'Claude Opus 4.5', lab: 'anthropic' },
    { id: 'meta-llama-4-maverick', name: 'Llama 4 Maverick', lab: 'meta' },
  ] as Pick<ModelRelease, 'id' | 'name' | 'lab'>[];

  const row = (model: string, score = 1400): Parameters<typeof mapRowToRelease>[0] => ({
    rank: 1, model, score, votes: null, organization: null, raw: model,
  });

  test('exact canonical match (case, punctuation, space-insensitive)', () => {
    expect(mapRowToRelease(row('Gemini 3 Pro'), releases)?.id).toBe('google-gemini-3-pro');
    expect(mapRowToRelease(row('gemini 3   pro'), releases)?.id).toBe('google-gemini-3-pro');
    expect(mapRowToRelease(row('GPT-5.1'), releases)?.id).toBe('openai-gpt-5.1');
  });

  test('an org-prefixed or suffixed name still matches after stripping (both sides)', () => {
    expect(stripOrganisation('OpenAI GPT-5.1')).toBe('GPT-5.1');
    expect(stripOrganisation('GPT-5.1 (OpenAI)')).toBe('GPT-5.1');
    expect(mapRowToRelease(row('OpenAI GPT-5.1'), releases)?.id).toBe('openai-gpt-5.1');
    // The reverse direction: row "o3" vs release "OpenAI o3".
    const openaiO3 = [...releases, { id: 'openai-o3', name: 'OpenAI o3', lab: 'openai' }] as typeof releases;
    expect(mapRowToRelease(row('o3'), openaiO3)?.id).toBe('openai-o3');
  });

  test('the documented fuzzy rule: parenthetical annotations, never bare family names', () => {
    // "Gemini 3 Pro (Feb 2026)" loses its annotation and matches exactly.
    expect(mapRowToRelease(row('Gemini 3 Pro (Feb 2026)'), releases)?.id).toBe('google-gemini-3-pro');
    // "Gemini" alone is a bare family name: matching it would guess a version — unmatched.
    expect(mapRowToRelease(row('Gemini'), releases)).toBeNull();
    // "Gemini 3" could mean Pro or Ultra — unmatched, logged, never guessed.
    expect(mapRowToRelease(row('Gemini 3'), releases)).toBeNull();
  });

  test('a stripped key must contain a digit or be ≥ 6 chars — "Large 3", "Plus" never match', () => {
    const mistral = [...releases, { id: 'mistral-mistral-large-3', name: 'Mistral Large 3', lab: 'mistral' }] as typeof releases;
    // "Large 3" is a digit-key but shorter than 6 chars AND a bare version fragment: it must
    // not match anything (conservative). Note: it has a digit but "large3" is 7 chars — this
    // case tests the org-strip path yielding a key that equals no release anyway.
    expect(mapRowToRelease(row('Large 3'), mistral)).toBeNull();
    const plus = [...releases, { id: 'xai-grok-plus', name: 'Grok Plus', lab: 'xai' }] as typeof releases;
    // "Plus" (no digit, 4 chars) is too generic to match "Grok Plus" via any stripped path.
    expect(mapRowToRelease(row('Plus'), plus)).toBeNull();
  });

  test('unknown models stay unmatched', () => {
    expect(mapRowToRelease(row('Mystery Model 9000'), releases)).toBeNull();
  });

  test('organizationConsistent: the org cell must agree with the candidate release lab', () => {
    const labNames = new Map([
      ['google', ['Google', 'Google DeepMind', 'google']],
      ['openai', ['OpenAI', 'openai']],
      ['meta', ['Meta', 'meta']],
    ]);
    const googleRow: ArenaRow = { rank: 1, model: 'Gemini 3 Pro', score: 1485, votes: 12034, organization: 'Google', raw: 'x' };
    expect(organizationConsistent(googleRow, 'google', labNames)).toBe(true);
    // A "Google"-badged row must never be mapped to a release owned by another lab.
    expect(organizationConsistent(googleRow, 'openai', labNames)).toBe(false);
    // Containment either way: "Meta AI" vs "meta".
    const metaRow: ArenaRow = { rank: 2, model: 'Llama 4', score: 1288, votes: null, organization: 'Meta AI', raw: 'y' };
    expect(organizationConsistent(metaRow, 'meta', labNames)).toBe(true);
    // No org cell at all: no constraint.
    const bareRow: ArenaRow = { rank: 3, model: 'm', score: 1200, votes: null, organization: null, raw: 'z' };
    expect(organizationConsistent(bareRow, 'openai', labNames)).toBe(true);
  });
});

describe('applyArenaMatches (idempotent upsert)', () => {
  const release = (over: Partial<ModelRelease> = {}): ModelRelease => ({
    id: 'google-gemini-3-pro',
    lab: 'google',
    name: 'Gemini 3 Pro',
    family: 'Gemini Pro',
    date: '2025-11-18',
    date_precision: 'day',
    status: 'released',
    announcement: { url: 'https://blog.google/x', retrieved_at: NOW },
    scores: [],
    ...over,
  });
  const file = (releases: ModelRelease[]): LabFile => ({ lab: 'google', updated_at: NOW, releases });
  const match = (releaseId: string, score: number, raw = `| 1 | m | ${score} |`): ArenaMatch => ({
    row: { rank: 1, model: 'm', score, votes: null, organization: null, raw },
    releaseId,
    lab: 'google',
    replaced: false,
  });

  test('adds an lmarena-text score with the maintainer provenance', () => {
    const { file: next, changes } = applyArenaMatches(file([release()]), [match('google-gemini-3-pro', 1485)], 'https://lmarena.ai/leaderboard/text', NOW);
    expect(next.releases[0]?.scores).toHaveLength(1);
    const score = next.releases[0]?.scores[0];
    expect(score).toMatchObject({
      benchmark: ARENA_BENCHMARK,
      value: 1485,
      config: ARENA_CONFIG,
      reported_by: 'maintainer',
    });
    expect(score?.source.url).toBe('https://lmarena.ai/leaderboard/text');
    expect(score?.source.quote).toBe('| 1 | m | 1485 |');
    expect(changes.map((c) => c.kind)).toEqual(['score_added']);
  });

  test('re-runs replace the previous arena score instead of duplicating it', () => {
    const once = applyArenaMatches(file([release()]), [match('google-gemini-3-pro', 1485)], 'https://lmarena.ai/x', NOW);
    const twice = applyArenaMatches(once.file, [match('google-gemini-3-pro', 1490)], 'https://lmarena.ai/x', '2026-09-14T00:00:00Z');
    expect(twice.file.releases[0]?.scores).toHaveLength(1);
    expect(twice.file.releases[0]?.scores[0]?.value).toBe(1490);
    expect(twice.changes.map((c) => c.kind)).toEqual(['score_updated']);
  });

  test('other scores are untouched and unchanged files keep updated_at', () => {
    const rel = release({
      scores: [{
        benchmark: 'gpqa-diamond', value: 91.2, reported_by: 'official',
        source: { url: 'https://blog.google/x', quote: '91.2%', retrieved_at: NOW },
      }],
    });
    const before = structuredClone(rel);
    const { file: next, changes } = applyArenaMatches(file([rel]), [match('google-gemini-3-pro', 1485)], 'https://lmarena.ai/x', '2026-09-08T00:00:00Z');
    expect(next.releases[0]?.scores[0]).toEqual(before.scores[0]);
    expect(next.releases[0]?.scores).toHaveLength(2);
    expect(changes).toHaveLength(1);
    // And a run with zero matches writes nothing at all.
    const none = applyArenaMatches(file([rel]), [], 'https://lmarena.ai/x', '2026-09-08T00:00:00Z');
    expect(none.changes).toHaveLength(0);
    expect(none.file.updated_at).toBe(NOW);
  });

  test('arenaScore builds a verified source carrying the raw row line', () => {
    const s = arenaScore({ rank: 3, model: 'GPT-5.1', score: 1402, votes: 33518, organization: 'OpenAI', raw: '| 10 | GPT-5.1 | 1402 | 33518 | OpenAI |' }, 'https://lmarena.ai/leaderboard/text', NOW);
    expect(s.source.verified).toBe(true);
    expect(s.source.quote?.length).toBeLessThanOrEqual(300);
    expect(s.source.quote).toContain('1402');
  });
});

describe('runArena — write-path guards', () => {
  const release = (over: Partial<ModelRelease> = {}): ModelRelease => ({
    id: 'google-gemini-3-pro',
    lab: 'google',
    name: 'Gemini 3 Pro',
    family: 'Gemini Pro',
    date: '2025-11-18',
    date_precision: 'day',
    status: 'released',
    announcement: { url: 'https://blog.google/x', retrieved_at: NOW },
    scores: [],
    ...over,
  });
  const LEADERBOARD = [
    '| Rank | Model | Score | Votes | Organization |',
    '|:----|:------|------:|------:|------|',
    '| 1 | Gemini 3 Pro | 1493 | 41203 | Google |',
    '| 2 | Mystery Model A | 1400 | 9000 | Unknown Lab |',
    '| 3 | Mystery Model B | 1350 | 8000 | Unknown Lab |',
    '| 4 | Mystery Model C | 1300 | 7000 | Unknown Lab |',
    '| 5 | Mystery Model D | 1250 | 6000 | Unknown Lab |',
  ].join('\n');

  async function arenaRt(opts: { modelsReleases: ModelRelease[]; researchedReleases?: ModelRelease[] }) {
    const root = mkdtempSync(join(tmpdir(), 'agi-arena-'));
    const dataDir = join(root, 'data');
    const stateDir = join(root, 'state');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dataDir, 'models'), { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    const { copyFileSync } = await import('node:fs');
    copyFileSync(join(repoRoot, 'data', 'labs.json'), join(dataDir, 'labs.json'));
    copyFileSync(join(repoRoot, 'data', 'benchmarks.json'), join(dataDir, 'benchmarks.json'));
    writeFileSync(join(dataDir, 'models', 'google.json'), JSON.stringify({ lab: 'google', updated_at: NOW, releases: opts.modelsReleases }), 'utf8');
    if (opts.researchedReleases) {
      mkdirSync(join(dataDir, 'researched'), { recursive: true });
      writeFileSync(join(dataDir, 'researched', 'google.json'), JSON.stringify({ lab: 'google', updated_at: NOW, releases: opts.researchedReleases }), 'utf8');
    }
    const writes: string[] = [];
    const { createRuntime } = await import('../src/runtime');
    const rt = createRuntime({
      config: { repoRoot: root, dataDir, stateDir, gitPush: false },
      fetchImpl: (async () => new Response(LEADERBOARD, { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch,
      minHostIntervalMs: 0,
    });
    return { rt, dataDir, writes };
  }

  test('an out-of-range arena score is never written — the lab is skipped with an error', async () => {
    // A broken leaderboard row must not poison the dataset; the MERGED file is
    // range-checked before the write (validating the old bytes was never enough).
    const bad = LEADERBOARD.replace('1493', '99999'); // Elo max in benchmarks.json is 4000
    const { rt, dataDir } = await arenaRt({
      modelsReleases: [release()],
    });
    const { createRuntime } = await import('../src/runtime');
    const root = join(dataDir, '..');
    const rt2 = createRuntime({
      config: { repoRoot: root, dataDir, stateDir: join(root, 'state'), gitPush: false },
      fetchImpl: (async () => new Response(bad, { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch,
      minHostIntervalMs: 0,
    });
    void rt;
    const code = await runArena(rt2, { urls: ['https://lmarena.test/leaderboard/text'] });
    expect(code).toBe(1);
    const onDisk = JSON.parse(readFileSync(join(dataDir, 'models', 'google.json'), 'utf8')) as LabFile;
    expect(onDisk.releases[0]?.scores.some((s) => s.benchmark === ARENA_BENCHMARK)).toBe(false);
  });

  test('a researched-only release gets its arena score written to data/researched/<lab>.json', async () => {
    const { rt, dataDir } = await arenaRt({
      modelsReleases: [],
      researchedReleases: [release({ id: 'google-gemini-3-pro-researched' })],
    });
    const code = await runArena(rt, { urls: ['https://lmarena.test/leaderboard/text'] });
    expect(code).toBe(0);
    const researched = JSON.parse(readFileSync(join(dataDir, 'researched', 'google.json'), 'utf8')) as LabFile;
    const rel = researched.releases.find((r) => r.id === 'google-gemini-3-pro-researched');
    expect(rel?.scores.some((s) => s.benchmark === ARENA_BENCHMARK && s.value === 1493)).toBe(true);
    expect(rel?.scores[0]?.reported_by).toBe('maintainer');
    expect(rel?.scores[0]?.config).toBe(ARENA_CONFIG);
    // The published file stays untouched (the release is not in it).
    const published = JSON.parse(readFileSync(join(dataDir, 'models', 'google.json'), 'utf8')) as LabFile;
    expect(published.releases).toHaveLength(0);
  });

  test('a published release gets its arena score written to data/models/<lab>.json', async () => {
    const { rt, dataDir } = await arenaRt({ modelsReleases: [release()] });
    const code = await runArena(rt, { urls: ['https://lmarena.test/leaderboard/text'] });
    expect(code).toBe(0);
    const published = JSON.parse(readFileSync(join(dataDir, 'models', 'google.json'), 'utf8')) as LabFile;
    expect(published.releases[0]?.scores.some((s) => s.benchmark === ARENA_BENCHMARK && s.value === 1493)).toBe(true);
    expect(existsSync(join(dataDir, 'researched', 'google.json'))).toBe(false);
    // The run leaves a one-line summary for the site's Researcher panel (REDESIGN §12.6).
    const { StateStore } = await import('../src/state');
    const run = new StateStore(join(dataDir, '..', 'state')).readRun();
    expect(run.researcher.last_backfill_summary).toBe('arena: 5 rows, 1 matched, 1 score written to 1 lab file, 4 unmatched');
    expect(run.researcher.last_arena_at).toBeTypeOf('string');
  });

  test('the arena commits under its own subject, never the anonymous "data update"', async () => {
    const { rt, dataDir } = await arenaRt({ modelsReleases: [release()] });
    const root = join(dataDir, '..');
    const { spawnSync } = await import('node:child_process');
    const git = (args: string[]): void => {
      const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'test']);
    git(['add', 'data']);
    git(['commit', '-q', '-m', 'seed']);
    const rtWithPush = { ...rt, config: { ...rt.config, gitPush: true } };
    const code = await runArena(rtWithPush, { urls: ['https://lmarena.test/leaderboard/text'] });
    expect(code).toBe(0);
    // HEAD is the bot commit (the rebase/push failed — no origin — but the commit stays local).
    const head = spawnSync('git', ['show', '--name-only', '--format=%s', 'HEAD'], { cwd: root, encoding: 'utf8' });
    const lines = (head.stdout ?? '').trim().split('\n');
    expect(lines[0]).toBe('data(bot): arena 1 score, 1 lab');
    expect(lines.slice(1).filter(Boolean).sort()).toEqual(['data/history/changes.jsonl', 'data/models/google.json']);
  });

  test('arenaCommitMessage and formatArenaSummary pluralise', () => {
    expect(arenaCommitMessage(12, 5)).toBe('data(bot): arena 12 scores, 5 labs');
    expect(arenaCommitMessage(1, 1)).toBe('data(bot): arena 1 score, 1 lab');
    expect(formatArenaSummary({ rows: 200, matched: 40, scores: 38, labs: 9, unmatched: 160 })).toBe(
      'arena: 200 rows, 40 matched, 38 scores written to 9 lab files, 160 unmatched',
    );
  });
});
