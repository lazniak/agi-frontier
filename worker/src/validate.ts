/**
 * Validation of everything under `data/`: zod schemas plus the cross-file checks the
 * schemas cannot express (unknown benchmark/lab ids, file naming, ids duplicated across files).
 *
 * `poll` runs this after every write and rolls the files back if it fails, so this module
 * must never throw — it collects errors instead.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  BenchmarkSchema,
  ChangeEventSchema,
  LabFileSchema,
  LabSchema,
  findOutOfRangeScores,
  findUnknownBenchmarks,
  type LabFile,
} from '@agi/shared';
import {
  benchmarksPath,
  changesPath,
  issuesToString,
  labsPath,
  listLabFilePaths,
} from './data-store';
import { quoteContainsValue } from './text';

export interface ValidationReport {
  errors: string[];
  warnings: string[];
  files: number;
  releases: number;
  scores: number;
  indexScores: number;
  quotedScores: number;
  verifiedSources: number;
  totalSources: number;
  changes: number;
  labs: number;
  benchmarks: number;
}

export function validateData(dataDir: string, only?: string[]): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (m: string) => errors.push(m);
  const warn = (m: string) => warnings.push(m);
  const report: ValidationReport = {
    errors, warnings, files: 0, releases: 0, scores: 0, indexScores: 0,
    quotedScores: 0, verifiedSources: 0, totalSources: 0, changes: 0, labs: 0, benchmarks: 0,
  };

  const labIds = new Set<string>();
  const labs: unknown[] = readJsonArray(labsPath(dataDir), 'labs.json', err);
  for (const [i, l] of labs.entries()) {
    const r = LabSchema.safeParse(l);
    if (!r.success) { err(`labs.json[${i}]: ${issuesToString(r.error.issues)}`); continue; }
    if (labIds.has(r.data.id)) err(`labs.json: duplicate lab id ${r.data.id}`);
    labIds.add(r.data.id);
    for (const hint of r.data.flagship_hints) {
      try { new RegExp(hint); } catch { err(`labs.json ${r.data.id}: invalid flagship_hint regex ${JSON.stringify(hint)}`); }
    }
  }
  report.labs = labIds.size;

  const bmIds = new Set<string>();
  const indexBms = new Set<string>();
  const benchmarksRaw: unknown[] = readJsonArray(benchmarksPath(dataDir), 'benchmarks.json', err);
  const benchmarkRanges: { id: string; min: number; max: number }[] = [];
  for (const [i, b] of benchmarksRaw.entries()) {
    const r = BenchmarkSchema.safeParse(b);
    if (!r.success) { err(`benchmarks.json[${i}]: ${issuesToString(r.error.issues)}`); continue; }
    if (bmIds.has(r.data.id)) err(`benchmarks.json: duplicate benchmark id ${r.data.id}`);
    bmIds.add(r.data.id);
    if (r.data.in_index) indexBms.add(r.data.id);
    benchmarkRanges.push({ id: r.data.id, min: r.data.min, max: r.data.max });
  }
  report.benchmarks = bmIds.size;

  const today = new Date().toISOString().slice(0, 10);
  const seenReleaseIds = new Map<string, string>();
  const knownReleaseIds = new Set<string>();
  const paths = listLabFilePaths(dataDir).filter((p) => !only || only.includes(basename(p)));

  for (const path of paths) {
    const name = basename(path);
    report.files++;
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      err(`${name}: invalid JSON (${(e as Error).message})`);
      continue;
    }
    const parsed = LabFileSchema.safeParse(json);
    if (!parsed.success) {
      for (const i of parsed.error.issues) err(`${name} ${i.path.join('.')}: ${i.message}`);
      continue;
    }
    const file = parsed.data as unknown as LabFile;
    if (!labIds.has(file.lab)) err(`${name}: unknown lab ${file.lab}`);
    if (name !== `${file.lab}.json`) err(`${name}: file name must be ${file.lab}.json`);

    const unknown = findUnknownBenchmarks(file.releases, bmIds);
    if (unknown.length) err(`${name}: unknown benchmark ids: ${unknown.join(', ')}`);

    for (const oor of findOutOfRangeScores(file.releases, benchmarkRanges)) {
      err(`${name} ${oor.release_id} ${oor.benchmark}: value ${oor.value} outside the benchmark range`);
    }

    for (const rel of file.releases) {
      report.releases++;
      knownReleaseIds.add(rel.id);
      const prev = seenReleaseIds.get(rel.id);
      if (prev && prev !== name) err(`${name}: release id ${rel.id} also defined in ${prev}`);
      seenReleaseIds.set(rel.id, name);

      if (rel.status === 'released' && rel.scores.length === 0) warn(`${name} ${rel.id}: released model with no scores`);
      if (!rel.announcement.quote) warn(`${name} ${rel.id}: announcement has no quote`);
      if (rel.status === 'released' && rel.date > today) err(`${name} ${rel.id}: released in the future (${rel.date})`);
      if (rel.expected_window && rel.expected_window.start > rel.expected_window.end) {
        err(`${name} ${rel.id}: expected_window start after end`);
      }

      for (const source of releaseSources(rel)) {
        report.totalSources++;
        if (source.verified) report.verifiedSources++;
      }

      for (const s of rel.scores) {
        report.scores++;
        if (indexBms.has(s.benchmark)) report.indexScores++;
        if (!s.source.quote) {
          warn(`${name} ${rel.id} ${s.benchmark}: score without quote`);
          continue;
        }
        report.quotedScores++;
        if (!quoteContainsValue(s.source.quote, s.value)) {
          warn(`${name} ${rel.id} ${s.benchmark}: quote does not contain the value ${s.value}`);
        }
      }
    }
  }

  const cpath = changesPath(dataDir);
  if (existsSync(cpath)) {
    const lines = readFileSync(cpath, 'utf8').split('\n');
    for (const [i, line] of lines.entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      report.changes++;
      let row: unknown;
      try {
        row = JSON.parse(trimmed);
      } catch {
        err(`changes.jsonl:${i + 1}: invalid JSON`);
        continue;
      }
      const parsed = ChangeEventSchema.safeParse(row);
      if (!parsed.success) { err(`changes.jsonl:${i + 1}: ${issuesToString(parsed.error.issues)}`); continue; }
      if (!labIds.has(parsed.data.lab)) err(`changes.jsonl:${i + 1}: unknown lab ${parsed.data.lab}`);
      if (paths.length && !only && !knownReleaseIds.has(parsed.data.release_id)) {
        warn(`changes.jsonl:${i + 1}: release_id ${parsed.data.release_id} not found in data/models`);
      }
    }
  }

  return report;
}

function releaseSources(rel: LabFile['releases'][number]) {
  const out = [rel.announcement, ...(rel.sources ?? []), ...rel.scores.map((s) => s.source)];
  if (rel.expected_window) out.push(rel.expected_window.source);
  return out;
}

function readJsonArray(path: string, label: string, err: (m: string) => void): unknown[] {
  if (!existsSync(path)) { err(`${label}: missing`); return []; }
  try {
    const json: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(json)) { err(`${label}: must be an array`); return []; }
    return json;
  } catch (e) {
    err(`${label}: invalid JSON (${(e as Error).message})`);
    return [];
  }
}

export function formatReport(r: ValidationReport): string {
  return [
    `files=${r.files} labs=${r.labs} benchmarks=${r.benchmarks} releases=${r.releases}`,
    `scores=${r.scores} (index=${r.indexScores}, quoted=${r.quotedScores})`,
    `sources=${r.totalSources} (verified=${r.verifiedSources}) changes=${r.changes}`,
    `errors=${r.errors.length} warnings=${r.warnings.length}`,
  ].join(' | ');
}
