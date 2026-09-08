import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendChange,
  changesPath,
  formatIssues,
  issuesToString,
  labFilePath,
  readAll,
  readChanges,
  readLabFileAt,
  readOrCreateLabFile,
  writeLabFile,
} from '../src/data-store';
import { z } from 'zod';
import { validateData } from '../src/validate';
import { LabWorkspace } from '../src/pipeline';
import { mergeReleases } from '../src/merge';
import type { NormalisedRelease } from '../src/llm';
import type { ChangeEvent, LabFile } from '@agi/shared';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let dataDir: string;

/** A throwaway `data/` seeded with the real labs.json and benchmarks.json. */
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'agi-data-'));
  mkdirSync(join(dataDir, 'models'), { recursive: true });
  mkdirSync(join(dataDir, 'history'), { recursive: true });
  mkdirSync(join(dataDir, 'public'), { recursive: true });
  copyFileSync(join(repoRoot, 'data', 'labs.json'), join(dataDir, 'labs.json'));
  copyFileSync(join(repoRoot, 'data', 'benchmarks.json'), join(dataDir, 'benchmarks.json'));
  writeFileSync(changesPath(dataDir), '', 'utf8');
});

afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const NOW = '2026-09-07T04:00:00Z';

function incoming(over: Partial<NormalisedRelease> = {}): NormalisedRelease {
  return {
    name: 'GPT-6',
    family: 'GPT',
    status: 'released',
    date: '2026-05-04',
    date_precision: 'day',
    announcement_quote: 'GPT-6 is available today.',
    scores: [{ benchmark: 'gpqa-diamond', value: 92.4, config: 'no tools', quote: '92.4% on GPQA Diamond' }],
    ...over,
  };
}

describe('formatIssues (schema issues verbatim, REDESIGN §12.6)', () => {
  test('a root-level issue reads "<root>: message" — never an empty string', () => {
    const parsed = z.object({ models: z.array(z.string()) }).safeParse([]);
    expect(parsed.success).toBe(false);
    const lines = formatIssues(parsed.success ? [] : parsed.error.issues);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toBe('');
      expect(line).toMatch(/^<root>: .+/);
    }
  });

  test('nested issues carry the dotted path, the limit truncates, and issuesToString joins', () => {
    const parsed = z.object({ models: z.array(z.object({ name: z.string(), url: z.string() })) }).safeParse({ models: [{ name: 1 }] });
    const issues = parsed.success ? [] : parsed.error.issues;
    const lines = formatIssues(issues);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^models\.0\.name: /);
    expect(lines[1]).toMatch(/^models\.0\.url: /);
    expect(formatIssues(issues, 1)).toHaveLength(1);
    expect(issuesToString(issues)).toBe(lines.join('; '));
  });
});

describe('readAll / validateData on a fresh data dir', () => {
  test('reads the contract files and reports no errors', () => {
    const snapshot = readAll(dataDir);
    expect(snapshot.labs).toHaveLength(10);
    expect(snapshot.benchmarks.length).toBeGreaterThan(10);
    expect(snapshot.labFiles).toHaveLength(0);
    expect(validateData(dataDir).errors).toEqual([]);
  });

  test('skips `_`-prefixed template files', () => {
    copyFileSync(join(repoRoot, 'data', 'models', '_example.json'), join(dataDir, 'models', '_example.json'));
    expect(readAll(dataDir).labFiles).toHaveLength(0);
    expect(validateData(dataDir).files).toBe(0);
  });
});

describe('writeLabFile', () => {
  test('writes canonically and reports no-op rewrites', () => {
    const merged = mergeReleases(
      { lab: 'openai', updated_at: NOW, releases: [] },
      [incoming()],
      { now: NOW, sourceUrl: 'https://openai.com/index/gpt-6/' },
    );
    expect(writeLabFile(dataDir, merged.file)).toBe(true);
    expect(writeLabFile(dataDir, merged.file)).toBe(false);

    const text = readFileSync(labFilePath(dataDir, 'openai'), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(readLabFileAt(labFilePath(dataDir, 'openai')).file.releases[0]?.id).toBe('openai-gpt-6');
    expect(validateData(dataDir).errors).toEqual([]);
  });

  test('a missing lab file is created empty rather than failing', () => {
    const loaded = readOrCreateLabFile(dataDir, 'zhipu');
    expect(loaded.raw).toBe('');
    expect(loaded.file.releases).toEqual([]);
  });
});

describe('appendChange', () => {
  const event: ChangeEvent = {
    at: NOW, actor: 'worker', lab: 'openai', release_id: 'openai-gpt-6',
    kind: 'release_added', summary: 'GPT-6 launch', source_url: 'https://openai.com/index/gpt-6/',
  };

  test('appends one JSON object per line and reads it back', () => {
    appendChange(dataDir, event);
    appendChange(dataDir, { ...event, kind: 'verified', summary: '1/1 quotes verified' });
    const lines = readFileSync(changesPath(dataDir), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(event);
    expect(readChanges(dataDir)).toHaveLength(2);
  });

  test('refuses to write a malformed event', () => {
    expect(() => appendChange(dataDir, { ...event, lab: 'nope' } as unknown as ChangeEvent)).toThrow();
  });
});

describe('LabWorkspace', () => {
  test('merge, write, validate, append — the happy path', () => {
    const ws = new LabWorkspace(dataDir, 'openai');
    ws.merge([incoming()], { now: NOW, sourceUrl: 'https://openai.com/index/gpt-6/' });
    const outcome = ws.commit();
    expect(outcome).toEqual({ written: true, restored: false, errors: [] });
    expect(validateData(dataDir).errors).toEqual([]);
    expect(readChanges(dataDir)).toHaveLength(1);
  });

  test('a second identical merge writes nothing and appends nothing', () => {
    const first = new LabWorkspace(dataDir, 'openai');
    first.merge([incoming()], { now: NOW, sourceUrl: 'https://openai.com/index/gpt-6/' });
    first.commit();
    const before = readFileSync(labFilePath(dataDir, 'openai'), 'utf8');

    const second = new LabWorkspace(dataDir, 'openai');
    second.merge([incoming()], { now: '2026-09-08T04:00:00Z', sourceUrl: 'https://openai.com/index/gpt-6/' });
    expect(second.dirty).toBe(false);
    expect(second.commit()).toEqual({ written: false, restored: false, errors: [] });
    expect(readFileSync(labFilePath(dataDir, 'openai'), 'utf8')).toBe(before);
    expect(readChanges(dataDir)).toHaveLength(1);
  });

  test('invalid data is rolled back to the previous bytes and no change is logged', () => {
    const seed = new LabWorkspace(dataDir, 'openai');
    seed.merge([incoming()], { now: NOW, sourceUrl: 'https://openai.com/index/gpt-6/' });
    seed.commit();
    const good = readFileSync(labFilePath(dataDir, 'openai'), 'utf8');

    const bad = new LabWorkspace(dataDir, 'openai');
    bad.merge([incoming({ name: 'GPT-7', scores: [] })], { now: NOW, sourceUrl: 'https://openai.com/index/gpt-7/' });
    // Corrupt the staged file the way a bad extraction would: a release dated in the future.
    const staged = bad.file.releases.find((r) => r.id === 'openai-gpt-7');
    if (staged) staged.date = '2099-01-01';
    const outcome = bad.commit();

    expect(outcome.restored).toBe(true);
    expect(outcome.errors.join(' ')).toContain('released in the future');
    expect(readFileSync(labFilePath(dataDir, 'openai'), 'utf8')).toBe(good);
    expect(readChanges(dataDir)).toHaveLength(1); // the bad run logged nothing
    expect(validateData(dataDir).errors).toEqual([]);
  });
});

describe('validateData cross-file checks', () => {
  function writeRaw(name: string, file: LabFile): void {
    writeFileSync(join(dataDir, 'models', name), JSON.stringify(file, null, 2) + '\n', 'utf8');
  }

  const release = {
    id: 'openai-gpt-6', lab: 'openai' as const, name: 'GPT-6', family: 'GPT',
    date: '2026-05-04', date_precision: 'day' as const, status: 'released' as const,
    announcement: { url: 'https://openai.com/x', quote: 'GPT-6 is available today.', retrieved_at: NOW },
    scores: [],
  };

  test('flags a file whose name does not match its lab', () => {
    writeRaw('gpt.json', { lab: 'openai', updated_at: NOW, releases: [] });
    expect(validateData(dataDir).errors.join(' ')).toContain('file name must be openai.json');
  });

  test('flags the same release id in two files', () => {
    writeRaw('openai.json', { lab: 'openai', updated_at: NOW, releases: [release] });
    // A stray copy: the file-name rule and the cross-file id rule must both fire.
    writeRaw('zz.json', { lab: 'openai', updated_at: NOW, releases: [release] });
    const errors = validateData(dataDir).errors.join(' ');
    expect(errors).toContain('zz.json: release id openai-gpt-6 also defined in openai.json');
    expect(errors).toContain('file name must be openai.json');
  });

  test('flags an unknown benchmark id', () => {
    writeRaw('openai.json', {
      lab: 'openai', updated_at: NOW,
      releases: [{
        ...release,
        scores: [{ benchmark: 'not-a-benchmark', value: 1, reported_by: 'official', source: { url: 'https://openai.com/x', retrieved_at: NOW } }],
      }],
    });
    expect(validateData(dataDir).errors.join(' ')).toContain('unknown benchmark ids: not-a-benchmark');
  });

  test('warns when a score quote does not contain its value', () => {
    writeRaw('openai.json', {
      lab: 'openai', updated_at: NOW,
      releases: [{
        ...release,
        scores: [{
          benchmark: 'gpqa-diamond', value: 92.4, reported_by: 'official',
          source: { url: 'https://openai.com/x', quote: 'state of the art on GPQA', retrieved_at: NOW },
        }],
      }],
    });
    const report = validateData(dataDir);
    expect(report.errors).toEqual([]);
    expect(report.warnings.join(' ')).toContain('quote does not contain the value 92.4');
  });

  test('flags a malformed changes.jsonl row', () => {
    writeFileSync(changesPath(dataDir), '{"not":"an event"}\n', 'utf8');
    expect(validateData(dataDir).errors.length).toBeGreaterThan(0);
  });
});
