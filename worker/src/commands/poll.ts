/**
 * The hourly job.
 *
 * fetch source -> extract items -> hash-diff against .state -> new items only ->
 * cheap candidate filter -> one LLM call per candidate page -> quote re-check ->
 * merge -> validate (rollback on failure) -> bundle -> state -> optional git push.
 *
 * Cost control, in order of effect: unchanged pages never reach the LLM; already-seen items
 * never reach the LLM; non-candidates never reach the LLM; MAX_LLM_CALLS_PER_RUN caps the rest.
 */
import type { Benchmark, Lab, LabId } from '@agi/shared';
import { readBenchmarks, readLabs } from '../data-store';
import { isoNow } from '../fetcher';
import { hashItems, extractItems, type SourceItem } from '../items';
import { compileHints, rankCandidates } from '../candidates';
import { diffSource, sourceKey, summariseRun, type HashState } from '../state';
import { LabWorkspace, extractFromPage, itemDateOrToday, todayISO } from '../pipeline';
import { commitAndPush, buildCommitMessage, dataDirty } from '../git';
import { print } from '../log';
import { runBundle } from './bundle';
import type { Runtime } from '../runtime';

export interface PollOptions {
  lab?: LabId;
  dryRun?: boolean;
}

export interface PollSummary {
  pagesPolled: number;
  pagesChanged: number;
  candidates: number;
  llmCalls: number;
  releasesAdded: number;
  changes: number;
  errors: number;
}

export async function runPoll(rt: Runtime, opts: PollOptions = {}): Promise<number> {
  const dryRun = opts.dryRun === true;
  const now = isoNow();
  const today = todayISO();
  const labs = readLabs(rt.config.dataDir).filter((l) => !opts.lab || l.id === opts.lab);
  const benchmarks = readBenchmarks(rt.config.dataDir);
  const benchmarkIds = new Set(benchmarks.map((b) => b.id));
  if (labs.length === 0) {
    rt.log.error('no labs selected', { lab: opts.lab });
    return 1;
  }

  await warnUnknownModel(rt, dryRun);

  // Snapshot for the per-run usage delta published in `researcher.budget`.
  const usageAtStart = rt.openRouter?.stats() ?? null;

  const hashes: HashState = dryRun ? {} : rt.state.readHashes();
  const summary: PollSummary = {
    pagesPolled: 0, pagesChanged: 0, candidates: 0, llmCalls: 0, releasesAdded: 0, changes: 0, errors: 0,
  };
  const dryRunRows: string[][] = [];
  const touchedLabs: string[] = [];
  const commitSummaries: string[] = [];
  let llmBudget = rt.config.maxLlmCallsPerRun;

  for (const lab of labs) {
    const log = rt.log.child({ lab: lab.id });
    const hints = compileHints(lab.flagship_hints);
    const workspace = new LabWorkspace(rt.config.dataDir, lab.id);

    for (const source of lab.sources) {
      const page = await rt.fetcher(source.url, { minTextLength: source.kind === 'html' ? 400 : 0 });
      summary.pagesPolled++;
      if (!page.ok) {
        summary.errors++;
        log.warn('source fetch failed', { url: source.url, status: page.status, error: page.error });
        if (dryRun) dryRunRows.push([lab.id, source.kind, shorten(source.url), 'FETCH FAILED', `status ${page.status}`]);
        continue;
      }

      const items = extractItems(source.kind, page, source.url);
      const hash = hashItems(items);
      const key = sourceKey(lab.id, source.url);
      const firstSight = hashes[key] === undefined;
      const diff = diffSource(hashes[key], hash, items.map((i) => i.key), now);
      hashes[key] = diff.next;

      // First time we see a source, everything on it is "new". Extracting all of it would
      // cost dozens of LLM calls to re-derive history we already hold; record the baseline
      // instead. Back-filling history is the seeding task's job, and `discover` catches
      // anything that shipped in the window we bootstrapped over.
      if (firstSight && !dryRun) {
        rt.log.child({ lab: lab.id }).info('source bootstrapped — baseline recorded, nothing extracted', {
          url: source.url, kind: source.kind, items: items.length, via: page.via,
        });
        continue;
      }

      if (!diff.changed && !dryRun) {
        log.info('source unchanged', { url: source.url, kind: source.kind, items: items.length, via: page.via });
        continue;
      }
      summary.pagesChanged++;
      log.info('source changed', {
        url: source.url, kind: source.kind, items: items.length, new_items: diff.newItems.length, via: page.via,
      });

      const fresh = new Set(diff.newItems);
      const newItems = items.filter((i) => fresh.has(i.key));
      const ranked = rankCandidates(newItems, hints);
      summary.candidates += ranked.length;
      for (const item of newItems) {
        if (!ranked.some((r) => r.item.key === item.key)) {
          log.debug('item ignored', { title: item.title, link: item.link });
        }
      }

      if (dryRun) {
        if (ranked.length === 0) {
          dryRunRows.push([lab.id, source.kind, shorten(source.url), `${items.length} items`, 'no candidates']);
        }
        for (const { item, reason } of ranked.slice(0, 12)) {
          dryRunRows.push([lab.id, source.kind, shorten(source.url), shorten(item.title, 60), reason]);
        }
        continue;
      }

      for (const { item, reason } of ranked) {
        if (llmBudget <= 0) {
          log.warn('LLM budget exhausted for this run', { max: rt.config.maxLlmCallsPerRun });
          break;
        }
        const handled = await handleCandidate(rt, {
          lab, benchmarks, benchmarkIds, today, now, item, reason, workspace, sourcePage: page, sourceUrl: source.url,
        });
        if (handled.calledLlm) {
          llmBudget--;
          summary.llmCalls++;
        }
        summary.releasesAdded += handled.added;
        if (handled.error) summary.errors++;
      }
    }

    if (dryRun) continue;
    const outcome = workspace.commit(log);
    if (outcome.restored) summary.errors++;
    if (outcome.written) {
      summary.changes += workspace.changes.length;
      touchedLabs.push(lab.id);
      commitSummaries.push(`${lab.id}: ${summariseNotes(workspace.notes)}`);
      for (const note of workspace.notes) log.info('merge', { note });
    }
  }

  if (dryRun) {
    print(formatDryRun(dryRunRows));
    print('');
    print(
      `dry-run: ${summary.pagesPolled} page(s) polled, ${summary.errors} fetch failure(s), ` +
        `${summary.candidates} candidate(s) — no files written, no LLM calls, no API key needed`,
    );
    return 0;
  }

  rt.state.writeHashes(hashes);
  const run = rt.state.readRun();
  run.last_run_at = now;
  run.pages_polled = summary.pagesPolled;
  run.pages_changed = summary.pagesChanged;
  run.llm_model = rt.config.openRouterModel;
  if (summary.errors === 0) run.last_success_at = now;
  // Per-run delta: the client is shared with the researcher commands, so subtract the snapshot
  // taken at run start; the lifetime totals stay in the log below.
  const statsAtStart = usageAtStart;
  const usage = rt.openRouter?.stats();
  const perRun = usage && statsAtStart
    ? {
        calls: usage.calls - statsAtStart.calls,
        tokens_in: usage.tokens_in - statsAtStart.tokens_in,
        tokens_out: usage.tokens_out - statsAtStart.tokens_out,
        usd_estimate: Math.round((usage.usd_estimate - statsAtStart.usd_estimate) * 1_000_000) / 1_000_000,
      }
    : null;
  if (perRun) {
    run.researcher = {
      ...run.researcher,
      version: rt.config.researcherVersion,
      budget: perRun,
    };
  }
  run.last_run_summary = summariseRun('poll', {
    pages: summary.pagesPolled,
    changed: summary.pagesChanged,
    'LLM calls': summary.llmCalls,
    'new releases': summary.releasesAdded,
    errors: summary.errors || undefined,
  }, perRun?.usd_estimate);
  rt.state.writeRun(run);
  rt.log.info('openrouter usage (lifetime totals)', usage ? { ...usage } : {});

  const bundleCode = runBundle(rt, { quiet: true });
  if (bundleCode !== 0) summary.errors++;

  maybePush(rt, touchedLabs, commitSummaries);

  rt.log.info('poll finished', { ...summary, fetcher: rt.fetcher.stats });
  return summary.errors > 0 ? 1 : 0;
}

interface CandidateInput {
  lab: Lab;
  benchmarks: Benchmark[];
  benchmarkIds: Set<string>;
  today: string;
  now: string;
  item: SourceItem;
  reason: string;
  workspace: LabWorkspace;
  sourcePage: { text: string; via?: string };
  sourceUrl: string;
}

async function handleCandidate(
  rt: Runtime,
  input: CandidateInput,
): Promise<{ calledLlm: boolean; added: number; error: boolean }> {
  const log = rt.log.child({ lab: input.lab.id });
  if (!rt.openRouter) {
    log.warn('OPENROUTER_API_KEY not set — candidate skipped', { title: input.item.title });
    return { calledLlm: false, added: 0, error: false };
  }
  const url = input.item.link ?? input.sourceUrl;
  const page = await rt.fetcher(url, { minTextLength: 400 });
  if (!page.ok || page.text.length < 40) {
    log.warn('candidate page unreadable', { url, status: page.status, error: page.error });
    return { calledLlm: false, added: 0, error: true };
  }

  log.info('extracting candidate', { url, title: input.item.title, reason: input.reason });
  try {
    const result = await extractFromPage({
      client: rt.openRouter,
      model: rt.config.openRouterModel,
      lab: input.lab,
      benchmarks: input.benchmarks,
      benchmarkIds: input.benchmarkIds,
      today: input.today,
      page,
      fallbackDate: itemDateOrToday(input.item.date),
      log,
      ...(input.item.title ? { pageTitle: input.item.title } : {}),
    });
    if (result.usedJsonObjectFallback) log.warn('model rejected json_schema — used json_object fallback', { url });
    if (result.releases.length === 0) {
      log.info('nothing extractable', { url, dropped: result.dropped.length });
      return { calledLlm: true, added: 0, error: false };
    }
    const before = input.workspace.file.releases.length;
    input.workspace.merge(result.releases, {
      now: input.now,
      sourceUrl: page.url,
      ...(input.item.title ? { sourceTitle: input.item.title } : {}),
      ...(page.via ? { via: page.via } : {}),
    });
    return { calledLlm: true, added: input.workspace.file.releases.length - before, error: false };
  } catch (e) {
    log.error('extraction failed', { url, error: (e as Error).message });
    return { calledLlm: true, added: 0, error: true };
  }
}

async function warnUnknownModel(rt: Runtime, dryRun: boolean): Promise<void> {
  if (dryRun || !rt.openRouter) return;
  try {
    const ids = await rt.openRouter.listModelIds();
    const base = rt.config.openRouterModel.replace(/:online$/, '');
    if (!ids.has(base)) {
      rt.log.warn('OPENROUTER_MODEL is not in the OpenRouter catalogue', { model: rt.config.openRouterModel });
    }
  } catch (e) {
    rt.log.warn('could not list OpenRouter models', { error: (e as Error).message });
  }
}

function maybePush(rt: Runtime, labs: string[], summaries: string[]): void {
  if (!rt.config.gitPush) return;
  if (!dataDirty({ cwd: rt.config.repoRoot, log: rt.log })) {
    rt.log.debug('nothing to commit under data/');
    return;
  }
  const message = buildCommitMessage(labs, summaries);
  const result = commitAndPush({ cwd: rt.config.repoRoot, log: rt.log }, message);
  rt.log.info('git', { ...result });
}

function summariseNotes(notes: string[]): string {
  const added = notes.filter((n) => n.startsWith('added ')).length;
  const scores = notes.filter((n) => n.includes(': +score ')).length;
  const status = notes.filter((n) => n.includes(': status ')).length;
  const parts: string[] = [];
  if (added) parts.push(`${added} release${added > 1 ? 's' : ''}`);
  if (scores) parts.push(`${scores} score${scores > 1 ? 's' : ''}`);
  if (status) parts.push(`${status} status change${status > 1 ? 's' : ''}`);
  return parts.length ? parts.join(', ') : 'update';
}

function shorten(s: string, max = 48): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function formatDryRun(rows: string[][]): string {
  const headers = ['lab', 'kind', 'source', 'candidate', 'why'];
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? '').padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}
