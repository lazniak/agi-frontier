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
import { formatIssues } from '../data-store';
import { extractItems } from '../items';
import type { Fetcher } from '../fetcher';
import type { Logger } from '../log';

/* ------------------------------------------------------------ overview pages vs launch posts */

/**
 * Path shapes of model OVERVIEW pages: catalogues (`/models`, `/models/gemini/`), docs and
 * pricing. The first live run extracted "Opus 5" (0 scores) from a homepage and dropped three
 * Gemini/Grok models found on `/models/…` pages for "no usable date" — such pages list models
 * but never date a launch, so they are only mined for links to dated announcements
 * (REDESIGN §12.6). The bare homepage (`/`) is treated the same way for the same reason.
 */
export const OVERVIEW_PATH_RES: readonly RegExp[] = [/\/models?(\/|$)/i, /\/docs?\//i, /\/pricing/i];

export function isOverviewUrl(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  if (path === '' || path === '/') return true;
  return OVERVIEW_PATH_RES.some((re) => re.test(path));
}

/**
 * A URL that looks like a dated announcement: news/blog wording or a `YYYY/MM` / `YYYY-MM` date.
 * Tested against host + path — Google's launch posts live under `blog.google/technology/…`,
 * where the only "blog" is in the host.
 */
const ANNOUNCEMENT_RE = /news|blog|announc|introduc|release|launch|(^|[/-])20\d{2}[/-]\d{1,2}([/-]|$)/i;

export function isAnnouncementPath(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return ANNOUNCEMENT_RE.test(`${u.host}${u.pathname}`);
}

/**
 * Harvest same-host announcement links from an overview page: `href`s in the raw HTML plus
 * Markdown links and bare URLs in the text (the r.jina.ai reader returns Markdown, and a
 * cache hit carries no raw HTML at all). Relative links resolve against the page URL; hashes
 * are dropped; the page itself and other overview pages are excluded; order of appearance is
 * kept and the list is capped so one catalogue page cannot turn into a hundred fetches.
 */
export function collectAnnouncementLinks(
  page: { url: string; raw: string; text: string },
  hosts: string[],
  limit = 40,
): string[] {
  const found: string[] = [];
  const hrefRe = /href\s*=\s*["']([^"'\s>]+)["']/gi;
  for (const m of page.raw.matchAll(hrefRe)) if (m[1]) found.push(m[1]);
  const mdRe = /\]\((https?:\/\/[^)\s]+)\)/g;
  for (const m of page.text.matchAll(mdRe)) if (m[1]) found.push(m[1]);
  const bareRe = /https?:\/\/[^\s)<>"'\]]+/g;
  for (const m of page.text.matchAll(bareRe)) found.push(m[0]);

  const self = normaliseUrl(page.url);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of found) {
    let resolved: URL;
    try {
      resolved = new URL(raw, page.url);
    } catch {
      continue;
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
    resolved.hash = '';
    // The key only dedupes; the URL we hand on keeps its case and trailing slash — servers care.
    const url = resolved.toString();
    const key = normaliseUrl(url);
    if (key === self || seen.has(key)) continue;
    if (!hostMatches(url, hosts)) continue;
    if (!isAnnouncementPath(url) || isOverviewUrl(url)) continue;
    seen.add(key);
    out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}

function normaliseUrl(url: string): string {
  return url.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
}

/**
 * Whether a version token of the name ("4", "3.8") is spelled out by the path's own segments:
 * either fused into one segment ("…/gemini-38-flash/", "…/grok-46/") or written as consecutive
 * segments ("…/gemini-3-8-flash/").
 *
 * Whole segments, never a substring of the squashed path: "5" occurs inside
 * "/index/gpt-4o-2025-update/" and "4" inside "/news/grok-3-april-2024", so substring matching
 * scored GPT-5 and Grok 4 on posts announcing other models. On a catalogue page with no exact
 * link that enqueued up to MAX_OVERVIEW_LINKS wrong extractions, each costing an LLM call and
 * marking the real model failed-before for every later incremental run.
 */
function versionInPathSegments(token: string, segments: string[]): boolean {
  const parts = token.split('.').filter((p) => p.length > 0);
  if (parts.length === 0) return false;
  if (segments.includes(parts.join(''))) return true;
  if (parts.length < 2) return false;
  for (let i = 0; i + parts.length <= segments.length; i++) {
    if (parts.every((p, k) => segments[i + k] === p)) return true;
  }
  return false;
}

/**
 * How strongly a URL's path names the model: 2 when the whole canonical name key appears in the
 * path ("/news/claude-opus-5" for "Claude Opus 5"), 1 when every numeric token and at least one
 * word token do ("/blog/flash-3-8-is-here" for "Gemini 3.8 Flash"), 0 otherwise.
 */
export function linkNameScore(url: string, name: string): number {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return 0;
  }
  const pathKey = path.toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = nameKey(name).replace(/\./g, '');
  if (!key) return 0;
  if (pathKey.includes(key)) return 2;
  const segments = path.toLowerCase().split(/[^a-z0-9]+/).filter((s) => s.length > 0);
  const tokens = name.toLowerCase().split(/[^a-z0-9.]+/).filter((t) => t.length > 0);
  const numeric = tokens.filter((t) => /^[\d.]+$/.test(t) && /\d/.test(t));
  const words = tokens.filter((t) => !/^[\d.]+$/.test(t)).map((t) => t.replace(/\./g, '')).filter((t) => t.length >= 2);
  if (numeric.length === 0 || words.length === 0) return 0;
  const allNumeric = numeric.every((t) => versionInPathSegments(t, segments));
  const anyWord = words.some((t) => pathKey.includes(t));
  return allNumeric && anyWord ? 1 : 0;
}

/** Announcement links that name the model, best first; ties keep page order. */
export function rankLinksForName(links: string[], name: string, limit = 3): string[] {
  return links
    .map((url, i) => ({ url, i, score: linkNameScore(url, name) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.url);
}

/**
 * Whether a news-index title names *this* model rather than a newer sibling. The key must not be
 * followed by another digit or a version dot: "Introducing GPT-7.5" contains the key for "GPT-7",
 * and since the caller allows exactly one retry, a sibling post sitting earlier in the feed
 * hijacked it — the extraction returned "GPT-7.5", failed the name filter, and the real GPT-7
 * post further down was never tried.
 */
export function titleNamesModel(title: string, key: string): boolean {
  if (!key) return false;
  const haystack = nameKey(title);
  let from = 0;
  for (let i = haystack.indexOf(key, from); i >= 0; i = haystack.indexOf(key, from)) {
    const after = haystack[i + key.length];
    if (after === undefined || !/[0-9.]/.test(after)) return true;
    from = i + 1;
  }
  return false;
}

/**
 * The "no usable date" fallback: look the model up in the lab's own news index (its `rss` /
 * `html` sources from labs.json) and return the first item whose title names it. The launch
 * post found this way carries the date the overview page lacked. Fetches go through the shared
 * fetcher, so an index the hourly poll just read costs nothing.
 */
export async function findLaunchPostInNewsIndex(
  fetcher: Fetcher,
  lab: Lab,
  name: string,
  opts: { excludeUrls?: Set<string>; log?: Logger } = {},
): Promise<{ url: string; date?: string; title: string } | null> {
  const key = nameKey(name);
  if (!key) return null;
  for (const source of lab.sources) {
    if (source.kind !== 'rss' && source.kind !== 'html') continue;
    const page = await fetcher(source.url, { minTextLength: source.kind === 'html' ? 400 : 0 });
    if (!page.ok) {
      opts.log?.debug('news index unreadable during date retry', { url: source.url, status: page.status });
      continue;
    }
    for (const item of extractItems(source.kind, page, source.url)) {
      if (!item.link) continue;
      if (!titleNamesModel(item.title, key)) continue;
      if (opts.excludeUrls?.has(normaliseUrl(item.link))) continue;
      return { url: item.link, title: item.title, ...(item.date ? { date: item.date } : {}) };
    }
  }
  return null;
}

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
        issues: formatIssues(parsed.error.issues, 3),
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
