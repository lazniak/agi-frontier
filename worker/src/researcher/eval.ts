/**
 * `eval` — score the researcher's `data/researched/` against the frozen gold set `data/gold/`.
 *
 * A release matches when canonical names are equal or one contains the other AND the dates sit
 * within 45 days. A score matches when the benchmark is the same and the value is within 1.0
 * point (`%`) or 15 Elo. Pure maths here: no LLM, no network. The result is written to
 * `worker/.state/researcher-eval.json` and into the run state (published via the bundle).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LAB_IDS, type Benchmark, type Lab, type LabId, type ModelRelease, type ResearcherEval } from '@agi/shared';
import { readBenchmarks, readLabs } from '../data-store';
import { isoNow } from '../fetcher';
import { print } from '../log';
import { nameKey } from '../text';
import { hostMatches, officialHosts } from '../pipeline';
import { mergeSummaryLine } from '../state';
import type { Runtime } from '../runtime';
import { RESEARCHER_EVAL_FILE, researchedDir, writeJsonFile } from './common';

/**
 * A researched release the gold set lacks, but whose primary source sits on the lab's own host:
 * probably a real release the answer key never recorded (the first live run found Claude Opus 5
 * this way). Listed for a human to promote to gold; still counted against precision.
 */
export interface UnverifiedExtra {
  lab: LabId;
  name: string;
  date: string;
  url: string;
}

/** The worker's eval report: the shared metrics plus the unverified-extras list (REDESIGN §12.6). */
export interface EvalReport extends ResearcherEval {
  unverified_extras: UnverifiedExtra[];
}

/** The URL a release rests on: its first supporting source, else the announcement. */
export function primarySourceUrl(release: ModelRelease): string {
  return release.sources?.[0]?.url ?? release.announcement.url;
}

/**
 * Extras (found, not in gold) whose primary source is on one of the lab's official hosts — the
 * same host rule discovery applies when it screens candidates.
 */
export function unverifiedExtras(lab: Lab, extraFound: ModelRelease[]): UnverifiedExtra[] {
  const hosts = officialHosts(lab);
  return extraFound
    .filter((r) => hostMatches(primarySourceUrl(r), hosts))
    .map((r) => ({ lab: lab.id, name: r.name, date: r.date, url: primarySourceUrl(r) }));
}

export const DATE_TOLERANCE_DAYS = 45;
export const SCORE_TOLERANCE_PERCENT = 1.0;
export const SCORE_TOLERANCE_ELO = 15;

export interface EvalOptions {
  candidateDir?: string;
  goldDir?: string;
  /** Override the "today" reference (tests). */
  now?: string;
}

export function scoreTolerance(benchmark: Pick<Benchmark, 'unit'>): number {
  return benchmark.unit === 'elo' ? SCORE_TOLERANCE_ELO : SCORE_TOLERANCE_PERCENT;
}

export function datesWithinTolerance(a: string, b: string, toleranceDays = DATE_TOLERANCE_DAYS): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  return Math.abs(ta - tb) / 86_400_000 <= toleranceDays;
}

/** Release-level matching rule (documented in docs/REDESIGN.md §6.1). */
export function releasesMatch(a: ModelRelease, b: ModelRelease): boolean {
  const ka = nameKey(a.name);
  const kb = nameKey(b.name);
  if (!ka || !kb) return false;
  if (ka === kb) return datesWithinTolerance(a.date, b.date);
  const contained = (ka.length >= 4 && (ka.includes(kb) || kb.includes(ka)))
    || (ka.length < 4 && ka === kb);
  return contained && datesWithinTolerance(a.date, b.date);
}

/** Greedy 1:1 matching: gold releases in order take the first candidate that matches. */
export function matchReleases(gold: ModelRelease[], candidate: ModelRelease[]): { pairs: { gold: ModelRelease; found: ModelRelease }[]; unmatchedGold: ModelRelease[]; extraFound: ModelRelease[] } {
  const pairs: { gold: ModelRelease; found: ModelRelease }[] = [];
  const used = new Set<number>();
  for (const g of gold) {
    let matchIdx = -1;
    for (let i = 0; i < candidate.length; i++) {
      if (used.has(i)) continue;
      if (releasesMatch(g, candidate[i]!)) { matchIdx = i; break; }
    }
    if (matchIdx >= 0) {
      used.add(matchIdx);
      pairs.push({ gold: g, found: candidate[matchIdx]! });
    }
  }
  return {
    pairs,
    unmatchedGold: gold.filter((g) => !pairs.some((p) => p.gold === g)),
    extraFound: candidate.filter((_, i) => !used.has(i)),
  };
}

export function matchScores(
  gold: ModelRelease['scores'],
  found: ModelRelease['scores'],
  benchmarks: Benchmark[],
): { matched: number; maeSum: number; maeN: number; misses: { benchmark: string; delta: number }[] } {
  const tolerance = new Map(benchmarks.map((b) => [b.id, scoreTolerance(b)] as const));
  let matched = 0;
  let maeSum = 0;
  let maeN = 0;
  const misses: { benchmark: string; delta: number }[] = [];
  for (const s of found) {
    const g = gold.find((x) => x.benchmark === s.benchmark);
    if (!g) continue;
    const delta = Math.abs(g.value - s.value);
    if (delta > (tolerance.get(s.benchmark) ?? SCORE_TOLERANCE_PERCENT)) {
      misses.push({ benchmark: s.benchmark, delta });
      continue;
    }
    matched++;
    maeSum += delta;
    maeN++;
  }
  return { matched, maeSum, maeN, misses };
}

export function readGoldDir(goldDir: string): { lab: LabId; releases: ModelRelease[] }[] {
  const out: { lab: LabId; releases: ModelRelease[] }[] = [];
  for (const lab of LAB_IDS) {
    const path = join(goldDir, `${lab}.json`);
    if (!existsSync(path)) continue;
    try {
      const file = JSON.parse(readFileSync(path, 'utf8')) as { releases?: ModelRelease[] };
      out.push({ lab, releases: file.releases ?? [] });
    } catch {
      /* a malformed gold file counts as empty; the seed is version-controlled */
    }
  }
  return out;
}

export function readCandidateDir(candidateDir: string): { lab: LabId; releases: ModelRelease[] }[] {
  const out: { lab: LabId; releases: ModelRelease[] }[] = [];
  for (const lab of LAB_IDS) {
    const path = join(candidateDir, `${lab}.json`);
    if (!existsSync(path)) continue;
    try {
      const file = JSON.parse(readFileSync(path, 'utf8')) as { releases?: ModelRelease[] };
      out.push({ lab, releases: file.releases ?? [] });
    } catch {
      out.push({ lab, releases: [] });
    }
  }
  return out;
}

export function computeEval(
  gold: { lab: LabId; releases: ModelRelease[] }[],
  candidate: { lab: LabId; releases: ModelRelease[] }[],
  benchmarks: Benchmark[],
  evaluatedAt: string,
  /** labs.json — needed for the official-host test behind `unverified_extras`; none = no extras listed. */
  labs: Lab[] = [],
): EvalReport {
  const goldByLab = new Map(gold.map((g) => [g.lab, g.releases] as const));
  const candByLab = new Map(candidate.map((c) => [c.lab, c.releases] as const));
  const labById = new Map(labs.map((l) => [l.id, l] as const));
  const extras: UnverifiedExtra[] = [];

  let goldReleases = 0;
  let foundReleases = 0;
  let matchedReleases = 0;
  let goldScores = 0;
  let matchedScores = 0;
  let maeSum = 0;
  let maeN = 0;
  let quotesTotal = 0;
  let quotesVerified = 0;

  const byLab: ResearcherEval['by_lab'] = {} as ResearcherEval['by_lab'];
  for (const lab of LAB_IDS) {
    byLab[lab] = { gold: 0, found: 0, matched: 0, scores_gold: 0, scores_matched: 0 };
  }

  // Iterate the union of gold and candidate labs: `found` counts every candidate release, also
  // in labs with no gold file (those found releases are all "extra" and lower precision).
  const labSet = new Set<LabId>([...goldByLab.keys(), ...candByLab.keys()]);
  for (const lab of labSet) {
    const goldReleasesForLab = goldByLab.get(lab) ?? [];
    const cand = candByLab.get(lab) ?? [];
    const { pairs, extraFound } = matchReleases(goldReleasesForLab, cand);
    const labDef = labById.get(lab);
    if (labDef) extras.push(...unverifiedExtras(labDef, extraFound));
    goldReleases += goldReleasesForLab.length;
    foundReleases += cand.length;
    matchedReleases += pairs.length;
    byLab[lab]!.gold += goldReleasesForLab.length;
    byLab[lab]!.found += cand.length;
    byLab[lab]!.matched += pairs.length;

    // Gold scores are summed over ALL gold releases of the lab — not only the matched ones —
    // so one perfectly-matched release can never fake a 1.0 score recall.
    for (const g of goldReleasesForLab) {
      goldScores += g.scores.length;
      byLab[lab]!.scores_gold += g.scores.length;
    }
    for (const p of pairs) {
      const scoreMatch = matchScores(p.gold.scores, p.found.scores, benchmarks);
      matchedScores += scoreMatch.matched;
      byLab[lab]!.scores_matched += scoreMatch.matched;
      maeSum += scoreMatch.maeSum;
      maeN += scoreMatch.maeN;
      // Quote stats come from the candidate's own `verified` flags: announcement + every score
      // source it wrote. The researcher only ever writes verified:true (quote-gated), so this
      // measures how much of what it found survived the gate.
      quotesTotal += 1 + p.found.scores.length;
      if (p.found.announcement.verified === true) quotesVerified++;
      for (const s of p.found.scores) if (s.source.verified === true) quotesVerified++;
    }
  }

  const precision = foundReleases > 0 ? matchedReleases / foundReleases : 0;
  const recall = goldReleases > 0 ? matchedReleases / goldReleases : 0;
  const scoreRecall = goldScores > 0 ? matchedScores / goldScores : 0;
  return {
    evaluated_at: evaluatedAt,
    gold_releases: goldReleases,
    found_releases: foundReleases,
    matched_releases: matchedReleases,
    precision_releases: round(precision),
    recall_releases: round(recall),
    gold_scores: goldScores,
    matched_scores: matchedScores,
    score_recall: round(scoreRecall),
    score_mae: maeN > 0 ? round(maeSum / maeN) : 0,
    quotes_total: quotesTotal,
    quotes_verified: quotesVerified,
    quote_verified_rate: quotesTotal > 0 ? round(quotesVerified / quotesTotal) : 0,
    by_lab: byLab,
    unverified_extras: extras.sort((a, b) => a.lab.localeCompare(b.lab) || a.date.localeCompare(b.date)),
  };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function formatEvalTable(evalResult: ResearcherEval | EvalReport): string {
  const headers = ['lab', 'gold', 'found', 'matched', 'scores gold', 'scores matched'];
  const rows = LAB_IDS.map((lab) => {
    const b = evalResult.by_lab[lab]!;
    return [lab, String(b.gold), String(b.found), String(b.matched), String(b.scores_gold), String(b.scores_matched)];
  }).filter((r) => r[1] !== '0' || r[2] !== '0');
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? '').padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  const table = [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
  const extras = 'unverified_extras' in evalResult ? evalResult.unverified_extras : [];
  return [
    table,
    '',
    `releases: matched ${evalResult.matched_releases}/${evalResult.gold_releases} gold, ` +
      `precision ${evalResult.precision_releases}, recall ${evalResult.recall_releases}`,
    `scores:   matched ${evalResult.matched_scores}/${evalResult.gold_scores} (recall ${evalResult.score_recall}), ` +
      `MAE ${evalResult.score_mae}`,
    `quotes:   ${evalResult.quotes_verified}/${evalResult.quotes_total} verified (${evalResult.quote_verified_rate})`,
    ...(extras.length > 0
      ? [
          '',
          `unverified extras (${extras.length}) — found on an official host, missing from gold; counted against precision, review for the gold set:`,
          ...extras.map((x) => `  ${x.lab}  ${x.date}  ${x.name}  ${x.url}`),
        ]
      : []),
  ].join('\n');
}

/** The one-line `last_backfill_summary` for an eval run. */
export function formatEvalSummary(evalResult: EvalReport, pass: boolean): string {
  return (
    `eval: ${evalResult.matched_releases}/${evalResult.gold_releases} gold matched, ` +
    `precision ${evalResult.precision_releases}, recall ${evalResult.recall_releases}, score recall ${evalResult.score_recall}` +
    (evalResult.unverified_extras.length > 0 ? `, ${evalResult.unverified_extras.length} unverified extra${evalResult.unverified_extras.length === 1 ? '' : 's'}` : '') +
    ` → promote ${pass ? 'PASS' : 'NOT MET'}`
  );
}

export async function runEval(rt: Runtime, opts: EvalOptions = {}): Promise<number> {
  const goldDir = opts.goldDir ?? join(rt.config.dataDir, 'gold');
  const candidateDir = opts.candidateDir ?? researchedDir(rt.config.dataDir);
  const benchmarks = readBenchmarks(rt.config.dataDir);
  const labs = readLabs(rt.config.dataDir);
  const gold = readGoldDir(goldDir);
  const candidate = readCandidateDir(candidateDir);
  const evalResult = computeEval(gold, candidate, benchmarks, opts.now ?? isoNow(), labs);
  const pass =
    evalResult.recall_releases >= rt.config.promoteMinRecall &&
    evalResult.precision_releases >= rt.config.promoteMinPrecision &&
    evalResult.score_recall >= rt.config.promoteMinScoreRecall;

  writeJsonFile(join(rt.config.stateDir, RESEARCHER_EVAL_FILE), evalResult);
  const run = rt.state.readRun();
  run.researcher = {
    ...run.researcher,
    version: rt.config.researcherVersion,
    last_eval_at: evalResult.evaluated_at,
    eval: evalResult,
    last_backfill_summary: mergeSummaryLine(run.researcher.last_backfill_summary, formatEvalSummary(evalResult, pass)),
  };
  rt.state.writeRun(run);

  print(formatEvalTable(evalResult));
  print(
    `promote gates: recall ≥ ${rt.config.promoteMinRecall}, precision ≥ ${rt.config.promoteMinPrecision}, ` +
      `score recall ≥ ${rt.config.promoteMinScoreRecall} → ${pass ? 'PASS' : 'NOT MET'}`,
  );
  return 0;
}