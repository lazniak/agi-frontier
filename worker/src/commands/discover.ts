/**
 * Once-a-day safety net for a lab page the poller cannot see (JS-only site, a launch posted
 * somewhere we do not poll). Asks an `:online` model what shipped recently, then throws the
 * answer away and re-derives everything from the primary page it points at.
 *
 * Nothing enters as `released` without a verified quote on the lab's own domain; allowlisted
 * press may only ever create a `rumored` entry, and never a score.
 */
import { z } from 'zod';
import type { Lab, LabId } from '@agi/shared';
import { formatIssues, readBenchmarks, readLabs } from '../data-store';
import { isoNow } from '../fetcher';
import { print } from '../log';
import { recordUsage, usageDelta } from '../state';
import {
  LabWorkspace,
  extractFromPage,
  hostMatches,
  isAllowedPress,
  itemDateOrToday,
  officialHosts,
  todayISO,
} from '../pipeline';
import { buildCommitMessage, commitAndPush, dataDirty } from '../git';
import { runBundle } from './bundle';
import type { Runtime } from '../runtime';

export const DISCOVER_WINDOW_DAYS = 45;

export const DiscoverItemSchema = z.object({
  name: z.string(),
  status: z.enum(['released', 'announced', 'rumored']).catch('rumored'),
  date: z.string().nullish(),
  url: z.string(),
  publisher: z.string().nullish(),
});

export const DiscoverResponseSchema = z.object({ items: z.array(DiscoverItemSchema) });

export type DiscoverItem = z.infer<typeof DiscoverItemSchema>;

export interface DiscoverOptions {
  lab?: LabId;
  dryRun?: boolean;
}

export function buildDiscoverPrompt(lab: Lab, today: string): string {
  return [
    `Which new flagship LLM did ${lab.name} release or officially announce in the last ${DISCOVER_WINDOW_DAYS} days as of ${today}?`,
    '',
    'Search the web. Only flagship/top-tier models — ignore mini, flash, lite, haiku, scout, air and non-text models.',
    'Prefer the lab\'s own announcement URL. If only press coverage exists, give the press URL and its publisher.',
    '',
    'Return JSON only, exactly this shape:',
    '{"items":[{"name":"...","status":"released|announced|rumored","date":"YYYY-MM-DD or null","url":"https://...","publisher":"domain or lab name"}]}',
    '',
    'An empty items array is correct when nothing new shipped.',
  ].join('\n');
}

export async function runDiscover(rt: Runtime, opts: DiscoverOptions = {}): Promise<number> {
  const dryRun = opts.dryRun === true;
  const now = isoNow();
  const today = todayISO();
  const labs = readLabs(rt.config.dataDir).filter((l) => !opts.lab || l.id === opts.lab);
  const benchmarks = readBenchmarks(rt.config.dataDir);
  const benchmarkIds = new Set(benchmarks.map((b) => b.id));

  if (!rt.openRouter) {
    rt.log.error('discover needs OPENROUTER_API_KEY');
    return 1;
  }

  let budget = rt.config.maxLlmCallsPerRun;
  let errors = 0;
  const touchedLabs: string[] = [];
  const summaries: string[] = [];
  // Snapshot for the per-run usage delta (the client is shared with poll and backfill).
  const usageAtStart = rt.openRouter.stats();

  for (const lab of labs) {
    const log = rt.log.child({ lab: lab.id });
    if (budget <= 0) {
      log.warn('LLM budget exhausted — discover stopped');
      break;
    }
    let items: DiscoverItem[];
    try {
      const res = await rt.openRouter.chatJson({
        model: rt.config.openRouterModelOnline,
        system: 'You are a research assistant. You answer with JSON only, no commentary.',
        user: buildDiscoverPrompt(lab, today),
        maxTokens: 2000,
      });
      budget--;
      const parsed = DiscoverResponseSchema.safeParse(res.json);
      if (!parsed.success) {
        log.warn('discover response did not match schema', { issues: formatIssues(parsed.error.issues, 3) });
        continue;
      }
      items = parsed.data.items;
    } catch (e) {
      errors++;
      log.error('discover query failed', { error: (e as Error).message });
      continue;
    }

    log.info('discover items', { count: items.length, names: items.map((i) => i.name) });
    if (dryRun) {
      for (const item of items) print(`${lab.id}  ${item.status.padEnd(9)}  ${item.name}  ${item.url}`);
      continue;
    }

    const hosts = officialHosts(lab);
    const workspace = new LabWorkspace(rt.config.dataDir, lab.id);

    for (const item of items) {
      if (budget <= 0) { log.warn('LLM budget exhausted mid-lab'); break; }
      const official = hostMatches(item.url, hosts);
      const press = !official && isAllowedPress(item.url);
      if (!official && !press) {
        log.info('discover item ignored — publisher not the lab and not allowlisted', { url: item.url, name: item.name });
        continue;
      }

      const page = await rt.fetcher(item.url, { minTextLength: 400 });
      if (!page.ok || page.text.length < 40) {
        errors++;
        log.warn('discover page unreadable', { url: item.url, status: page.status, error: page.error });
        continue;
      }

      try {
        const result = await extractFromPage({
          client: rt.openRouter,
          model: rt.config.openRouterModel,
          lab,
          benchmarks,
          benchmarkIds,
          today,
          page,
          fallbackDate: itemDateOrToday(item.date ?? undefined),
          log,
          ...(item.name ? { pageTitle: item.name } : {}),
          // Third-party reporting can never make something `released`, and never carries official numbers.
          ...(press ? { forceStatus: 'rumored' as const, dropScores: true } : {}),
        });
        budget--;
        workspace.merge(result.releases, {
          now,
          sourceUrl: page.url,
          ...(item.name ? { sourceTitle: item.name } : {}),
          ...(page.via ? { via: page.via } : {}),
        });
      } catch (e) {
        errors++;
        log.error('discover extraction failed', { url: item.url, error: (e as Error).message });
      }
    }

    const outcome = workspace.commit(log);
    if (outcome.restored) errors++;
    if (outcome.written) {
      touchedLabs.push(lab.id);
      summaries.push(`${lab.id}: discovered ${workspace.changes.length} change(s)`);
      for (const note of workspace.notes) log.info('merge', { note });
    }
  }

  if (dryRun) return 0;

  const run = rt.state.readRun();
  run.last_discover_at = now;
  // Discover is a research run: its delta becomes `budget` and joins the lifetime totals.
  recordUsage(run, usageDelta(rt.openRouter.stats(), usageAtStart), { research: true });
  rt.state.writeRun(run);

  if (touchedLabs.length > 0) {
    runBundle(rt, { quiet: true });
    if (rt.config.gitPush && dataDirty({ cwd: rt.config.repoRoot, log: rt.log })) {
      const result = commitAndPush(
        { cwd: rt.config.repoRoot, log: rt.log },
        buildCommitMessage(touchedLabs, summaries, 'discover: uncommitted data changes'),
      );
      rt.log.info('git', { ...result });
    }
  }

  rt.log.info('discover finished', { labs: labs.length, touched: touchedLabs.length, errors });
  return errors > 0 ? 1 : 0;
}
