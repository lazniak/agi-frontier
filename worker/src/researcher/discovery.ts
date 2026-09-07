/**
 * Step 1 of the researcher: ask an `:online` model (web search) for **every model a lab has
 * released** — several targeted queries (flagships by year since 2018, then mid/small tiers) —
 * then keep only candidates whose `launch_url` sits on an official host or an allow-listed
 * press host, canonicalise names, dedupe. Nothing here is trusted: discovery only proposes
 * pages; the numbers come later, from `extractFromPage` with its quote gate.
 */
import { z } from 'zod';
import type { Benchmark, Lab } from '@agi/shared';
import type { OpenRouterClient } from '../llm';
import { nameKey } from '../text';
import { hostMatches, isAllowedPress, officialHosts } from '../pipeline';
import type { Logger } from '../log';

/** The slice of the runtime discovery needs — a Runtime satisfies this structurally. */
export interface DiscoveryRuntime {
  openRouter: OpenRouterClient;
  log: Logger;
}

export const DISCOVERY_FIRST_YEAR = 2018;

export const DiscoveredModelSchema = z.object({
  name: z.string(),
  family: z.string().catch(''),
  tier: z.enum(['flagship', 'mid', 'small']).catch('flagship'),
  date: z.string().nullish(),
  launch_url: z.string(),
  confidence: z.number().min(0).max(1).catch(0.5),
});

export const DiscoveryResponseSchema = z.object({ models: z.array(DiscoveredModelSchema) });

export type DiscoveredModel = z.infer<typeof DiscoveredModelSchema>;

/** A candidate plus the provenance decision made by the host filter. */
export interface ScreenedCandidate extends DiscoveredModel {
  /** True when `launch_url` sits on the lab's own hosts (⇒ official extraction rules apply). */
  official: boolean;
}

/**
 * Apply the official/press host filter and dedupe by canonical name (highest confidence wins).
 * Exported for tests; `official: false` candidates are allow-listed press and must be extracted
 * with `forceStatus: 'rumored'` + `dropScores: true` downstream.
 */
export function screenCandidates(models: DiscoveredModel[], hosts: string[]): ScreenedCandidate[] {
  const byKey = new Map<string, ScreenedCandidate>();
  for (const m of models) {
    const official = hostMatches(m.launch_url, hosts);
    const press = !official && isAllowedPress(m.launch_url);
    if (!official && !press) continue;
    const key = nameKey(m.name);
    if (!key) continue;
    const candidate: ScreenedCandidate = { ...m, official };
    const previous = byKey.get(key);
    if (!previous || (m.confidence ?? 0) > (previous.confidence ?? 0)) byKey.set(key, candidate);
  }
  return [...byKey.values()];
}

export interface DiscoveryQuery {
  label: string;
  prompt: string;
}

/**
 * Flagships by year since 2018, then one mid/small sweep — each query narrow enough that the
 * model answers from search results instead of memory.
 */
export function buildDiscoveryQueries(lab: Lab, currentYear: number): DiscoveryQuery[] {
  const queries: DiscoveryQuery[] = [];
  for (let year = DISCOVERY_FIRST_YEAR; year <= currentYear; year++) {
    queries.push({
      label: `flagship ${year}`,
      prompt:
        `List every flagship large language model that ${lab.name} released or launched in ${year} ` +
        `(publicly available: API or product). Flagship = the lab's largest/best model of its generation ` +
        `(e.g. GPT-4, Claude Opus, Gemini Pro, Grok, Mistral Large, DeepSeek-V, Qwen Max, Kimi K, GLM). ` +
        `For each: the model name exactly as the lab writes it, its family, tier "flagship", the public ` +
        `launch date (YYYY-MM-DD or YYYY-MM), and the URL of the lab's own launch page or model card.`,
    });
  }
  queries.push({
    label: 'mid and small tiers',
    prompt:
      `List the mid-size and small models ${lab.name} has released (publicly available, not just announced): ` +
      `the Sonnet/Flash/mini-class "mid" tier (e.g. Claude Sonnet, Gemini Flash, GPT-4o mini, Qwen Plus, GLM Air) ` +
      `and the Haiku/Flash-Lite/nano-class "small" tier (e.g. Claude Haiku, Gemini Flash-Lite, Mistral Small). ` +
      `For each: the model name exactly as the lab writes it, its family, tier "mid" or "small", the public ` +
      `launch date (YYYY-MM-DD or YYYY-MM), and the URL of the lab's own launch page or model card.`,
  });
  return queries;
}

/**
 * The user prompt for one discovery query (REDESIGN §6.1: "list every model <lab> has released,
 * with tier and launch page URL"). `year` + `tier` pick which of the targeted queries to return;
 * `benchmarks` is accepted for prompt-context symmetry with the extraction prompt but the
 * discovery answer carries no scores, so it only contributes the basket size.
 */
export function buildModelListPrompt(
  lab: Lab,
  opts: { year: number; tier: 'flagship' | 'mid-small'; benchmarks?: Benchmark[] },
): string {
  void opts.benchmarks;
  if (opts.tier === 'flagship') {
    return buildDiscoveryQueries(lab, opts.year).find((q) => q.label === `flagship ${opts.year}`)!.prompt;
  }
  return buildDiscoveryQueries(lab, opts.year).at(-1)!.prompt;
}

export const DISCOVERY_SYSTEM_PROMPT =
  'You are a research assistant building an audited public dataset of LLM releases. ' +
  'Use web search. Only report models you can support with a URL on the lab\'s own domain (or its docs site). ' +
  'Never guess dates or invent models. Answer with JSON only, no commentary.';

export interface DiscoveryResult {
  candidates: DiscoveredModel[];
  /** Queries that failed outright (network/schema), for the log and the summary. */
  errors: string[];
  calls: number;
}

export interface DiscoverModelsOptions {
  onCall?: () => void;
  /** Stop cleanly when this fires; the partial list is still returned. */
  budgetExhausted?: () => boolean;
  /** Benchmark basket, passed through to the prompt builder for the mid/small sweep. */
  benchmarks?: Benchmark[];
}

/**
 * Run every discovery query for one lab, filter by official/press hosts, canonicalise and dedupe.
 * `dedupeAgainst` holds canonical keys (from `data/models`, earlier labs, the gold file) already
 * known — by default discovery still reports them, so callers decide what to skip.
 */
export async function discoverModels(
  rt: DiscoveryRuntime,
  lab: Lab,
  model: string,
  currentYear: number,
  opts: DiscoverModelsOptions = {},
): Promise<DiscoveryResult> {
  const log = rt.log.child({ lab: lab.id, step: 'discovery' });
  const hosts = officialHosts(lab);
  const collected: DiscoveredModel[] = [];
  const errors: string[] = [];
  let calls = 0;

  for (const query of buildDiscoveryQueries(lab, currentYear)) {
    if (opts.budgetExhausted?.()) {
      log.warn('budget exhausted — discovery stopped early', { label: query.label });
      break;
    }
    // The prompt for each targeted query comes from the shared builder (single source of truth).
    const year = Number.parseInt(query.label.replace('flagship ', ''), 10);
    const promptBody = buildModelListPrompt(
      lab,
      Number.isFinite(year) ? { year, tier: 'flagship' } : { year: currentYear, tier: 'mid-small', ...(opts.benchmarks ? { benchmarks: opts.benchmarks } : {}) },
    );
    let raw: unknown;
    try {
      const res = await rt.openRouter.chatJson({
        model,
        system: DISCOVERY_SYSTEM_PROMPT,
        user:
          `${promptBody}\n\nReturn JSON only, exactly this shape:\n` +
          `{"models":[{"name":"...","family":"...","tier":"flagship|mid|small","date":"YYYY-MM-DD or YYYY-MM or null","launch_url":"https://...","confidence":0.0-1.0}]}`,
        maxTokens: 4000,
      });
      calls++;
      opts.onCall?.();
      raw = res.json;
    } catch (e) {
      errors.push(`${query.label}: ${(e as Error).message}`);
      log.error('discovery query failed', { label: query.label, error: (e as Error).message });
      continue;
    }
    const parsed = DiscoveryResponseSchema.safeParse(raw);
    if (!parsed.success) {
      errors.push(`${query.label}: schema mismatch`);
      log.warn('discovery response did not match schema', {
        label: query.label,
        issues: parsed.error.issues.slice(0, 3).map((i) => i.path.join('.')),
      });
      continue;
    }
    for (const m of parsed.data.models) {
      const official = hostMatches(m.launch_url, hosts);
      const press = !official && isAllowedPress(m.launch_url);
      if (!official && !press) {
        log.debug('candidate dropped — unofficial host', { name: m.name, url: m.launch_url });
        continue;
      }
      collected.push(m);
    }
  }

  return { candidates: screenCandidates(collected, hosts), errors, calls };
}
