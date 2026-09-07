/**
 * `promote` — copy the researcher's findings into the published dataset, but only when the
 * latest eval clears the gates (recall ≥ 0.85, precision ≥ 0.95, score recall ≥ 0.8; env-tunable).
 *
 * Merge rule (REDESIGN §6.1): for each researched release, add it when no release with the same
 * canonical name exists; when one does, add only the scores the existing release lacks — a
 * verified score is never overwritten. Existing releases are never deleted or rewritten.
 */
import { existsSync } from 'node:fs';
import { LabFileSchema, findOutOfRangeScores, type ChangeEvent, type LabFile, type LabId, type ModelRelease } from '@agi/shared';
import { appendChanges, issuesToString, readBenchmarks, readLabFiles, writeLabFile } from '../data-store';
import { isoNow } from '../fetcher';
import { print } from '../log';
import { change } from '../merge';
import { nameKey } from '../text';
import { buildCommitMessage, commitAndPush, dataDirty } from '../git';
import type { Runtime } from '../runtime';
import { readResearchedFile, researchedDir, researchedPath } from './common';

export interface PromoteOptions {
  force?: boolean;
}

export interface PromoteGateCheck {
  pass: boolean;
  failures: string[];
}

export function checkGates(
  evalResult: { recall_releases: number; precision_releases: number; score_recall: number },
  thresholds: { recall: number; precision: number; scoreRecall: number },
): PromoteGateCheck {
  const failures: string[] = [];
  if (evalResult.recall_releases < thresholds.recall) {
    failures.push(`recall_releases ${evalResult.recall_releases} < ${thresholds.recall}`);
  }
  if (evalResult.precision_releases < thresholds.precision) {
    failures.push(`precision_releases ${evalResult.precision_releases} < ${thresholds.precision}`);
  }
  if (evalResult.score_recall < thresholds.scoreRecall) {
    failures.push(`score_recall ${evalResult.score_recall} < ${thresholds.scoreRecall}`);
  }
  return { pass: failures.length === 0, failures };
}

/** Pure merge core: `researched` into `published`, adding releases and missing scores only. */
export function mergeForPromote(
  published: LabFile,
  researched: LabFile,
  now: string,
): { file: LabFile; changes: ChangeEvent[]; added: number; scoresAdded: number } {
  const changes: ChangeEvent[] = [];
  const releases = published.releases.map((r) => ({ ...r, scores: [...r.scores] }));
  const byName = new Map(releases.map((r, i) => [nameKey(r.name), i] as const));
  let added = 0;
  let scoresAdded = 0;

  for (const rel of researched.releases) {
    const key = nameKey(rel.name);
    if (!key) continue;
    const idx = byName.get(key);
    if (idx === undefined) {
      const copy: ModelRelease = { ...rel, origin: 'researcher' };
      releases.push(copy);
      byName.set(key, releases.length - 1);
      added++;
      changes.push(
        change(now, 'worker', published.lab, copy.id, 'release_added', `${copy.name} — ${copy.status} ${copy.date} (researcher)`, copy.announcement.url),
      );
      continue;
    }
    const target = releases[idx]!;
    const present = new Set(target.scores.map((s) => `${s.benchmark}|${s.config ?? ''}`));
    for (const s of rel.scores) {
      const k = `${s.benchmark}|${s.config ?? ''}`;
      if (present.has(k)) continue;
      present.add(k);
      target.scores.push(s);
      scoresAdded++;
      changes.push(
        change(now, 'worker', published.lab, target.id, 'score_added', `${s.benchmark} ${s.value} (researcher)`, s.source.url),
      );
    }
  }

  return {
    file: { lab: published.lab, updated_at: changes.length > 0 ? now : published.updated_at, releases },
    changes,
    added,
    scoresAdded,
  };
}

export async function runPromote(rt: Runtime, opts: PromoteOptions = {}): Promise<number> {
  const now = isoNow();
  const run = rt.state.readRun();
  const evalResult = run.researcher.eval;

  if (!opts.force) {
    if (!evalResult) {
      print('promote refused: no eval on record — run `eval` first');
      return 1;
    }
    const gate = checkGates(evalResult, {
      recall: rt.config.promoteMinRecall,
      precision: rt.config.promoteMinPrecision,
      scoreRecall: rt.config.promoteMinScoreRecall,
    });
    if (!gate.pass) {
      print(`promote refused: gates not met — ${gate.failures.join('; ')}`);
      return 1;
    }
  } else {
    print('promote --force: thresholds bypassed');
  }

  const outDir = researchedDir(rt.config.dataDir);
  if (!existsSync(outDir)) {
    print(`promote: nothing to promote — ${outDir} does not exist`);
    return 0;
  }
  const benchmarks = readBenchmarks(rt.config.dataDir);
  const publishedFiles = readLabFiles(rt.config.dataDir);
  const changes: ChangeEvent[] = [];
  const touched: string[] = [];
  const summaries: string[] = [];
  let errors = 0;
  let totalAdded = 0;
  let totalScores = 0;

  for (const loaded of publishedFiles) {
    const lab: LabId = loaded.file.lab;
    const researched = readResearchedFile(researchedPath(rt.config.dataDir, lab));
    if (!researched || researched.releases.length === 0) continue;

    const merged = mergeForPromote(loaded.file, researched, now);
    if (merged.changes.length === 0) continue;

    const parsed = LabFileSchema.safeParse(merged.file);
    if (!parsed.success) {
      errors++;
      rt.log.error('promote produced an invalid lab file — skipped', { lab, issues: issuesToString(parsed.error.issues) });
      continue;
    }
    const outOfRange = findOutOfRangeScores(parsed.data.releases, benchmarks);
    if (outOfRange.length > 0) {
      errors++;
      rt.log.error('promote refused — out-of-range scores', {
        lab,
        samples: outOfRange.slice(0, 5).map((o) => `${o.release_id}/${o.benchmark}=${o.value}`),
      });
      continue;
    }
    writeLabFile(rt.config.dataDir, parsed.data as unknown as LabFile);
    changes.push(...merged.changes);
    touched.push(lab);
    totalAdded += merged.added;
    totalScores += merged.scoresAdded;
    summaries.push(`${lab}: +${merged.added} release(s), +${merged.scoresAdded} score(s)`);
  }

  if (changes.length > 0) appendChanges(rt.config.dataDir, changes);

  if (rt.config.gitPush && touched.length > 0 && dataDirty({ cwd: rt.config.repoRoot, log: rt.log })) {
    const message = `data(bot): promote researcher — ${summaries.join('; ')}`;
    const result = commitAndPush({ cwd: rt.config.repoRoot, log: rt.log }, message);
    rt.log.info('git', { ...result });
  }

  print(
    `promote: ${totalAdded} release(s) and ${totalScores} score(s) added across ${touched.length} lab file(s)` +
      (touched.length ? ` — ${touched.join(', ')}` : '') +
      (errors ? `; ${errors} file(s) skipped` : ''),
  );
  return errors > 0 ? 1 : 0;
}