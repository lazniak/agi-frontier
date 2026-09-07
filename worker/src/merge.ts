/**
 * Merge validated extractions into `data/models/<lab>.json`.
 *
 * Conservative by construction: statuses only move forward, dates only get more precise,
 * scores are only added (never overwritten), and running the same extraction twice produces
 * a byte-identical file — that idempotence is what makes the hourly loop safe.
 */
import type {
  ChangeEvent,
  DatePrecision,
  ISOTimestamp,
  LabFile,
  ModelRelease,
  ModelTier,
  ReleaseStatus,
  Score,
  Source,
} from '@agi/shared';
import type { NormalisedRelease, NormalisedScore } from './llm';
import { isValidReleaseId, nameKey, releaseId } from './text';

const STATUS_RANK: Record<ReleaseStatus, number> = { cancelled: -1, rumored: 1, announced: 2, released: 3 };
const PRECISION_RANK: Record<DatePrecision, number> = { unknown: 0, year: 1, quarter: 2, month: 3, day: 4 };

export interface MergeContext {
  now: ISOTimestamp;
  /** Page the extraction came from — becomes `announcement.url` / `source.url`. */
  sourceUrl: string;
  sourceTitle?: string;
  /** `r.jina.ai` when the page had to be read through the fallback proxy. */
  via?: string;
  actor?: ChangeEvent['actor'];
  /** Lineup tier of the incoming releases (REDESIGN §3). */
  tier?: ModelRelease['tier'];
  /** Dataset origin of the incoming releases (REDESIGN §6): `researcher` writes `'researcher'`. */
  origin?: ModelRelease['origin'];
}

export interface MergeResult {
  file: LabFile;
  changes: ChangeEvent[];
  /** Human-readable lines for the run log ("dropped", "skipped", "added ..."). */
  notes: string[];
  changed: boolean;
}

export function mergeReleases(file: LabFile, incoming: NormalisedRelease[], ctx: MergeContext): MergeResult {
  const actor = ctx.actor ?? 'worker';
  const releases = file.releases.map(cloneRelease);
  const changes: ChangeEvent[] = [];
  const notes: string[] = [];
  const byName = new Map<string, number>();
  const usedIds = new Set<string>();
  releases.forEach((r, i) => {
    byName.set(nameKey(r.name), i);
    usedIds.add(r.id);
  });

  for (const rel of incoming) {
    const key = nameKey(rel.name);
    if (!key) { notes.push(`skipped "${rel.name}": name has no usable characters`); continue; }
    const existingIndex = byName.get(key);

    if (existingIndex === undefined) {
      const id = uniqueId(file.lab, rel.name, usedIds);
      if (!id) { notes.push(`skipped "${rel.name}": cannot build a valid id`); continue; }
      const created = buildRelease(id, file.lab, rel, ctx);
      // New release: the resolved tier when defined (hint-derived `flagship` is fine here —
      // it matches the unset default and cannot demote anything).
      if (rel.tier) created.tier = rel.tier;
      else if (ctx.tier) created.tier = ctx.tier;
      if (ctx.origin) created.origin = ctx.origin;
      usedIds.add(id);
      byName.set(key, releases.length);
      releases.push(created);
      notes.push(`added ${id} (${rel.status}, ${rel.date}, ${rel.scores.length} score(s))`);
      changes.push(change(ctx.now, actor, file.lab, id, 'release_added', `${rel.name} — ${rel.status} ${rel.date}`, ctx.sourceUrl));
      continue;
    }

    const target = releases[existingIndex];
    if (!target) continue;
    let touched = false;

    // 1. missing scores (benchmark + config not already present)
    const present = new Set(target.scores.map((s) => `${s.benchmark}|${s.config ?? ''}`));
    for (const s of rel.scores) {
      const k = `${s.benchmark}|${s.config ?? ''}`;
      if (present.has(k)) continue;
      present.add(k);
      target.scores.push(buildScore(s, ctx));
      touched = true;
      notes.push(`${target.id}: +score ${s.benchmark} = ${s.value}`);
      changes.push(change(ctx.now, actor, file.lab, target.id, 'score_added', `${s.benchmark} ${s.value}${s.config ? ` (${s.config})` : ''}`, ctx.sourceUrl));
    }

    // 2. status may only move forward, and never onto/off `cancelled`
    if (
      target.status !== 'cancelled' &&
      rel.status !== 'cancelled' &&
      STATUS_RANK[rel.status] > STATUS_RANK[target.status]
    ) {
      const previous = target.status;
      const nextPrecision = betterPrecision(target, rel);
      if (rel.status === 'released' && nextPrecision === 'unknown') {
        notes.push(`${target.id}: status stays ${previous} — released needs a known date precision`);
      } else {
        target.status = rel.status;
        touched = true;
        notes.push(`${target.id}: status ${previous} -> ${rel.status}`);
        changes.push(change(ctx.now, actor, file.lab, target.id, 'status_changed', `${previous} -> ${rel.status}`, ctx.sourceUrl));
      }
    }

    // 3. dates only get more precise
    if (PRECISION_RANK[rel.date_precision] > PRECISION_RANK[target.date_precision]) {
      const previous = `${target.date} (${target.date_precision})`;
      target.date = rel.date;
      target.date_precision = rel.date_precision;
      touched = true;
      notes.push(`${target.id}: date ${previous} -> ${rel.date} (${rel.date_precision})`);
      changes.push(change(ctx.now, actor, file.lab, target.id, 'release_updated', `date ${previous} -> ${rel.date} (${rel.date_precision})`, ctx.sourceUrl));
    }

    // 4. record the page that produced the change as a supporting source
    if (touched && !hasSource(target, ctx.sourceUrl)) {
      target.sources = [...(target.sources ?? []), buildSource(ctx, rel.announcement_quote)];
    }

    // 5. a tier the seed never recorded is filled in once and never flipped afterwards — and
    // only from an EXPLICIT `mid`/`small` extraction. A hint-derived `flagship` must not tag
    // an untiered release (it would be indistinguishable from a real tier), and nothing may
    // demote an existing flagship to `mid`.
    if (!target.tier && (rel.tier === 'mid' || rel.tier === 'small')) {
      target.tier = rel.tier;
      touched = true;
      notes.push(`${target.id}: tier ${rel.tier}`);
      changes.push(change(ctx.now, actor, file.lab, target.id, 'release_updated', `tier ${rel.tier}`, ctx.sourceUrl));
    }
  }

  const changed = changes.length > 0;
  const next: LabFile = {
    lab: file.lab,
    updated_at: changed ? ctx.now : file.updated_at,
    releases,
  };
  return { file: next, changes, notes, changed };
}

function betterPrecision(target: ModelRelease, rel: NormalisedRelease): DatePrecision {
  return PRECISION_RANK[rel.date_precision] > PRECISION_RANK[target.date_precision]
    ? rel.date_precision
    : target.date_precision;
}

function hasSource(rel: ModelRelease, url: string): boolean {
  if (rel.announcement.url === url) return true;
  return (rel.sources ?? []).some((s) => s.url === url);
}

/** `<lab>-<slug>`, deduplicated against `used` with `-2`, `-3`, … suffixes. */
export function uniqueId(lab: string, name: string, used: Set<string>): string | null {
  const base = releaseId(lab, name);
  if (!isValidReleaseId(base)) return null;
  if (!used.has(base)) return base;
  for (let n = 2; n < 20; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate) && isValidReleaseId(candidate)) return candidate;
  }
  return null;
}

function buildSource(ctx: MergeContext, quote: string): Source {
  const source: Record<string, unknown> = { url: ctx.sourceUrl };
  if (ctx.sourceTitle) source['title'] = ctx.sourceTitle;
  source['quote'] = quote;
  source['retrieved_at'] = ctx.now;
  // The quote was checked against the fetched page before we got here.
  source['verified'] = true;
  source['verified_at'] = ctx.now;
  if (ctx.via) source['via'] = ctx.via;
  return source as unknown as Source;
}

function buildScore(s: NormalisedScore, ctx: MergeContext): Score {
  const score: Record<string, unknown> = { benchmark: s.benchmark, value: s.value };
  if (s.config) score['config'] = s.config;
  score['reported_by'] = 'official';
  score['source'] = buildSource(ctx, s.quote);
  return score as unknown as Score;
}

function buildRelease(id: string, lab: LabFile['lab'], rel: NormalisedRelease, ctx: MergeContext): ModelRelease {
  const out: Record<string, unknown> = {
    id,
    lab,
    name: rel.name,
    family: rel.family,
    date: rel.date,
    date_precision: rel.date_precision,
    status: rel.status,
    announcement: buildSource(ctx, rel.announcement_quote),
    scores: rel.scores.map((s) => buildScore(s, ctx)),
  };
  if (rel.notes) out['notes'] = rel.notes;
  return out as unknown as ModelRelease;
}

function cloneRelease(r: ModelRelease): ModelRelease {
  return JSON.parse(JSON.stringify(r)) as ModelRelease;
}

export function change(
  at: ISOTimestamp,
  actor: ChangeEvent['actor'],
  lab: ChangeEvent['lab'],
  release_id: string,
  kind: ChangeEvent['kind'],
  summary: string,
  source_url?: string,
): ChangeEvent {
  const ev: Record<string, unknown> = { at, actor, lab, release_id, kind, summary };
  if (source_url) ev['source_url'] = source_url;
  return ev as unknown as ChangeEvent;
}
