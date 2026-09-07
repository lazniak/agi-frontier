/**
 * Shared researcher plumbing: where `data/researched` lives, how progress is persisted, and how
 * a run reports its call budget. The researcher never writes outside `data/researched`,
 * `data/models` (arena/promote only), `data/history/changes.jsonl` and `worker/.state`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LabFile, LabId } from '@agi/shared';

export const RESEARCHED_DIR = join('data', 'researched');
export const RESEARCHER_PROGRESS_FILE = 'researcher-progress.json';
export const RESEARCHER_EVAL_FILE = 'researcher-eval.json';

export function researchedDir(dataDir: string, override?: string): string {
  return override ?? join(dataDir, 'researched');
}

export function researchedPath(dataDir: string, lab: LabId, override?: string): string {
  return join(researchedDir(dataDir, override), `${lab}.json`);
}

/** Read a researched lab file; a missing file is an empty one (never created implicitly). */
export function readResearchedFile(path: string): LabFile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LabFile;
  } catch {
    return null;
  }
}

export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- progress / resume */

export interface LabProgress {
  /** Canonical names already carried through to the output file. */
  done: string[];
  /** Names we attempted and failed (bad page, no quotes) — retried on the next run. */
  failed: string[];
}

export interface ResearcherProgress {
  updated_at: string;
  /** lab -> candidate name -> done/failed. */
  labs: Record<string, LabProgress>;
}

export function emptyProgress(): ResearcherProgress {
  return { updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), labs: {} };
}

export function progressPath(stateDir: string): string {
  return join(stateDir, RESEARCHER_PROGRESS_FILE);
}

export function readProgress(stateDir: string): ResearcherProgress {
  return readJsonFile<ResearcherProgress>(progressPath(stateDir)) ?? emptyProgress();
}

export function writeProgress(stateDir: string, progress: ResearcherProgress): void {
  progress.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  writeJsonFile(progressPath(stateDir), progress);
}

export function labProgress(progress: ResearcherProgress, lab: string): LabProgress {
  return progress.labs[lab] ?? { done: [], failed: [] };
}

/* ---------------------------------------------------------------- budget */

export class Budget {
  private remaining: number;

  constructor(readonly max: number) {
    this.remaining = max;
  }

  get exhausted(): boolean {
    return this.remaining <= 0;
  }

  spend(n = 1): void {
    this.remaining = Math.max(0, this.remaining - n);
  }
}
