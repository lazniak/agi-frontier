/**
 * The shared "page in, validated releases out" pipeline used by both `poll` and `discover`,
 * plus the per-lab workspace that stages a merge, validates it and rolls it back if the
 * result would be invalid. `data/` is never left failing `validate`.
 */
import type { Benchmark, ChangeEvent, ISODate, Lab, LabFile, LabId, ReleaseStatus } from '@agi/shared';
import {
  appendChanges,
  readOrCreateLabFile,
  restoreLabFile,
  writeLabFile,
  type LoadedLabFile,
} from './data-store';
import { validateData } from './validate';
import type { PageFetch } from './fetcher';
import {
  ExtractionSchema,
  EXTRACTION_JSON_SCHEMA,
  buildSystemPrompt,
  buildUserPrompt,
  validateExtraction,
  type DropInfo,
  type NormalisedRelease,
  type OpenRouterClient,
} from './llm';
import { mergeReleases, type MergeContext } from './merge';
import type { Logger } from './log';

export interface ExtractPageInput {
  client: OpenRouterClient;
  model: string;
  lab: Lab;
  benchmarks: Benchmark[];
  benchmarkIds: Set<string>;
  today: ISODate;
  page: PageFetch;
  pageTitle?: string;
  fallbackDate: ISODate;
  forceStatus?: ReleaseStatus;
  dropScores?: boolean;
  log?: Logger;
}

export interface ExtractPageResult {
  releases: NormalisedRelease[];
  dropped: DropInfo[];
  usedJsonObjectFallback: boolean;
}

/** One LLM call, then every quote re-checked against the page we actually fetched. */
export async function extractFromPage(input: ExtractPageInput): Promise<ExtractPageResult> {
  const promptInput = {
    lab: input.lab,
    today: input.today,
    benchmarks: input.benchmarks,
    pageUrl: input.page.url,
    pageText: input.page.text,
    ...(input.pageTitle ? { pageTitle: input.pageTitle } : {}),
  };
  const result = await input.client.chatJson({
    model: input.model,
    system: buildSystemPrompt(),
    user: buildUserPrompt(promptInput),
    jsonSchema: EXTRACTION_JSON_SCHEMA,
  });
  const parsed = ExtractionSchema.safeParse(result.json);
  if (!parsed.success) {
    input.log?.warn('llm output failed schema validation', {
      lab: input.lab.id,
      url: input.page.url,
      issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
    });
    return { releases: [], dropped: [], usedJsonObjectFallback: result.usedJsonObjectFallback };
  }
  const checked = validateExtraction(parsed.data, {
    pageText: input.page.text,
    benchmarkIds: input.benchmarkIds,
    today: input.today,
    fallbackDate: input.fallbackDate,
    ...(input.forceStatus ? { forceStatus: input.forceStatus } : {}),
    ...(input.dropScores ? { dropScores: input.dropScores } : {}),
  });
  for (const d of checked.dropped) {
    input.log?.warn('dropped unverifiable extraction', {
      lab: input.lab.id,
      url: input.page.url,
      kind: d.kind,
      name: d.name,
      benchmark: d.benchmark,
      reason: d.reason,
    });
  }
  return { ...checked, usedJsonObjectFallback: result.usedJsonObjectFallback };
}

export interface CommitOutcome {
  written: boolean;
  restored: boolean;
  errors: string[];
}

/**
 * Staging area for one lab: merge in memory, write once, validate, roll back on failure.
 * The pre-write bytes are kept so a bad extraction can never corrupt the dataset.
 */
export class LabWorkspace {
  readonly loaded: LoadedLabFile;
  file: LabFile;
  changes: ChangeEvent[] = [];
  notes: string[] = [];

  constructor(private readonly dataDir: string, readonly labId: LabId) {
    this.loaded = readOrCreateLabFile(dataDir, labId);
    this.file = this.loaded.file;
  }

  get dirty(): boolean {
    return this.changes.length > 0;
  }

  merge(releases: NormalisedRelease[], ctx: MergeContext): void {
    if (releases.length === 0) return;
    const result = mergeReleases(this.file, releases, ctx);
    this.file = result.file;
    this.changes.push(...result.changes);
    this.notes.push(...result.notes);
  }

  /** Write + validate + append the audit rows, or restore the previous bytes and report why. */
  commit(log?: Logger): CommitOutcome {
    if (!this.dirty) return { written: false, restored: false, errors: [] };
    const written = writeLabFile(this.dataDir, this.file);
    if (!written) return { written: false, restored: false, errors: [] };

    const report = validateData(this.dataDir);
    if (report.errors.length > 0) {
      restoreLabFile(this.loaded.path, this.loaded.raw);
      log?.error('poll produced invalid data — lab file restored', {
        lab: this.labId,
        errors: report.errors.slice(0, 10),
      });
      this.changes = [];
      return { written: false, restored: true, errors: report.errors };
    }
    appendChanges(this.dataDir, this.changes);
    log?.info('lab file updated', { lab: this.labId, changes: this.changes.length });
    return { written: true, restored: false, errors: [] };
  }
}

/** Hosts we accept as "the lab itself": its website and every polled source, plus subdomains. */
export function officialHosts(lab: Lab): string[] {
  const hosts = new Set<string>();
  const add = (url: string) => {
    try {
      const h = new URL(url).host.toLowerCase();
      hosts.add(h);
      if (h.startsWith('www.')) hosts.add(h.slice(4));
    } catch {
      /* labs.json is schema-validated; unreachable in practice */
    }
  };
  add(lab.website);
  for (const s of lab.sources) add(s.url);
  return [...hosts];
}

export function hostMatches(url: string, hosts: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return false;
  }
  return hosts.some((h) => host === h || host.endsWith('.' + h));
}

/** Publishers whose reporting may create a `rumored` entry (never `released`). */
export const PRESS_ALLOWLIST = [
  'reuters.com',
  'bloomberg.com',
  'theinformation.com',
  'techcrunch.com',
  'cnbc.com',
  'theverge.com',
  'wired.com',
  'ft.com',
  'wsj.com',
  'nytimes.com',
  'axios.com',
  'semafor.com',
];

export function isAllowedPress(url: string): boolean {
  return hostMatches(url, PRESS_ALLOWLIST);
}

export function todayISO(now: Date = new Date()): ISODate {
  return now.toISOString().slice(0, 10);
}

/** Item dates arrive as RFC-822, ISO or nothing; anything unparseable falls back to today. */
export function itemDateOrToday(raw: string | undefined, now: Date = new Date()): ISODate {
  if (raw) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 10);
  }
  return todayISO(now);
}
