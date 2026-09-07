/**
 * The only module that reads and writes `data/`. Everything goes through the shared zod
 * schemas, and lab files are always written through the canonical serialiser.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  BenchmarkSchema,
  ChangeEventSchema,
  LabFileSchema,
  LabSchema,
  type Benchmark,
  type ChangeEvent,
  type Lab,
  type LabFile,
  type LabId,
} from '@agi/shared';
import { stringifyLabFile } from './canonical';
import { isoNow } from './fetcher';

export interface LoadedLabFile {
  /** Absolute path. */
  path: string;
  /** File name, e.g. `openai.json`. */
  name: string;
  file: LabFile;
  /** Exact bytes on disk — used to restore the file when a poll produces invalid data. */
  raw: string;
}

export interface DataSnapshot {
  labs: Lab[];
  benchmarks: Benchmark[];
  labFiles: LoadedLabFile[];
  changes: ChangeEvent[];
}

export function labsPath(dataDir: string): string { return join(dataDir, 'labs.json'); }
export function benchmarksPath(dataDir: string): string { return join(dataDir, 'benchmarks.json'); }
export function modelsDir(dataDir: string): string { return join(dataDir, 'models'); }
export function labFilePath(dataDir: string, lab: LabId): string { return join(modelsDir(dataDir), `${lab}.json`); }
export function changesPath(dataDir: string): string { return join(dataDir, 'history', 'changes.jsonl'); }
export function bundlePath(dataDir: string): string { return join(dataDir, 'public', 'latest.json'); }

export class DataError extends Error {
  constructor(message: string, readonly issues: string[] = []) {
    super(message);
    this.name = 'DataError';
  }
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readLabs(dataDir: string): Lab[] {
  const raw = readJsonFile(labsPath(dataDir));
  if (!Array.isArray(raw)) throw new DataError('labs.json must be an array');
  return raw.map((l, i) => {
    const r = LabSchema.safeParse(l);
    if (!r.success) throw new DataError(`labs.json[${i}]: ${issuesToString(r.error.issues)}`);
    return r.data;
  });
}

export function readBenchmarks(dataDir: string): Benchmark[] {
  const raw = readJsonFile(benchmarksPath(dataDir));
  if (!Array.isArray(raw)) throw new DataError('benchmarks.json must be an array');
  return raw.map((b, i) => {
    const r = BenchmarkSchema.safeParse(b);
    if (!r.success) throw new DataError(`benchmarks.json[${i}]: ${issuesToString(r.error.issues)}`);
    return r.data;
  });
}

/** `data/models/*.json`, skipping `_`-prefixed templates. */
export function listLabFilePaths(dataDir: string): string[] {
  const dir = modelsDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort()
    .map((f) => join(dir, f));
}

export function readLabFileAt(path: string): LoadedLabFile {
  const raw = readFileSync(path, 'utf8');
  const parsed = LabFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new DataError(`${basename(path)}: ${issuesToString(parsed.error.issues)}`);
  // zod's output type differs from the hand-written type only under exactOptionalPropertyTypes.
  return { path, name: basename(path), file: parsed.data as unknown as LabFile, raw };
}

export function readLabFiles(dataDir: string): LoadedLabFile[] {
  return listLabFilePaths(dataDir).map(readLabFileAt);
}

/** Missing lab file = a lab we have not seen a release from yet. */
export function readOrCreateLabFile(dataDir: string, lab: LabId): LoadedLabFile {
  const path = labFilePath(dataDir, lab);
  if (existsSync(path)) return readLabFileAt(path);
  const file: LabFile = { lab, updated_at: isoNow(), releases: [] };
  return { path, name: `${lab}.json`, file, raw: '' };
}

export function readChanges(dataDir: string): ChangeEvent[] {
  const path = changesPath(dataDir);
  if (!existsSync(path)) return [];
  const out: ChangeEvent[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = ChangeEventSchema.safeParse(JSON.parse(trimmed));
      if (parsed.success) out.push(parsed.data as unknown as ChangeEvent);
    } catch {
      /* validate() reports malformed rows; readers skip them */
    }
  }
  return out;
}

export function readAll(dataDir: string): DataSnapshot {
  return {
    labs: readLabs(dataDir),
    benchmarks: readBenchmarks(dataDir),
    labFiles: readLabFiles(dataDir),
    changes: readChanges(dataDir),
  };
}

/** Write a lab file canonically. Returns false when the bytes would not change. */
export function writeLabFile(dataDir: string, file: LabFile): boolean {
  const path = labFilePath(dataDir, file.lab);
  const next = stringifyLabFile(file);
  if (existsSync(path) && readFileSync(path, 'utf8') === next) return false;
  mkdirSync(modelsDir(dataDir), { recursive: true });
  writeFileSync(path, next, 'utf8');
  return true;
}

/** Restore exact bytes after a failed poll. An empty `raw` means the file did not exist. */
export function restoreLabFile(path: string, raw: string): void {
  if (!raw) return;
  writeFileSync(path, raw, 'utf8');
}

export function appendChange(dataDir: string, event: ChangeEvent): void {
  appendChanges(dataDir, [event]);
}

export function appendChanges(dataDir: string, events: ChangeEvent[]): void {
  if (events.length === 0) return;
  const path = changesPath(dataDir);
  mkdirSync(join(dataDir, 'history'), { recursive: true });
  const lines = events.map((e) => {
    const parsed = ChangeEventSchema.safeParse(e);
    if (!parsed.success) throw new DataError(`invalid ChangeEvent: ${issuesToString(parsed.error.issues)}`);
    return JSON.stringify(parsed.data as unknown as ChangeEvent);
  });
  appendFileSync(path, lines.join('\n') + '\n', 'utf8');
}

export function writeBundleFile(dataDir: string, json: string): void {
  mkdirSync(join(dataDir, 'public'), { recursive: true });
  writeFileSync(bundlePath(dataDir), json, 'utf8');
}

export function issuesToString(issues: { path: (string | number)[]; message: string }[]): string {
  return issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
}
