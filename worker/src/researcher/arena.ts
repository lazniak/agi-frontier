/**
 * The weekly LMArena step: fetch the text leaderboard, parse its rows, map each row to a
 * release in `data/models` (or `data/researched`) by canonical name, and upsert one
 * `lmarena-text` score per matched release (`reported_by: 'maintainer'`, the row line as the
 * quote). Re-running replaces the previous Arena score — idempotent by construction.
 * Unmatched rows are logged, never guessed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChangeEvent, ISOTimestamp, LabFile, ModelRelease, Score, Source } from '@agi/shared';
import { LabFileSchema, findOutOfRangeScores } from '@agi/shared';
import { appendChanges, readBenchmarks, readLabFiles, readLabs, writeLabFile, issuesToString } from '../data-store';
import { isoNow } from '../fetcher';
import { print } from '../log';
import { change } from '../merge';
import { nameKey } from '../text';
import { stringifyLabFile } from '../canonical';
import type { Runtime } from '../runtime';
import { readResearchedFile, researchedPath } from './common';

export const ARENA_BENCHMARK = 'lmarena-text';
export const ARENA_CONFIG = 'text, style control';
export const ARENA_TITLE = 'LMArena text leaderboard';

/** One parsed leaderboard row. */
export interface ArenaRow {
  rank: number | null;
  model: string;
  score: number;
  votes: number | null;
  organization: string | null;
  /** The raw line the row was parsed from — becomes the score's verbatim quote. */
  raw: string;
}

/**
 * Parse an LMArena leaderboard rendering (Markdown from r.jina.ai or plain text) into rows.
 *
 * Accepted shapes per line, rank and votes optional:
 *   `1 | Gemini 3 Pro | 1485 | 12034 | Google`
 *   `1  Gemini 3 Pro  1485  12034`
 *   `| 1 | Gemini 3 Pro | 1485 | 12034 | Google |` (Markdown table row)
 *   `- **Gemini 3 Pro** — 1485 (12034 votes)` (prose list)
 */
export function parseArenaLeaderboard(text: string): ArenaRow[] {
  // The live lmarena.ai page is a React table that r.jina.ai flattens into line blocks — no
  // Markdown table at all. Try that shape first; it never triggers on a table rendering.
  const flat = parseFlattenedLeaderboard(text);
  if (flat.length > 0) return flat;

  const rows: ArenaRow[] = [];
  const seen = new Set<string>();

  // Section awareness: combined leaderboard pages render several tables (text, vision, webdev,
  // legacy snapshots). Parse only the first table under a /text/i heading; when no such heading
  // exists, take the first table only.
  const sections = extractTextSection(text);

  for (const section of sections) {
    for (const rawLine of section.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || /^\+[-+]+\+$/.test(line)) continue;
      // Only table rows (and plain-text rows with ≥2-space or tab separated columns).
      if (!line.startsWith('|') && !/\s{2,}|\t/.test(line)) continue;
      const cells = splitCells(line);
      if (cells.length < 2) continue;

      // Rank must be the first purely numeric cell (or absent); model the first non-numeric one.
      let idx = 0;
      let rank: number | null = null;
      const first = Number.parseFloat(stripDecor(cells[idx] ?? ''));
      if (Number.isFinite(first) && first >= 1 && first <= 500 && Number.isInteger(first)) {
        rank = first;
        idx++;
      }
      const model = stripDecor(cells[idx] ?? '');
      idx++;
      if (!model || model.length > 80) continue;
      // Reject page chrome ("Leaderboard", "Vote", nav labels) and separator/header rows.
      if (/^(leaderboard|vote|about|blog|docs?|home|search|login|sign|menu|expand|pin|archive|compare|arena|battle|rank|model|score|votes|organization|organisation|org)$/i.test(model)) continue;
      if (/^:?-{2,}:?$/.test((cells[idx] ?? '').trim())) continue;

      const rest = cells.slice(idx).map((c) => stripDecor(c));
      const numbers = rest
        .map((c) => ({ raw: c, num: Number.parseFloat(c.replace(/,/g, '')) }))
        .filter((c) => Number.isFinite(c.num));
      if (numbers.length === 0) continue;
      // Elo scores on LMArena sit between 200 and 2200; votes are bigger or absent.
      const scoreCandidate = numbers.find((c) => c.num >= 200 && c.num <= 2200);
      if (!scoreCandidate) continue;
      const votesCandidate = numbers
        .filter((c) => c !== scoreCandidate && c.num >= 1000)
        .map((c) => c.num)
        .at(-1);

      const key = nameKey(model);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        rank,
        model,
        score: scoreCandidate.num,
        votes: votesCandidate ?? null,
        organization: organizationFrom(cells.slice(idx), scoreCandidate.num),
        raw: line.slice(0, 300),
      });
    }
  }
  return rows;
}

/**
 * The live lmarena.ai leaderboard (2026) is a React table; r.jina.ai flattens each row into a
 * block of lines separated by blank lines (tab-only lines inside a block):
 *
 *   1 / 1 / 6 / claude-fable-5 / Anthropic · Proprietary / 1507 / ±5 / 27,189  $10 / $50  1M
 *   rank / rank-spread low / high / model slug / "Org · License" / score / ±ci / votes price ctx
 *
 * Detected by the header sequence Rank → (Rank Spread) → Model → Score → Votes. Blocks are
 * parsed from there until three non-row blocks in a row (the page chrome after the table),
 * which also stops a second table from leaking in. The quote is the block's lines joined by a
 * single space: `quoteMatches` normalises whitespace, so `verify` finds it on the page again.
 */
export function parseFlattenedLeaderboard(text: string): ArenaRow[] {
  const norm = text.replace(/\r/g, '');
  const headerAt = norm.search(
    /^Rank\n(?:[ \t]*\n)*(?:Rank Spread\n(?:[ \t]*\n)*)?Model\n(?:[ \t]*\n)*Score\n(?:[ \t]*\n)*Votes\n/m,
  );
  if (headerAt < 0) return [];
  const blocks = norm.slice(headerAt).split(/\n(?:[ ]*\n)+/);
  const rows: ArenaRow[] = [];
  const seen = new Set<string>();
  let started = false;
  let misses = 0;
  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((l) => l.replace(/\t/g, ' ').trim())
      .filter(Boolean);
    const row = flattenedRow(lines);
    if (!row) {
      if (started && ++misses >= 3) break;
      continue;
    }
    started = true;
    misses = 0;
    const key = nameKey(row.model);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

function flattenedRow(lines: string[]): ArenaRow | null {
  if (lines.length < 4) return null;
  const rankLine = lines[0] ?? '';
  if (!/^\d{1,4}$/.test(rankLine)) return null;
  const rank = Number(rankLine);
  if (rank < 1 || rank > 1000) return null;
  // The model slug is the first line with a letter after the rank-spread numbers.
  const modelIdx = lines.findIndex((l, i) => i > 0 && /[a-z]/i.test(l) && !l.startsWith('±'));
  if (modelIdx < 0) return null;
  const model = lines[modelIdx] ?? '';
  if (!model || model.length > 80) return null;
  let organization: string | null = null;
  let next = modelIdx + 1;
  const orgLine = lines[next] ?? '';
  if (orgLine.includes('·')) {
    organization = orgLine.split('·')[0]?.trim() || null;
    next++;
  }
  const rest = lines.slice(next);
  const scoreLine = rest.find((l) => /^\d{3,4}$/.test(l) && Number(l) >= 200 && Number(l) <= 2200);
  if (!scoreLine) return null;
  const score = Number(scoreLine);
  let votes: number | null = null;
  for (const l of rest) {
    for (const tok of l.split(/\s+/)) {
      if (!/^\d{1,3}(?:,\d{3})+$|^\d{4,}$/.test(tok)) continue;
      const v = Number(tok.replace(/,/g, ''));
      if (v >= 1000 && v !== score) {
        votes = v;
        break;
      }
    }
    if (votes !== null) break;
  }
  return { rank, model, score, votes, organization, raw: lines.join(' ').slice(0, 300) };
}

/**
 * Reduce a leaderboard rendering to the section worth parsing: the first table under a
 * heading matching /text/i (case-insensitive), stopping at the next `#` heading; when no such
 * heading exists, the first table of the document only (header + separator + data rows).
 */
function extractTextSection(text: string): string[] {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!/^#{1,6}\s/.test(line.trim()) || !/text/i.test(line)) continue;
    const section: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] ?? '';
      if (/^#{1,6}\s/.test(l.trim())) break;
      section.push(l);
    }
    return [section.join('\n')];
  }
  // No /text/i heading: take the first table only — from the first table line until the
  // first non-table line after it.
  const table: string[] = [];
  let started = false;
  let ended = false;
  for (const l of lines) {
    const t = l.trim();
    const isTableLine = t.startsWith('|') || /^\+[-+]+\+$/.test(t);
    if (!started && isTableLine) started = true;
    if (!started) continue;
    if (isTableLine) table.push(l);
    else ended = true;
    if (ended) break;
  }
  return [table.join('\n')];
}

function splitCells(line: string): string[] {
  const cleaned = line.replace(/^[-|>\s*#]+/, '').replace(/[|\s]+$/, '');
  if (line.includes('|')) return cleaned.split('|').map((c) => c.trim());
  return cleaned.split(/\s{2,}|\s+[-–—]\s+|\t+/).map((c) => c.trim());
}

function stripDecor(cell: string): string {
  return cell
    .replace(/\*\*/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[\s'"`*_]+|[\s'"`*_]+$/g, '')
    .trim();
}

function organizationFrom(cells: string[], score: number): string | null {
  // The organisation, when present, is the last non-numeric cell after the score.
  const after = cells.filter((c) => {
    const n = Number.parseFloat(c.replace(/,/g, ''));
    return !Number.isFinite(n) || Math.abs(n - score) > 0.001;
  });
  const last = after.at(-1)?.trim();
  return last && /[a-z]/i.test(last) && !/^\d/.test(last) ? last : null;
}

/* ------------------------------------------------------------ name mapping */

/**
 * Map a leaderboard model name to a release. The documented conservative rule:
 *   1. exact canonical match (case/space/punctuation-insensitive);
 *   2. the same after `stripOrganisation` applied to BOTH sides ("OpenAI o3" ↔ "o3");
 *   3. the same after additionally dropping parenthetical annotations ("Gemini 3 Pro (Feb 2026)").
 * A stripped key must contain a digit or be at least 6 characters long — "Large 3", "Plus",
 * "V3" alone are too generic to match. Anything else — bare family names ("Gemini"), version
 * variants ("Gemini 3" vs "Gemini 3 Pro") — stays unmatched and is logged, never guessed.
 */
export function mapRowToRelease(
  row: ArenaRow,
  releases: Pick<ModelRelease, 'id' | 'name' | 'lab'>[],
): Pick<ModelRelease, 'id' | 'name' | 'lab'> | null {
  const key = nameKey(row.model);
  if (!key) return null;
  const exact = releases.find((r) => nameKey(r.name) === key);
  if (exact) return exact;

  // "OpenAI: GPT-5.1" / "GPT-5.1 (OpenAI)" / "OpenAI o3" ↔ "o3" style variants: strip org
  // names on BOTH sides, and only accept keys specific enough (digit inside, or ≥ 6 chars).
  const strippedKey = nameKey(stripOrganisation(row.model));
  // Row stripped ("OpenAI o3" -> "o3") matching a plain release name …
  if (strippedKey && strippedKey !== key && keyIsSpecific(strippedKey)) {
    const alt = releases.find((r) => nameKey(r.name) === strippedKey);
    if (alt) return alt;
  }
  // … or row plain name matching a release whose org prefix strips off ("o3" vs "OpenAI o3").
  // The release side uses the CONSERVATIVE strip: only unambiguous org labels ("Mistral AI",
  // "Meta AI") — never a bare family name — so "Large 3" cannot match "Mistral Large 3".
  const releaseStripped = releases.find((r) => {
    const rs = nameKey(stripReleaseOrganisation(r.name));
    return rs && rs !== nameKey(r.name) && keyIsSpecific(rs) && rs === key;
  });
  if (releaseStripped) return releaseStripped;

  // "(Feb 2026)" / "(06/10)" annotations: drop everything in parentheses and retry.
  const unannotated = nameKey(stripOrganisation(row.model).replace(/\([^)]*\)/g, ' '));
  if (unannotated && unannotated !== strippedKey && keyIsSpecific(unannotated)) {
    const alt = releases.find((r) => nameKey(r.name) === unannotated);
    if (alt) return alt;
  }

  // Live slugs carry effort / snapshot suffixes ("claude-opus-4-6-high", "gemini-3.1-pro-preview",
  // "deepseek-v4-pro-high-20260813", "gemini-3-flash (thinking-minimal)") and write "4.6" as
  // "4-6": drop annotations, dates and trailing variant tokens, compare dot-insensitively, and
  // still require a specific key. runArena keeps one row per release — the plain-name row when
  // the page has one, else the best-ranked variant — so this never double-counts.
  for (const base of [row.model, stripOrganisation(row.model)]) {
    const plain = slugKey(stripVariantSuffixes(base));
    if (!plain || !keyIsSpecific(plain)) continue;
    const alt = releases.find((r) => slugKey(r.name) === plain);
    if (alt) return alt;
  }
  return null;
}

/** Name key with dots removed too: "claude-opus-4-6" and "Claude Opus 4.6" agree. */
function slugKey(name: string): string {
  return nameKey(name).replace(/\./g, '');
}

/** True when the row names the release plainly (no effort / snapshot suffix). */
export function isPlainRow(row: ArenaRow, releaseName: string): boolean {
  const target = slugKey(releaseName);
  return [row.model, stripOrganisation(row.model)].some(
    (m) => slugKey(m.replace(/\([^)]*\)/g, ' ')) === target,
  );
}

/**
 * Strip what a leaderboard slug adds on top of the model name: parenthetical annotations,
 * YYYYMMDD / YYYY-MM-DD snapshot dates, and trailing effort / mode tokens (repeatedly).
 */
export function stripVariantSuffixes(model: string): string {
  let s = model.replace(/\([^)]*\)/g, ' ').trim();
  s = s.replace(/[-_ ]?\b(?:20\d{6}|20\d{2}-\d{2}-\d{2})\b/g, ' ').trim();
  const variant = /[-_ ](?:high|xhigh|max|low|medium|minimal|thinking|reasoning|preview|latest|exp|chat|instruct|\d{1,3}k)$/i;
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(variant, '').trim();
  }
  return s.replace(/\s{2,}/g, ' ').trim();
}

/** A name key may match only when it is specific enough: has a digit or is ≥ 6 chars. */
function keyIsSpecific(key: string): boolean {
  return /\d/.test(key) || key.length >= 6;
}

/**
 * The row's `organization` cell, when present, must agree with the candidate release's lab
 * (compare against the lab's name/short/id, case-insensitive, containment either way).
 * `releasesByLab` maps lab id -> display names; a release whose lab disagrees is not a match.
 */
export function organizationConsistent(
  row: ArenaRow,
  labId: LabFile['lab'],
  labNames: Map<LabFile['lab'], string[]>,
): boolean {
  if (!row.organization) return true;
  const names = labNames.get(labId) ?? [];
  const org = row.organization.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!org) return true;
  return names.some((n) => {
    const ln = n.toLowerCase().replace(/[^a-z0-9]/g, '');
    return ln.includes(org) || org.includes(ln);
  });
}

/** Drop a leading/trailing org label ("OpenAI/GPT-5.1", "GPT-5.1 (OpenAI)") before matching. */
export function stripOrganisation(model: string): string {
  const orgWords =
    /^(openai|anthropic|google( deepmind)?|deepmind|meta ai|meta|xai|meta llama|deepseek(?: ai)?|alibaba(?: qwen)?|qwen(?: team)?|moonshot ai|moonshot|z\.? ?ai|zhipu ai|zhipu|mistral(?: ai)?|thudm)\b[:\s-]*/i;
  let out = model.replace(/\s*\((?:openai|anthropic|google|deepmind|meta|xai|deepseek|alibaba|qwen|moonshot|zhipu|z\.?ai|mistral)(?: ai)?\)\s*$/i, ' ');
  out = out.replace(orgWords, ' ');
  return out.trim().replace(/\s{2,}/g, ' ');
}

/**
 * Conservative variant used on the RELEASE side: only unambiguous org labels (with the "AI"
 * suffix where a bare word would collide with a family name — "Mistral Large 3" must NOT
 * reduce to "Large 3", but "Mistral AI Mistral Large 3" still strips).
 */
export function stripReleaseOrganisation(model: string): string {
  const orgWords =
    /^(openai|anthropic|google( deepmind)?|deepmind|meta ai|xai|meta llama|deepseek ai|alibaba qwen|moonshot ai|z\.? ?ai|zhipu ai|mistral ai|thudm)\b[:\s-]*/i;
  const out = model.replace(orgWords, ' ');
  return out.trim().replace(/\s{2,}/g, ' ');
}

/* ------------------------------------------------------------ score upsert */

export interface ArenaMatch {
  row: ArenaRow;
  releaseId: string;
  lab: LabFile['lab'];
  /** True when the release already carried an Arena score (this run replaces it). */
  replaced: boolean;
}

export interface ArenaApplyResult {
  matches: ArenaMatch[];
  unmatched: ArenaRow[];
  changes: ChangeEvent[];
}

/** Build the `lmarena-text` score for a row. */
export function arenaScore(row: ArenaRow, url: string, now: ISOTimestamp): Score {
  const source: Source = {
    url,
    title: ARENA_TITLE,
    quote: row.raw,
    retrieved_at: now,
    verified: true,
    verified_at: now,
  };
  return {
    benchmark: ARENA_BENCHMARK,
    value: row.score,
    config: ARENA_CONFIG,
    reported_by: 'maintainer',
    source,
  };
}

/** Pure core of `arena`: apply matches to a lab file, returning the next file + change rows. */
export function applyArenaMatches(
  file: LabFile,
  matches: ArenaMatch[],
  url: string,
  now: ISOTimestamp,
): { file: LabFile; changes: ChangeEvent[] } {
  const changes: ChangeEvent[] = [];
  const releases = file.releases.map((r) => ({ ...r, scores: [...r.scores] }));
  const byId = new Map(releases.map((r) => [r.id, r] as const));

  for (const m of matches) {
    const target = byId.get(m.releaseId);
    if (!target) continue;
    const score = arenaScore(m.row, url, now);
    const idx = target.scores.findIndex((s) => s.benchmark === ARENA_BENCHMARK);
    if (idx >= 0) {
      const previous = target.scores[idx]!;
      target.scores[idx] = score;
      changes.push(
        change(now, 'worker', file.lab, target.id, 'score_updated', `${ARENA_BENCHMARK} ${previous.value} -> ${score.value}`, url),
      );
    } else {
      target.scores.push(score);
      changes.push(change(now, 'worker', file.lab, target.id, 'score_added', `${ARENA_BENCHMARK} ${score.value}`, url));
    }
  }

  return {
    file: { lab: file.lab, updated_at: changes.length > 0 ? now : file.updated_at, releases },
    changes,
  };
}

export interface ArenaOptions {
  dryRun?: boolean;
  /** Override the leaderboard URLs (tests). */
  urls?: string[];
}

export async function runArena(rt: Runtime, opts: ArenaOptions = {}): Promise<number> {
  const dryRun = opts.dryRun === true;
  const now = isoNow();
  const urls = opts.urls ?? rt.config.arenaUrls;

  // Collect every release we might match against: published + researched, with the lab's
  // display names for the organisation-consistency check.
  const published = readLabFiles(rt.config.dataDir);
  const labs = readLabs(rt.config.dataDir);
  const labNames = new Map<LabFile['lab'], string[]>();
  for (const lab of labs) labNames.set(lab.id, [lab.name, lab.short ?? '', lab.id].filter(Boolean));
  const releases: (Pick<ModelRelease, 'id' | 'name' | 'lab'> & { published: boolean })[] = [];
  for (const f of published) {
    for (const r of f.file.releases) releases.push({ id: r.id, name: r.name, lab: r.lab, published: true });
  }
  const researchedFiles = new Map<LabFile['lab'], LabFile>();
  for (const f of published) {
    const candidate = readResearchedFile(researchedPath(rt.config.dataDir, f.file.lab));
    if (candidate) researchedFiles.set(f.file.lab, candidate);
  }
  for (const [, file] of researchedFiles) {
    for (const r of file.releases) {
      if (!releases.some((x) => x.id === r.id)) releases.push({ id: r.id, name: r.name, lab: r.lab, published: false });
    }
  }
  const publishedIds = new Set(releases.filter((r) => r.published).map((r) => r.id));
  const publishedReleases = (releaseId: string): boolean => publishedIds.has(releaseId);

  // Dry-run never touches the network: it parses the checked-in fixture rendering of the
  // leaderboard so the printed match table is exactly what a real run would do.
  let text: string | null = null;
  let usedUrl: string | null = null;
  if (dryRun) {
    const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'lmarena-text.md');
    if (existsSync(fixturePath)) {
      text = readFileSync(fixturePath, 'utf8');
      usedUrl = urls[0] ?? 'fixture';
    } else {
      rt.log.error('arena --dry-run: fixture not found', { fixturePath });
      return 1;
    }
  } else {
    // Fetch the leaderboard: first URL that renders rows wins.
    for (const url of urls) {
      const page = await rt.fetcher(url, { minTextLength: 400 });
      if (!page.ok || page.text.length < 100) continue;
      const rows = parseArenaLeaderboard(page.text);
      if (rows.length >= 5) {
        text = page.text;
        usedUrl = page.url;
        break;
      }
      rt.log.debug('leaderboard rendered too few rows — trying the next URL', { url, rows: rows.length });
    }
  }
  if (text === null || usedUrl === null) {
    rt.log.error('arena: no leaderboard URL rendered parseable rows', { urls });
    return 1;
  }

  const rows = parseArenaLeaderboard(text);
  const matches: ArenaMatch[] = [];
  const unmatched: ArenaRow[] = [];
  for (const row of rows) {
    const rel = mapRowToRelease(row, releases);
    if (rel && organizationConsistent(row, rel.lab, labNames)) {
      // One row per release: the plain-name row wins over its effort variants; otherwise the
      // first (best-ranked) row seen keeps the slot.
      const held = matches.findIndex((m) => m.releaseId === rel.id);
      if (held >= 0) {
        if (isPlainRow(row, rel.name) && !isPlainRow(matches[held]!.row, rel.name)) {
          matches[held] = { row, releaseId: rel.id, lab: rel.lab, replaced: false };
        }
        continue;
      }
      matches.push({ row, releaseId: rel.id, lab: rel.lab, replaced: false });
    } else {
      unmatched.push(row);
    }
  }
  for (const m of matches) {
    const release = published.flatMap((f) => f.file.releases).find((r) => r.id === m.releaseId);
    m.replaced = release?.scores.some((s) => s.benchmark === ARENA_BENCHMARK) ?? false;
  }

  if (dryRun) {
    print(formatDryRun(matches, unmatched, usedUrl));
    return 0;
  }

  // Apply per lab file. The MERGED in-memory file is validated (schema + range check) before
  // it is written — never the old bytes, and a failure skips the lab with an error, exactly
  // like `promote`. Researched-only releases are written to `data/researched/<lab>.json` too.
  let errors = 0;
  const changes: ChangeEvent[] = [];
  const touchedLabs: string[] = [];
  const benchmarks = readBenchmarks(rt.config.dataDir);
  const validateMerged = (file: LabFile): string | null => {
    const parsed = LabFileSchema.safeParse(file);
    if (!parsed.success) return issuesToString(parsed.error.issues);
    const outOfRange = findOutOfRangeScores(parsed.data.releases, benchmarks);
    if (outOfRange.length > 0) {
      return `out-of-range scores: ${outOfRange.slice(0, 3).map((o) => `${o.release_id}/${o.benchmark}=${o.value}`).join(', ')}`;
    }
    return null;
  };

  for (const loaded of published) {
    const labMatches = matches.filter((m) => m.lab === loaded.file.lab);
    // Split into published vs researched-only targets.
    const publishedMatches = labMatches.filter((m) => publishedReleases(m.releaseId));
    const researchedMatches = labMatches.filter((m) => !publishedReleases(m.releaseId));
    let labTouched = false;

    if (publishedMatches.length > 0) {
      const applied = applyArenaMatches(loaded.file, publishedMatches, usedUrl, now);
      if (applied.changes.length > 0) {
        const problem = validateMerged(applied.file);
        if (problem) {
          errors++;
          rt.log.error('arena produced an invalid lab file — not written', { lab: loaded.file.lab, problem });
        } else {
          writeLabFile(rt.config.dataDir, applied.file as unknown as LabFile);
          changes.push(...applied.changes);
          labTouched = true;
        }
      }
    }

    if (researchedMatches.length > 0) {
      const researchedFile = researchedFiles.get(loaded.file.lab);
      if (researchedFile) {
        const applied = applyArenaMatches(researchedFile, researchedMatches, usedUrl, now);
        if (applied.changes.length > 0) {
          const problem = validateMerged(applied.file);
          if (problem) {
            errors++;
            rt.log.error('arena produced an invalid researched file — not written', { lab: loaded.file.lab, problem });
          } else {
            mkdirSync(dirname(researchedPath(rt.config.dataDir, loaded.file.lab)), { recursive: true });
            writeFileSync(researchedPath(rt.config.dataDir, loaded.file.lab), stringifyLabFile(applied.file as unknown as LabFile), 'utf8');
            changes.push(...applied.changes);
            labTouched = true;
          }
        }
      }
    }

    if (labTouched) touchedLabs.push(loaded.file.lab);
  }

  if (changes.length > 0) appendChanges(rt.config.dataDir, changes);

  // Mark researcher state, published through the bundle.
  const run = rt.state.readRun();
  run.researcher = { ...run.researcher, version: rt.config.researcherVersion, last_arena_at: now };
  rt.state.writeRun(run);

  print(
    `arena: ${rows.length} row(s), ${matches.length} matched (${changes.length} score row(s) written to ${touchedLabs.length} lab file(s)), ` +
      `${unmatched.length} unmatched — ${usedUrl}`,
  );
  for (const row of unmatched.slice(0, 20)) {
    rt.log.info('arena row unmatched', { model: row.model, score: row.score, url: usedUrl });
  }
  return errors > 0 ? 1 : 0;
}

function formatDryRun(matches: ArenaMatch[], unmatched: ArenaRow[], url: string): string {
  const rows = matches.map((m) => [m.row.model, String(m.row.score), m.releaseId, m.replaced ? 'replace' : 'add'] as string[]);
  const lines = [
    formatTable(['model', 'score', 'release', 'action'], rows),
    '',
    `arena --dry-run: ${matches.length} match(es), ${unmatched.length} unmatched — ${url}`,
  ];
  for (const row of unmatched.slice(0, 12)) lines.push(`  unmatched: ${row.model} (${row.score})`);
  return lines.join('\n');
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? '').padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}
