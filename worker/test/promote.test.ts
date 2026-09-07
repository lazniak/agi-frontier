import { describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkGates, mergeForPromote, runPromote } from '../src/researcher/promote';
import type { ChangeEvent, LabFile, ModelRelease } from '@agi/shared';

const repoRoot = join(import.meta.dir, '..', '..');
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
  ],
  ...over,
});

const file = (lab: LabFile['lab'], releases: ModelRelease[]): LabFile => ({ lab, updated_at: NOW, releases });

describe('checkGates', () => {
  const thresholds = { recall: 0.85, precision: 0.95, scoreRecall: 0.8 };

  test('a strong eval passes all three gates', () => {
    expect(checkGates({ recall_releases: 0.9, precision_releases: 1, score_recall: 0.85 }, thresholds).pass).toBe(true);
  });

  test('each gate can fail independently and reports its own reason', () => {
    const low = checkGates({ recall_releases: 0.5, precision_releases: 0.5, score_recall: 0.2 }, thresholds);
    expect(low.pass).toBe(false);
    expect(low.failures).toHaveLength(3);
    expect(low.failures[0]).toContain('recall_releases');
    expect(low.failures[1]).toContain('precision_releases');
    expect(low.failures[2]).toContain('score_recall');
    const recallOnly = checkGates({ recall_releases: 0.5, precision_releases: 1, score_recall: 1 }, thresholds);
    expect(recallOnly.failures).toHaveLength(1);
  });
});

describe('mergeForPromote (pure core)', () => {
  test('adds a researched release with origin=researcher', () => {
    const published = file('openai', [release({ id: 'openai-gpt-5', name: 'GPT-5' })]);
    const researched = file('openai', [release()]);
    const { file: next, changes, added } = mergeForPromote(published, researched, NOW);
    expect(added).toBe(1);
    expect(next.releases).toHaveLength(2);
    expect(next.releases.find((r) => r.name === 'GPT-6')?.origin).toBe('researcher');
    expect(changes.map((c) => c.kind)).toEqual(['release_added']);
  });

  test('never overwrites a verified score — only missing benchmarks are appended', () => {
    const published = file('openai', [
      release({
        scores: [
          { benchmark: 'gpqa-diamond', value: 91.0, reported_by: 'official', source: { url: 'u', quote: '91', retrieved_at: NOW, verified: true } },
        ],
      }),
    ]);
    const researched = file('openai', [
      release({
        scores: [
          // Same benchmark+config: present in published, never overwritten.
          { benchmark: 'gpqa-diamond', value: 99.9, reported_by: 'official', source: { url: 'r', quote: '99.9', retrieved_at: NOW, verified: true } },
          // Missing benchmark: appended.
          { benchmark: 'swe-bench-verified', value: 84.2, reported_by: 'official', source: { url: 'r', quote: '84.2', retrieved_at: NOW, verified: true } },
        ],
      }),
    ]);
    const { file: next, changes, scoresAdded } = mergeForPromote(published, researched, NOW);
    expect(scoresAdded).toBe(1);
    expect(next.releases[0]?.scores).toHaveLength(2);
    expect(next.releases[0]?.scores.find((s) => s.benchmark === 'gpqa-diamond')?.value).toBe(91.0);
    expect(changes.map((c) => c.kind)).toEqual(['score_added']);
  });

  test('a different config counts as a different score', () => {
    const published = file('openai', [
      release({ scores: [{ benchmark: 'gpqa-diamond', value: 91.0, config: 'no tools', reported_by: 'official', source: { url: 'u', quote: '91', retrieved_at: NOW, verified: true } }] }),
    ]);
    const researched = file('openai', [
      release({ scores: [{ benchmark: 'gpqa-diamond', value: 92.4, reported_by: 'official', source: { url: 'r', quote: '92.4', retrieved_at: NOW, verified: true } }] }),
    ]);
    const { file: next, scoresAdded } = mergeForPromote(published, researched, NOW);
    expect(scoresAdded).toBe(1);
    expect(next.releases[0]?.scores).toHaveLength(2);
  });

  test('nothing in common means no changes and updated_at stays', () => {
    const published = file('openai', [release()]);
    const researched = file('openai', [release()]);
    const { file: next, changes, added, scoresAdded } = mergeForPromote(published, researched, '2026-09-08T00:00:00Z');
    expect(added).toBe(0);
    expect(scoresAdded).toBe(0);
    expect(changes).toHaveLength(0);
    expect(next.updated_at).toBe(NOW);
  });

  test('the input files are not mutated', () => {
    const published = file('openai', [release()]);
    const researched = file('openai', [release({ id: 'openai-gpt-9', name: 'GPT-9' })]);
    const before = JSON.stringify(published);
    mergeForPromote(published, researched, NOW);
    expect(JSON.stringify(published)).toBe(before);
  });
});

describe('runPromote', () => {
  function setup(): { root: string; stateDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'agi-promote-'));
    mkdirSync(join(root, 'data', 'models'), { recursive: true });
    mkdirSync(join(root, 'data', 'gold'), { recursive: true });
    mkdirSync(join(root, 'data', 'researched'), { recursive: true });
    mkdirSync(join(root, 'state'), { recursive: true });
    copyFileSync(join(repoRoot, 'data', 'labs.json'), join(root, 'data', 'labs.json'));
    copyFileSync(join(repoRoot, 'data', 'benchmarks.json'), join(root, 'data', 'benchmarks.json'));
    // `promote` iterates the published lab files — an empty one gives it a target.
    writeFileSync(join(root, 'data', 'models', 'openai.json'), JSON.stringify(file('openai', [])), 'utf8');
    return { root, stateDir: join(root, 'state') };
  }

  function runtime(root: string, stateDir: string) {
    const { createRuntime } = require('../src/runtime') as typeof import('../src/runtime');
    void stateDir;
    return { createRuntime };
  }

  const researcherRelease = () =>
    release({
      id: 'openai-gpt-7',
      name: 'GPT-7',
      scores: [
        { benchmark: 'gpqa-diamond', value: 95.0, reported_by: 'official', source: { url: 'https://openai.com/7', quote: '95', retrieved_at: NOW, verified: true } },
      ],
    });

  test('refuses to promote without an eval on record', async () => {
    const { root, stateDir } = setup();
    const { createRuntime } = runtime(root, stateDir);
    writeFileSync(join(root, 'data', 'researched', 'openai.json'), JSON.stringify(file('openai', [researcherRelease()])), 'utf8');
    const rt = createRuntime({ config: { repoRoot: root, dataDir: join(root, 'data'), stateDir, gitPush: false } });
    expect(await runPromote(rt)).toBe(1);
  });

  test('refuses below the thresholds', async () => {
    const { root, stateDir } = setup();
    const { createRuntime } = runtime(root, stateDir);
    writeFileSync(join(root, 'data', 'researched', 'openai.json'), JSON.stringify(file('openai', [researcherRelease()])), 'utf8');
    const rt = createRuntime({ config: { repoRoot: root, dataDir: join(root, 'data'), stateDir, gitPush: false } });
    const state = rt.state.readRun();
    state.researcher = { ...state.researcher, eval: weakEval };
    rt.state.writeRun(state);
    expect(await runPromote(rt)).toBe(1);
    // Nothing was merged into data/models — the file is still the empty seed.
    const untouched = JSON.parse(readFileSync(join(root, 'data', 'models', 'openai.json'), 'utf8')) as LabFile;
    expect(untouched.releases).toHaveLength(0);
  });

  test('promotes when the gates pass: adds the release with origin=researcher and logs a change', async () => {
    const { root, stateDir } = setup();
    const { createRuntime } = runtime(root, stateDir);
    writeFileSync(join(root, 'data', 'researched', 'openai.json'), JSON.stringify(file('openai', [researcherRelease()])), 'utf8');
    const rt = createRuntime({ config: { repoRoot: root, dataDir: join(root, 'data'), stateDir, gitPush: false } });
    const state = rt.state.readRun();
    state.researcher = { ...state.researcher, eval: goodEval };
    rt.state.writeRun(state);
    expect(await runPromote(rt)).toBe(0);

    const written = JSON.parse(readFileSync(join(root, 'data', 'models', 'openai.json'), 'utf8')) as LabFile;
    const promoted = written.releases.find((r) => r.name === 'GPT-7');
    expect(promoted?.origin).toBe('researcher');
    expect(promoted?.scores).toHaveLength(1);
    // The audit log row exists.
    const changes = readFileSync(join(root, 'data', 'history', 'changes.jsonl'), 'utf8').trim().split('\n');
    expect(changes).toHaveLength(1);
    const event = JSON.parse(changes[0]!) as ChangeEvent;
    expect(event).toMatchObject({ kind: 'release_added', release_id: 'openai-gpt-7', actor: 'worker' });
  });

  test('a second run is a no-op (idempotent)', async () => {
    const { root, stateDir } = setup();
    const { createRuntime } = runtime(root, stateDir);
    writeFileSync(join(root, 'data', 'researched', 'openai.json'), JSON.stringify(file('openai', [researcherRelease()])), 'utf8');
    const rt = createRuntime({ config: { repoRoot: root, dataDir: join(root, 'data'), stateDir, gitPush: false } });
    const state = rt.state.readRun();
    state.researcher = { ...state.researcher, eval: goodEval };
    rt.state.writeRun(state);
    expect(await runPromote(rt)).toBe(0);
    expect(await runPromote(rt)).toBe(0);
    const written = JSON.parse(readFileSync(join(root, 'data', 'models', 'openai.json'), 'utf8')) as LabFile;
    expect(written.releases).toHaveLength(1);
    const changes = readFileSync(join(root, 'data', 'history', 'changes.jsonl'), 'utf8').trim().split('\n');
    expect(changes).toHaveLength(1);
  });

  test('--force bypasses the gates', async () => {
    const { root, stateDir } = setup();
    const { createRuntime } = runtime(root, stateDir);
    writeFileSync(join(root, 'data', 'researched', 'openai.json'), JSON.stringify(file('openai', [researcherRelease()])), 'utf8');
    const rt = createRuntime({ config: { repoRoot: root, dataDir: join(root, 'data'), stateDir, gitPush: false } });
    expect(await runPromote(rt, { force: true })).toBe(0);
    expect(existsSync(join(root, 'data', 'models', 'openai.json'))).toBe(true);
  });

  const weakEval = {
    recall_releases: 0.5, precision_releases: 0.5, score_recall: 0.2,
  };
  const goodEval = {
    recall_releases: 1, precision_releases: 1, score_recall: 1,
  };
});