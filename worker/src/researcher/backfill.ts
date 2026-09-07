/**
 * The researcher's main command: rebuild `data/researched/<lab>.json` from the live web.
 *
 * Per lab: discovery (web search) -> for every candidate not yet in the output file: fetch the
 * launch page, run the existing extraction pipeline (official-host rule, quote gate, tier,
 * per-benchmark range checks), write with `origin: 'researcher'`. Progress lives in
 * `worker/.state/researcher-progress.json` so a killed run resumes; `RESEARCH_MAX_CALLS` bounds
 * the damage. Idempotent: names already done are skipped, so a re-run only costs discovery.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LabFileSchema, type Lab, type LabFile, type LabId, type Source } from '@agi/shared';
import { readBenchmarks, readLabs, issuesToString } from '../data-store';
import { isoNow } from '../fetcher';
import { print } from '../log';
import { extractFromPage, hostMatches, itemDateOrToday, officialHosts, todayISO } from '../pipeline';
import { compileHints } from '../candidates';
import { stringifyLabFile } from '../canonical';
import { nameKey } from '../text';
import { uniqueId } from '../merge';
import { Semaphore } from '../llm';
import { buildCommitMessage, commitAndPush, dataDirty } from '../git';
import type { Runtime } from '../runtime';
import { discoverModels, type DiscoveredModel, type ScreenedCandidate } from './discovery';
import {
  Budget,
  labProgress,
  readProgress,
  researchedDir,
  researchedPath,
  writeProgress,
  type ResearcherProgress,
} from './common';

export interface BackfillOptions {
  lab?: LabId;
  out?: string;
  /** Only candidates missing from `data/models`, dated within the last 120 days. */
  incremental?: boolean;
  /** Discovery with a fake LLM (fixture) and a printed plan — no network, no writes. */
  dryRun?: boolean;
  /** Test seams: a fake discovery result and/or a fake fetch. */
  discoverImpl?: typeof discoverModels;
  log?: import('../log').Logger;
}

export interface BackfillPlanEntry {
  lab: LabId;
  name: string;
  tier: string;
  date: string | null;
  url: string;
  /** Why this entry is in the plan: new, or already done. */
  status: 'pending' | 'done' | 'failed-before' | 'already-in-models' | 'too-old';
}

/** 120-day window for `--incremental` (REDESIGN §6.1). */
export const INCREMENTAL_WINDOW_DAYS = 120;

export function isWithinIncrementalWindow(date: string | null | undefined, today: string, windowDays = INCREMENTAL_WINDOW_DAYS): boolean {
  if (!date) return false;
  const t = Date.parse(date.length === 7 ? `${date}-01` : date);
  if (!Number.isFinite(t)) return false;
  const ageDays = (Date.parse(today) - t) / 86_400_000;
  return ageDays >= -1 && ageDays <= windowDays;
}

/**
 * Whether `--incremental` should extract this candidate at all. Shared by the dry-run plan and
 * the real run so the printed plan always matches what the run would do.
 */
export function incrementalSkip(
  candidate: Pick<DiscoveredModel, 'name' | 'date'>,
  opts: { incremental: boolean; doneNames: Set<string>; failedNames: Set<string>; modelNames: Set<string>; today: string },
): BackfillPlanEntry['status'] | null {
  const nameLower = candidate.name.toLowerCase();
  if (opts.doneNames.has(nameLower)) return 'done';
  if (opts.failedNames.has(nameLower)) return 'failed-before';
  if (!opts.incremental) return null;
  if (opts.modelNames.has(nameKey(candidate.name))) return 'already-in-models';
  if (!isWithinIncrementalWindow(candidate.date ?? null, opts.today)) return 'too-old';
  return null;
}

/**
 * A `--dry-run` needs no API key and no network: it plans from this canned discovery result,
 * one recent real model per lab (the same names `data/models` already carries), so the printed
 * plan shows the real interplay with `--incremental` and the progress file.
 */
const DRY_RUN_FIXTURE: Record<string, { name: string; family: string; url: string }> = {
  openai: { name: 'GPT-5.6 Sol', family: 'GPT', url: 'https://openai.com/index/introducing-gpt-5-6-sol/' },
  anthropic: { name: 'Claude Fable 5.1', family: 'Claude Fable', url: 'https://www.anthropic.com/news/claude-fable-5-1' },
  google: { name: 'Gemini 3.5 Pro', family: 'Gemini Pro', url: 'https://blog.google/technology/google-deepmind/gemini-3-5/' },
  xai: { name: 'Grok 4.6', family: 'Grok', url: 'https://x.ai/news/grok-4-6' },
  meta: { name: 'Muse Spark', family: 'Meta Superintelligence', url: 'https://ai.meta.com/blog/muse-spark/' },
  deepseek: { name: 'DeepSeek-V4-Pro', family: 'DeepSeek', url: 'https://api-docs.deepseek.com/news/deepseek-v4-pro' },
  alibaba: { name: 'Qwen3.8-Max', family: 'Qwen Max', url: 'https://qwenlm.github.io/blog/qwen3.8-max/' },
  moonshot: { name: 'Kimi K3', family: 'Kimi', url: 'https://moonshotai.github.io/Kimi-K3/' },
  zhipu: { name: 'GLM-5.3', family: 'GLM', url: 'https://zhipuai.com/news/glm-5-3' },
  mistral: { name: 'Mistral Large 3', family: 'Mistral Large', url: 'https://mistral.ai/news/mistral-large-3' },
};

export const DRY_RUN_DISCOVERY: DiscoverFn = async (rt, lab) => {
  const hit = DRY_RUN_FIXTURE[lab.id] ?? { name: lab.short, family: lab.short, url: lab.website };
  rt.log.debug('dry-run discovery fixture used', { lab: lab.id });
  return {
    candidates: [
      {
        name: hit.name,
        family: hit.family,
        tier: 'flagship',
        date: '2026-08-30',
        launch_url: hit.url,
        confidence: 0.5,
      },
    ],
    errors: [],
    calls: 0,
  };
};

export type DiscoverFn = typeof discoverModels;

export async function planBackfill(
  rt: Runtime,
  opts: BackfillOptions,
): Promise<{ labs: { lab: Lab; candidates: BackfillPlanEntry[] }[]; discoveryCalls: number; errors: string[] }> {
  const dataDir = rt.config.dataDir;
  const today = todayISO();
  const currentYear = Number.parseInt(today.slice(0, 4), 10);
  const progress = readProgress(rt.config.stateDir);
  const labs = readLabs(dataDir).filter((l) => !opts.lab || l.id === opts.lab);
  const discover = opts.discoverImpl ?? discoverModels;
  void discover;
  if (!rt.openRouter && !opts.discoverImpl) {
    throw new Error('backfill needs OPENROUTER_API_KEY (or a --dry-run plan, which needs neither)');
  }

  const plan: { lab: Lab; candidates: BackfillPlanEntry[] }[] = [];
  let discoveryCalls = 0;
  const errors: string[] = [];

  for (const lab of labs) {
    const prog = labProgress(progress, lab.id);
    const doneKeys = new Set(prog.done.map((n) => n.toLowerCase()));
    const failedKeys = new Set(prog.failed.map((n) => n.toLowerCase()));

    const discovery = await discover({ openRouter: rt.openRouter!, log: rt.log }, lab, rt.config.researchModel, currentYear, {});
    discoveryCalls += discovery.calls;
    errors.push(...discovery.errors);

    // Existing canonical names in the published dataset — `--incremental` skips these.
    const modelsFile = join(dataDir, 'models', `${lab.id}.json`);
    const modelNames = new Set<string>();
    if (existsSync(modelsFile)) {
      try {
        const parsed = LabFileSchema.safeParse(JSON.parse(readFileSync(modelsFile, 'utf8')));
        if (parsed.success) for (const r of parsed.data.releases) modelNames.add(nameKey(r.name));
      } catch {
        /* validated elsewhere */
      }
    }

    const entries: BackfillPlanEntry[] = discovery.candidates
      .map((c): BackfillPlanEntry => ({
        lab: lab.id,
        name: c.name,
        tier: c.tier,
        date: c.date ?? null,
        url: c.launch_url,
        status: incrementalSkip(c, {
          incremental: opts.incremental === true,
          doneNames: doneKeys,
          failedNames: failedKeys,
          modelNames,
          today,
        }) ?? 'pending',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    plan.push({ lab, candidates: entries });
  }

  return { labs: plan, discoveryCalls, errors };
}

export interface BackfillRunSummary {
  labs: number;
  candidates: number;
  extracted: number;
  releasesWritten: number;
  scoresWritten: number;
  llmCalls: number;
  errors: number;
  stoppedEarly: boolean;
}

export async function runBackfillImpl(rt: Runtime, opts: BackfillOptions): Promise<number> {
  const dryRun = opts.dryRun === true;
  const log = opts.log ?? rt.log;
  const dataDir = rt.config.dataDir;
  const today = todayISO();
  const now = isoNow();
  const currentYear = Number.parseInt(today.slice(0, 4), 10);
  const benchmarks = readBenchmarks(dataDir);
  const labs = readLabs(dataDir).filter((l) => !opts.lab || l.id === opts.lab);
  const discover = opts.discoverImpl ?? discoverModels;

  const progress: ResearcherProgress = readProgress(rt.config.stateDir);
  const budget = new Budget(rt.config.researchMaxCalls);
  const summary: BackfillRunSummary = {
    labs: 0, candidates: 0, extracted: 0, releasesWritten: 0, scoresWritten: 0,
    llmCalls: 0, errors: 0, stoppedEarly: false,
  };
  // Per-run usage delta: the client is shared with poll/discover, so subtract the snapshot
  // taken at the start; lifetime totals stay in the log only.
  const statsAtStart = rt.openRouter?.stats();
  const delta = (stats: { calls: number; tokens_in: number; tokens_out: number; usd_estimate: number }) => ({
    calls: stats.calls - (statsAtStart?.calls ?? 0),
    tokens_in: stats.tokens_in - (statsAtStart?.tokens_in ?? 0),
    tokens_out: stats.tokens_out - (statsAtStart?.tokens_out ?? 0),
    usd_estimate: stats.usd_estimate - (statsAtStart?.usd_estimate ?? 0),
  });
  /** Persist progress immediately — a kill or a later schema failure must not lose it. */
  const saveProgress = () => {
    if (!dryRun) writeProgress(rt.config.stateDir, progress);
  };

  for (const lab of labs) {
    const labLog = log.child({ lab: lab.id });
    summary.labs++;
    const prog = labProgress(progress, lab.id);
    // Set-deduped: repeated runs must not grow done/failed without bound.
    const doneSet = new Set(prog.done);
    const failedSet = new Set(prog.failed);
    if (!rt.openRouter) {
      labLog.error('backfill needs OPENROUTER_API_KEY');
      summary.errors++;
      continue;
    }

    // Everything already researched for this lab stays in the file (never delete history).
    const outPath = researchedPath(dataDir, lab.id, opts.out);
    const existing: LabFile = existsSync(outPath)
      ? (() => {
          try {
            const parsed = LabFileSchema.safeParse(JSON.parse(readFileSync(outPath, 'utf8')));
            if (parsed.success) return parsed.data as unknown as LabFile;
          } catch { /* rewritten below */ }
          return { lab: lab.id, updated_at: now, releases: [] };
        })()
      : { lab: lab.id, updated_at: now, releases: [] };
    const releases: LabFile['releases'] = [...existing.releases];
    const namesInFile = new Set(releases.map((r) => nameKey(r.name)));
    const usedIds = new Set(releases.map((r) => r.id));

    const hints = compileHints(lab.flagship_hints);
    const benchmarkIds = new Set(benchmarks.map((b) => b.id));
    const hosts = officialHosts(lab);

    const discovery = await discover({ openRouter: rt.openRouter!, log: rt.log }, lab, rt.config.researchModel, currentYear, {
      budgetExhausted: () => budget.exhausted,
      benchmarks,
    });
    summary.llmCalls += discovery.calls;
    for (let i = 0; i < discovery.calls; i++) budget.spend();
    summary.errors += discovery.errors.length;
    saveProgress();

    // Same predicate as the printed plan (item: --incremental must bind the real run too).
    const modelNames = new Set<string>();
    const modelsFile = join(dataDir, 'models', `${lab.id}.json`);
    if (existsSync(modelsFile)) {
      try {
        const parsed = LabFileSchema.safeParse(JSON.parse(readFileSync(modelsFile, 'utf8')));
        if (parsed.success) for (const r of parsed.data.releases) modelNames.add(nameKey(r.name));
      } catch {
        /* validated elsewhere */
      }
    }
    const candidates: ScreenedCandidate[] = discovery.candidates
      .map((c) => {
        // Real discovery pre-screens; fakes (tests) and older impls may not — the host filter
        // is a data-safety rule, so it is re-derived here regardless.
        const official = 'official' in c && typeof c.official === 'boolean' ? c.official : hostMatches(c.launch_url, hosts);
        return { ...c, official };
      })
      .map((c) => ({
        candidate: c,
        skip: incrementalSkip(c, {
          incremental: opts.incremental === true,
          doneNames: new Set([...doneSet].map((n) => n.toLowerCase())),
          failedNames: new Set([...failedSet].map((n) => n.toLowerCase())),
          modelNames,
          today,
        }),
      }))
      .filter(({ candidate, skip }) => {
        // Names already in the researched file are skipped regardless of mode.
        if (namesInFile.has(nameKey(candidate.name))) return false;
        return skip === null;
      })
      .map((x) => x.candidate);
    summary.candidates += candidates.length;
    labLog.info('backfill candidates', {
      discovered: discovery.candidates.length,
      pending: candidates.length,
      already_done: discovery.candidates.length - candidates.length,
    });

    /** Extract one candidate; mutate only the local buffers, never `prog` directly. */
    const processCandidate = async (candidate: ScreenedCandidate): Promise<void> => {
      if (budget.exhausted) {
        summary.stoppedEarly = true;
        return;
      }
      const page = await rt.fetcher(candidate.launch_url, { minTextLength: 400 });
      if (!page.ok || page.text.length < 40) {
        summary.errors++;
        failedSet.add(candidate.name);
        labLog.warn('candidate page unreadable', { url: candidate.launch_url, status: page.status, error: page.error });
        saveProgress();
        return;
      }
      try {
        const result = await extractFromPage({
          client: rt.openRouter!,
          model: rt.config.openRouterModel,
          lab,
          benchmarks,
          benchmarkIds,
          today,
          page,
          fallbackDate: itemDateOrToday(candidate.date ?? undefined),
          flagshipHints: hints,
          log: labLog,
          ...(candidate.name ? { pageTitle: candidate.name } : {}),
          // Press coverage can never make something `released` and never carries official
          // numbers — same rule as `discover` (REDESIGN §6.1).
          ...(candidate.official ? {} : { forceStatus: 'rumored' as const, dropScores: true }),
        });
        summary.llmCalls++;
        budget.spend();
        const kept = result.releases.filter((r) => r.name.toLowerCase() === candidate.name.toLowerCase() ||
          (r.name.length > 0 && candidate.name.toLowerCase().includes(r.name.toLowerCase())));
        if (kept.length === 0) {
          failedSet.add(candidate.name);
          labLog.info('nothing verifiable extracted', { name: candidate.name, url: page.url, dropped: result.dropped.length });
          saveProgress();
          return;
        }
        for (const rel of kept) {
          if (namesInFile.has(nameKey(rel.name))) continue;
          const id = uniqueId(lab.id, rel.name, usedIds);
          if (!id) {
            summary.errors++;
            labLog.warn('cannot build a valid release id', { name: rel.name });
            continue;
          }
          const via = page.via;
          const announcement: LabFile['releases'][number]['announcement'] = {
            url: page.url,
            quote: rel.announcement_quote,
            retrieved_at: now,
            verified: true,
            verified_at: now,
            ...(candidate.name ? { title: candidate.name } : {}),
            ...(via ? { via } : {}),
          };
          const supporting: Source[] = [
            {
              url: candidate.launch_url,
              quote: rel.announcement_quote,
              retrieved_at: now,
              verified: true,
              verified_at: now,
              ...(via ? { via } : {}),
            },
          ];
          releases.push({
            id,
            lab: lab.id,
            name: rel.name,
            family: rel.family,
            date: rel.date,
            date_precision: rel.date_precision,
            status: rel.status,
            ...(rel.tier && rel.tier !== 'flagship' ? { tier: rel.tier } : {}),
            origin: 'researcher',
            announcement,
            sources: supporting,
            scores: rel.scores.map((s) => ({
              benchmark: s.benchmark,
              value: s.value,
              ...(s.config ? { config: s.config } : {}),
              reported_by: 'official' as const,
              source: {
                url: page.url,
                quote: s.quote,
                retrieved_at: now,
                verified: true,
                verified_at: now,
                ...(via ? { via } : {}),
              },
            })),
          });
          usedIds.add(id);
          namesInFile.add(nameKey(rel.name));
          doneSet.add(candidate.name);
          summary.releasesWritten++;
          summary.scoresWritten += rel.scores.length;
        }
        summary.extracted++;
      } catch (e) {
        summary.errors++;
        failedSet.add(candidate.name);
        labLog.error('extraction failed', { name: candidate.name, error: (e as Error).message });
      }
      saveProgress();
    };

    if (dryRun) continue;

    // Concurrency-bounded extraction (RESEARCH_CONCURRENCY). A dedicated semaphore — NOT the
    // client's: chatJson acquires the client semaphore inside each task, and nesting the same
    // semaphore would deadlock once RESEARCH_CONCURRENCY tasks each wait for a slot.
    const sem = new Semaphore(rt.config.researchConcurrency);
    try {
      await Promise.all(candidates.map((c) => sem.run(() => processCandidate(c))));
    } catch {
      /* processCandidate never throws; kept for safety */
    }
    if (budget.exhausted && candidates.length > 0) {
      labLog.warn('research budget exhausted — stopping cleanly', { max: budget.max });
    }

    // Validate with the shared schema before writing anything.
    const file: LabFile = { lab: lab.id, updated_at: now, releases: releases.sort(byDate) };
    const parsed = LabFileSchema.safeParse(file);
    if (!parsed.success) {
      summary.errors++;
      // Progress was already persisted per candidate — this loses nothing.
      labLog.error('researched file failed schema validation — not written', {
        issues: issuesToString(parsed.error.issues).slice(0, 400),
      });
      continue;
    }
    mkdirSync(researchedDir(dataDir, opts.out), { recursive: true });
    writeFileSync(outPath, stringifyLabFile(parsed.data as unknown as LabFile), 'utf8');
    labLog.info('researched file written', {
      path: outPath,
      releases: releases.length,
      added: summary.releasesWritten,
    });
    progress.labs[lab.id] = { done: [...doneSet], failed: [...failedSet] };
    saveProgress();
  }

  if (!dryRun) {
    writeProgress(rt.config.stateDir, progress);
    const usageNow = rt.openRouter?.stats();
    const perRun = usageNow ? delta(usageNow) : null;
    const run = rt.state.readRun();
    run.researcher = {
      ...run.researcher,
      version: rt.config.researcherVersion,
      // Set even on a budget-stopped run: the next weekly slot is a week away, and a stopped
      // run resumes from the progress file on whatever run happens next.
      last_backfill_at: now,
      ...(perRun
        ? {
            budget: {
              calls: perRun.calls,
              tokens_in: perRun.tokens_in,
              tokens_out: perRun.tokens_out,
              usd_estimate: Math.round(perRun.usd_estimate * 1_000_000) / 1_000_000,
            },
          }
        : {}),
    };
    rt.state.writeRun(run);
    log.info('openrouter usage (lifetime totals)', usageNow ? { ...usageNow } : {});

    // Commit the researcher's own output separately (pathspec `data/researched`) so the hourly
    // poll commit does not sweep untracked researcher files up with it.
    const touchedLabs = Object.keys(progress.labs);
    if (rt.config.gitPush && touchedLabs.length > 0 && dataDirty({ cwd: rt.config.repoRoot, log }, 'data/researched')) {
      const result = commitAndPush(
        { cwd: rt.config.repoRoot, log },
        `data(bot): backfill ${touchedLabs.slice(0, 4).join(',')}${touchedLabs.length > 4 ? `+${touchedLabs.length - 4}` : ''}`,
        'data/researched',
      );
      log.info('git', { ...result });
    }

    print(
      `backfill: ${summary.labs} lab(s), ${summary.candidates} candidate(s), ` +
        `${summary.releasesWritten} release(s) / ${summary.scoresWritten} score(s) written, ` +
        `${summary.llmCalls} LLM call(s)${usageText(perRun ?? undefined)}${summary.stoppedEarly ? ' — BUDGET STOPPED' : ''}`,
    );
  } else {
    print(
      `backfill --dry-run: ${summary.labs} lab(s), ${summary.candidates} candidate(s) in the plan — ` +
        `no pages fetched, no files written, no API key needed`,
    );
  }
  return summary.errors > 0 ? 1 : 0;
}

function usageText(usage: { usd_estimate: number } | undefined): string {
  return usage ? ` · ${usage.usd_estimate.toFixed(3)} USD est.` : '';
}

function byDate(a: { date: string; id: string }, b: { date: string; id: string }): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : a.id.localeCompare(b.id);
}

export async function runBackfill(rt: Runtime, opts: BackfillOptions = {}): Promise<number> {
  if (opts.dryRun) {
    // No network, no key: plan from the canned discovery fixture.
    const { labs, errors } = await planBackfill(rt, { ...opts, discoverImpl: opts.discoverImpl ?? DRY_RUN_DISCOVERY });
    const rows: string[][] = [];
    for (const { lab, candidates } of labs) {
      for (const c of candidates) {
        rows.push([lab.id, c.status, c.name, c.tier, c.date ?? '?', c.url]);
      }
    }
    print(formatPlan(rows));
    print('');
    print(
      `plan: ${rows.length} candidate(s) across ${labs.length} lab(s) — ` +
        `no pages fetched, no files written, no API key needed` +
        (errors.length ? `; ${errors.length} discovery error(s)` : ''),
    );
    return errors.length > 0 ? 1 : 0;
  }
  return runBackfillImpl(rt, opts);
}

function formatPlan(rows: string[][]): string {
  const headers = ['lab', 'status', 'name', 'tier', 'date', 'url'];
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? '').padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}
