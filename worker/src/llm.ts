/**
 * OpenRouter extraction: page text in, candidate flagship releases out.
 *
 * Two hard rules encoded here:
 *  - the model must return a verbatim quote for every date/status claim and every score;
 *  - {@link validateExtraction} throws all of that away again unless the quote is really a
 *    substring of the page we fetched. Nothing an LLM says reaches `data/` on trust alone.
 */
import { z } from 'zod';
import type { Benchmark, DatePrecision, ISODate, Lab, ModelTier, ReleaseStatus } from '@agi/shared';
import { quoteContainsValue, quoteMatches, truncate } from './text';

export const MAX_PAGE_CHARS = 60_000;
export const MAX_QUOTE_CHARS = 300;

/** Raw tier the model answers with; `unknown` is resolved by `validateExtraction`. */
export const RAW_TIERS = ['flagship', 'mid', 'small', 'unknown'] as const;
export type RawTier = (typeof RAW_TIERS)[number];

export const ExtractedScoreSchema = z.object({
  benchmark: z.string(),
  value: z.number(),
  config: z.string().nullable(),
  quote: z.string(),
});

export const ExtractedReleaseSchema = z.object({
  name: z.string(),
  family: z.string(),
  status: z.enum(['released', 'announced', 'rumored']),
  date: z.string().nullable(),
  date_precision: z.enum(['day', 'month', 'quarter', 'year', 'unknown']),
  // `catch` keeps old / malformed responses parsing: a missing or nonsense tier degrades to
  // `unknown`, which validateExtraction resolves from the lab's flagship hints.
  tier: z.enum(RAW_TIERS).catch('unknown'),
  announcement_quote: z.string(),
  scores: z.array(ExtractedScoreSchema),
  notes: z.string().nullable(),
});

export const ExtractionSchema = z.object({ releases: z.array(ExtractedReleaseSchema) });

export type ExtractedRelease = z.infer<typeof ExtractedReleaseSchema>;
export type Extraction = z.infer<typeof ExtractionSchema>;

/** JSON schema handed to OpenRouter (`strict`: every key required, no extra keys). */
export const EXTRACTION_JSON_SCHEMA = {
  name: 'flagship_releases',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['releases'],
    properties: {
      releases: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'family', 'status', 'date', 'date_precision', 'tier', 'announcement_quote', 'scores', 'notes'],
          properties: {
            name: { type: 'string', description: 'Model name exactly as the lab writes it, e.g. "GPT-5.1".' },
            family: { type: 'string', description: 'Lineage, e.g. "GPT", "Claude Opus", "Gemini Pro".' },
            status: { type: 'string', enum: ['released', 'announced', 'rumored'] },
            date: { type: ['string', 'null'], description: 'YYYY-MM-DD or YYYY-MM, null if the page gives none.' },
            date_precision: { type: 'string', enum: ['day', 'month', 'quarter', 'year', 'unknown'] },
            tier: {
              type: 'string',
              enum: [...RAW_TIERS],
              description:
                'flagship = the lab\'s largest/best model of this generation; mid = Sonnet/Flash/mini-class; ' +
                'small = Haiku/Flash-Lite/nano-class; unknown when the page gives no size signal.',
            },
            announcement_quote: {
              type: 'string',
              description: 'Verbatim sentence from the page (<=300 chars) proving the status and date.',
            },
            scores: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['benchmark', 'value', 'config', 'quote'],
                properties: {
                  benchmark: { type: 'string', description: 'One of the benchmark ids given in the prompt.' },
                  value: {
                    type: 'number',
                    description:
                      'Exactly as printed: a percentage 0-100 for percentage benchmarks, the Elo rating itself for Elo benchmarks.',
                  },
                  config: { type: ['string', 'null'], description: 'Evaluation configuration as written on the page.' },
                  quote: { type: 'string', description: 'Verbatim snippet (<=300 chars) containing this number.' },
                },
              },
            },
            notes: { type: ['string', 'null'] },
          },
        },
      },
    },
  },
} as const;

const FLAGSHIP_DEFINITION =
  'Flagship = the lab\'s top capability tier at launch (GPT-5, Claude Opus/Fable, Gemini Pro/Ultra, ' +
  'Grok N, the largest public Llama, DeepSeek-V/R, Qwen Max, Kimi K, GLM-N, Mistral Large). ' +
  'Smaller tiers are NOT flagships: mini, nano, flash, flash-lite, lite, haiku, scout, air, small, ' +
  'turbo, embedding, image/video/audio-only and open-weight distillations of a bigger model.';

export interface PromptInput {
  lab: Lab;
  today: ISODate;
  benchmarks: Benchmark[];
  pageUrl: string;
  pageTitle?: string;
  pageText: string;
}

export function buildSystemPrompt(): string {
  return [
    'You extract flagship large-language-model releases from a single web page for an audited, public dataset.',
    'You never infer, never use prior knowledge, and never paraphrase evidence.',
    'Every claim you output must be supported by a VERBATIM quote copied character-for-character from the page text provided.',
    'If the page does not clearly support a claim, omit it. An empty `releases` array is a perfectly good answer.',
  ].join(' ');
}

export function buildUserPrompt(input: PromptInput): string {
  // Community benchmarks (LMArena) are maintainer-only (user decision 2026-09-07): a lab page
  // never reports them officially, so they are not even offered in the basket.
  const benchmarkLines = input.benchmarks
    .filter((b) => b.community !== true)
    .map((b) =>
      `- ${b.id} — ${b.name}${b.short && b.short !== b.name ? ` (${b.short})` : ''}; unit: ${
        b.unit === 'elo' ? `Elo rating (~1200 typical, reference ${b.elo_reference ?? 'n/a'})` : 'percentage 0-100'
      }${b.preferred_config ? `; preferred config: ${b.preferred_config}` : ''}${b.description ? `; ${b.description}` : ''}`,
    );
  return [
    `LAB: ${input.lab.name} (id: ${input.lab.id}, site: ${input.lab.website})`,
    `TODAY: ${input.today}`,
    `PAGE URL: ${input.pageUrl}`,
    input.pageTitle ? `PAGE TITLE: ${input.pageTitle}` : '',
    '',
    'FLAGSHIP DEFINITION',
    FLAGSHIP_DEFINITION,
    '',
    'TIER RULES (fill `tier` for every release)',
    '- "flagship": the lab\'s largest / best model of that generation (GPT-5, Claude Opus, Gemini Pro, Grok, Mistral Large).',
    '- "mid": mid-size workhorse tier (Claude Sonnet, Gemini Flash, GPT mini-class, Qwen Plus, GLM Air).',
    '- "small": smallest tier (Claude Haiku, Gemini Flash-Lite, nano-class, small open-weight models).',
    '- "unknown": the page gives no size signal. We will resolve it from the model name.',
    '',
    'SCORE RULES FOR ELO BENCHMARKS: `value` is the Elo rating exactly as printed (e.g. 1450), not a percentage.',
    'AVAILABILITY RULES (decide `status` from the page wording only)',
    '- status "released": the model is publicly usable NOW — wording like "available today", ' +
      '"is now available", "rolling out to", "now in the API", "generally available", "you can try it today".',
    '- status "announced": confirmed by the lab but not usable yet — "coming in the next few weeks", ' +
      '"coming soon", "preview for select partners", "waitlist", "early access for trusted testers".',
    '- status "rumored": the page is not the lab itself and only reports what the lab is said to be doing.',
    '- Do NOT output a release the page does not actually announce (roadmaps, comparisons, mentions of older models).',
    '',
    'BENCHMARK BASKET (use these ids only; ignore every other benchmark on the page)',
    ...benchmarkLines,
    '',
    'SCORE RULES',
    '- For percentage benchmarks `value` is exactly as printed (80.9, not 0.809). For Elo benchmarks it is the rating number itself.',
    '- `config` is the evaluation configuration as written on the page (e.g. "no tools", "extended thinking", ' +
      '"AIME 2025", "pass@1"); null when the page states none.',
    '- Only scores for the model being released, reported by the lab on this page.',
    `- \`quote\` must contain the number and be at most ${MAX_QUOTE_CHARS} characters, copied verbatim.`,
    '',
    'DATE RULES',
    '- `date` is the public launch date: YYYY-MM-DD when the page gives a day, YYYY-MM when only a month, null when neither.',
    '- `date_precision` must match what the page supports. Never guess a day.',
    `- \`announcement_quote\` proves the status and the date; verbatim, at most ${MAX_QUOTE_CHARS} characters.`,
    '',
    'Return JSON only, matching the schema. No commentary.',
    '',
    '===== PAGE TEXT START =====',
    truncate(input.pageText, MAX_PAGE_CHARS),
    '===== PAGE TEXT END =====',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/* ------------------------------------------------------------------ post-validation */

export interface NormalisedScore {
  benchmark: string;
  value: number;
  config?: string;
  quote: string;
}

export interface NormalisedRelease {
  name: string;
  family: string;
  status: ReleaseStatus;
  date: ISODate;
  date_precision: DatePrecision;
  /** Set only when known explicitly (or hint-matched); unset = flagship by contract. */
  tier?: ModelTier | undefined;
  announcement_quote: string;
  scores: NormalisedScore[];
  notes?: string;
}

export interface DropInfo {
  kind: 'release' | 'score';
  name: string;
  benchmark?: string;
  reason: string;
}

export interface ValidateExtractionOptions {
  pageText: string;
  benchmarkIds: Set<string>;
  today: ISODate;
  /** Date used for announced/rumored releases whose page gives no date (usually the item date). */
  fallbackDate: ISODate;
  /** Force every release to this status (used by `discover` for third-party press). */
  forceStatus?: ReleaseStatus;
  /** Drop all scores (press pages never carry official numbers). */
  dropScores?: boolean;
  /** Range check per benchmark unit; required for scores (defaults kept for backward compat). */
  benchmarks?: Benchmark[];
  /** Regexes from the lab's `flagship_hints` — an `unknown` tier matching one resolves to flagship. */
  flagshipHints?: RegExp[];
}

/**
 * Resolve the model's raw tier answer. Explicit tiers pass through. `unknown` (or nonsense)
 * maps to `flagship` only when the name matches one of the lab's flagship hints; otherwise it
 * resolves to `undefined` — leave unset, because unset = flagship by contract and a wrong `mid`
 * would demote a real flagship.
 */
export function resolveTier(raw: string | null | undefined, name: string, hints: RegExp[]): ModelTier | undefined {
  if (raw === 'flagship' || raw === 'mid' || raw === 'small') return raw;
  const n = name.toLowerCase();
  const hinted = hints.some((re) => { try { return re.test(n); } catch { return false; } });
  return hinted ? 'flagship' : undefined;
}

/** True when the score sits inside its benchmark's declared range (unit-aware). */
export function scoreInRange(
  benchmark: string,
  value: number,
  benchmarks: Benchmark[] | undefined,
  benchmarkIds: Set<string>,
): boolean {
  if (!Number.isFinite(value)) return false;
  const b = benchmarks?.find((x) => x.id === benchmark);
  if (b) return value >= b.min && value <= b.max;
  // No unit table available: fall back to the historical 0-100 percentage range.
  return benchmarkIds.has(benchmark) && value >= 0 && value <= 100;
}

const PRECISION_RANK: Record<DatePrecision, number> = { unknown: 0, year: 1, quarter: 2, month: 3, day: 4 };

/**
 * Everything the LLM produced is re-checked against the page we actually fetched.
 * A release without a matching announcement quote is dropped; a score whose quote does not
 * match the page, or does not contain its own number, is dropped.
 */
export function validateExtraction(
  extraction: Extraction,
  opts: ValidateExtractionOptions,
): { releases: NormalisedRelease[]; dropped: DropInfo[] } {
  const dropped: DropInfo[] = [];
  const releases: NormalisedRelease[] = [];
  const seenNames = new Set<string>();

  for (const raw of extraction.releases) {
    const name = raw.name.trim();
    if (!name) { dropped.push({ kind: 'release', name: raw.name, reason: 'empty name' }); continue; }
    if (seenNames.has(name.toLowerCase())) { dropped.push({ kind: 'release', name, reason: 'duplicate in response' }); continue; }

    const quote = raw.announcement_quote.trim();
    if (quote.length > MAX_QUOTE_CHARS) { dropped.push({ kind: 'release', name, reason: `announcement quote > ${MAX_QUOTE_CHARS} chars` }); continue; }
    if (!quoteMatches(opts.pageText, quote)) { dropped.push({ kind: 'release', name, reason: 'announcement quote not found on page' }); continue; }

    const status = opts.forceStatus ?? raw.status;
    const resolved = resolveDate(raw.date, raw.date_precision, status, opts);
    if (!resolved) { dropped.push({ kind: 'release', name, reason: 'no usable date' }); continue; }
    if (status === 'released' && resolved.date > opts.today) {
      dropped.push({ kind: 'release', name, reason: `released date ${resolved.date} is in the future` });
      continue;
    }

    const scores: NormalisedScore[] = [];
    const seenScoreKeys = new Set<string>();
    if (!opts.dropScores) {
      const community = new Set((opts.benchmarks ?? []).filter((b) => b.community === true).map((b) => b.id));
      for (const s of raw.scores) {
        const benchmark = s.benchmark.trim();
        const sq = s.quote.trim();
        if (!opts.benchmarkIds.has(benchmark)) {
          dropped.push({ kind: 'score', name, benchmark, reason: 'benchmark not in basket' });
          continue;
        }
        // LMArena and friends: maintainer-only provenance (user decision) — a lab post saying
        // "tops LMArena at 1462" must never become an `official` score.
        if (community.has(benchmark)) {
          dropped.push({ kind: 'score', name, benchmark, reason: 'community benchmark — maintainer only' });
          continue;
        }
        if (!scoreInRange(benchmark, s.value, opts.benchmarks, opts.benchmarkIds)) {
          dropped.push({ kind: 'score', name, benchmark, reason: `value out of range (${s.value})` });
          continue;
        }
        if (sq.length > MAX_QUOTE_CHARS) {
          dropped.push({ kind: 'score', name, benchmark, reason: `quote > ${MAX_QUOTE_CHARS} chars` });
          continue;
        }
        if (!quoteMatches(opts.pageText, sq)) {
          dropped.push({ kind: 'score', name, benchmark, reason: 'quote not found on page' });
          continue;
        }
        if (!quoteContainsValue(sq, s.value)) {
          dropped.push({ kind: 'score', name, benchmark, reason: `quote does not contain the value ${s.value}` });
          continue;
        }
        const config = s.config?.trim() ?? '';
        const key = `${benchmark}|${config}`;
        if (seenScoreKeys.has(key)) {
          dropped.push({ kind: 'score', name, benchmark, reason: 'duplicate benchmark+config in response' });
          continue;
        }
        seenScoreKeys.add(key);
        const score: NormalisedScore = { benchmark, value: s.value, quote: sq };
        if (config) score.config = config;
        scores.push(score);
      }
    }

    seenNames.add(name.toLowerCase());
    const release: NormalisedRelease = {
      name,
      family: raw.family.trim() || name,
      status,
      date: resolved.date,
      date_precision: resolved.precision,
      tier: resolveTier(raw.tier, name, opts.flagshipHints ?? []),
      announcement_quote: quote,
      scores,
    };
    const notes = raw.notes?.trim();
    if (notes) release.notes = notes;
    releases.push(release);
  }

  return { releases, dropped };
}

function resolveDate(
  raw: string | null,
  precision: DatePrecision,
  status: ReleaseStatus,
  opts: ValidateExtractionOptions,
): { date: ISODate; precision: DatePrecision } | null {
  const value = raw?.trim() ?? '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { date: value, precision: precision === 'unknown' ? 'day' : precision };
  }
  if (/^\d{4}-\d{2}$/.test(value)) {
    const capped: DatePrecision = PRECISION_RANK[precision] > PRECISION_RANK.month ? 'month' : precision;
    return { date: `${value}-01`, precision: capped === 'unknown' ? 'month' : capped };
  }
  if (/^\d{4}$/.test(value)) return { date: `${value}-01-01`, precision: 'year' };
  // No date on the page: acceptable for announced/rumored (we record when we saw it), never for released.
  if (status === 'released') return null;
  return { date: opts.fallbackDate, precision: 'unknown' };
}

/* ------------------------------------------------------------------ OpenRouter client */

/** HTTP statuses worth another attempt (rate limits + transient upstream failures). */
export const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export const RETRY_BASE_DELAY_MS = 2_000;
export const RETRY_MAX_DELAY_MS = 60_000;
/** ±25 % jitter around the computed delay. */
export const RETRY_JITTER_FRACTION = 0.25;

export interface RetryOptions {
  attempt: number;
  /** `Retry-After` header value in milliseconds (already parsed), when the server sent one. */
  retryAfterMs?: number | null;
  random?: () => number;
  baseMs?: number;
  maxMs?: number;
}

/**
 * Pure backoff schedule: `base * 2^attempt`, capped, ±25 % jitter; a `Retry-After` larger than
 * the computed delay wins. Deterministic for a given `random`.
 */
export function retryDelayMs(attempt: number, retryAfterMs: number | null = null, random: () => number = Math.random, baseMs: number = RETRY_BASE_DELAY_MS, maxMs: number = RETRY_MAX_DELAY_MS): number {
  const exponential = Math.min(baseMs * Math.pow(2, Math.max(0, attempt)), maxMs);
  const jitter = 1 + (2 * random() - 1) * RETRY_JITTER_FRACTION;
  const backoff = exponential * jitter;
  return Math.round(Math.max(retryAfterMs ?? 0, Math.min(backoff, maxMs * (1 + RETRY_JITTER_FRACTION))));
}

/**
 * `withRetry`: run `fn`, retrying on retryable {@link OpenRouterError} statuses (429/5xx) and on
 * any thrown/aborted network error, up to `maxAttempts` tries in total. A non-retryable
 * `OpenRouterError` (401/402/400 …) rethrows immediately — retrying an auth error only burns
 * time. Sleeps the computed delay between attempts; rethrows the last error when exhausted.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: {
    maxAttempts?: number;
    sleepImpl?: (ms: number) => Promise<void>;
    random?: () => number;
    onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  } = {},
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 6);
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastError = e;
      // A hard HTTP error (401, 402, 400, …) will not get better by waiting.
      if (e instanceof OpenRouterError && !RETRYABLE_STATUSES.has(e.status)) throw e;
      if (attempt === maxAttempts - 1) break;
      const retryAfterMs = e instanceof OpenRouterError ? parseRetryAfter(e.retryAfter) : null;
      const delay = retryDelayMs(attempt, retryAfterMs, opts.random);
      opts.onRetry?.(attempt, delay, e);
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * `Retry-After` header value in seconds (`120`) or as an HTTP-date; null when absent/unparseable.
 */
export function parseRetryAfter(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;
  const t = Date.parse(trimmed);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
}

/**
 * Counting semaphore bounding concurrent in-flight async work (RESEARCH_CONCURRENCY).
 */
export class Semaphore {
  private inFlight = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isFinite(limit) || limit < 1) throw new Error(`Semaphore limit must be >= 1, got ${limit}`);
  }

  get pending(): number {
    return this.inFlight;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  async acquire(): Promise<() => void> {
    if (this.inFlight < this.limit) {
      this.inFlight++;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    // `release()` handed its slot straight to this waiter (see below) — the count already
    // accounts for us, so there is nothing to increment here.
    return () => this.release();
  }

  /** Run `fn` holding one slot; the slot is released even when `fn` throws. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Transfer the slot to the waiter instead of decrement+re-increment: between those two
      // steps another acquire() could slip in and push `pending` past the limit.
      next();
      return;
    }
    this.inFlight = Math.max(0, this.inFlight - 1);
  }
}

/** USD price per 1M tokens, in and out. */
export interface ModelPrice {
  inPerM: number;
  outPerM: number;
  /** Flat surcharge per call — the `:online` web-search plugin. */
  perCall?: number;
}

/** Known prices; everything unknown is free (0) so an estimate never overstates. */
export const PRICE_TABLE: Record<string, ModelPrice> = {
  'google/gemini-3.1-flash-lite': { inPerM: 0.25, outPerM: 1.0 },
  'google/gemini-3.1-flash-lite:online': { inPerM: 0.25, outPerM: 1.0, perCall: 0.02 },
};

export interface PriceOverrides {
  /** USD per 1M input tokens (OPENROUTER_PRICE_IN). */
  inPerM?: number;
  /** USD per 1M output tokens (OPENROUTER_PRICE_OUT). */
  outPerM?: number;
}

export function priceFor(model: string, overrides: PriceOverrides = {}): ModelPrice {
  const known = PRICE_TABLE[model] ?? { inPerM: 0, outPerM: 0 };
  const price: ModelPrice = {
    inPerM: overrides.inPerM ?? known.inPerM,
    outPerM: overrides.outPerM ?? known.outPerM,
  };
  if (known.perCall !== undefined) price.perCall = known.perCall;
  return price;
}

export function estimateUsd(price: ModelPrice, tokensIn: number, tokensOut: number): number {
  return (tokensIn / 1_000_000) * price.inPerM + (tokensOut / 1_000_000) * price.outPerM + (price.perCall ?? 0);
}

export interface UsageStats {
  calls: number;
  tokens_in: number;
  tokens_out: number;
  usd_estimate: number;
}

export interface OpenRouterOptions {
  apiKey: string;
  baseUrl: string;
  referer: string;
  title: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Max concurrent in-flight requests (RESEARCH_CONCURRENCY). Default 2. */
  concurrency?: number;
  /** Retries per request. Default 6. */
  maxAttempts?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  random?: () => number;
  priceOverrides?: PriceOverrides;
  /** Warn log for retries (status only). */
  log?: import('./log').Logger;
}

export interface ChatJsonRequest {
  model: string;
  system: string;
  user: string;
  jsonSchema?: typeof EXTRACTION_JSON_SCHEMA;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatJsonResult {
  json: unknown;
  content: string;
  /** True when the model rejected `json_schema` and we fell back to `json_object`. */
  usedJsonObjectFallback: boolean;
  /** Tokens billed for this call, when the response carried usage. */
  usage?: { tokens_in: number; tokens_out: number };
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    readonly retryAfter: string | null = null,
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

export class OpenRouterClient {
  private readonly fetchImpl: typeof fetch;
  /** Read-only access for callers that want to bound their own work with the same limit. */
  readonly semaphore: Semaphore;
  private readonly maxAttempts: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly totals: UsageStats = { calls: 0, tokens_in: 0, tokens_out: 0, usd_estimate: 0 };
  private readonly prices: PriceOverrides;

  constructor(private readonly opts: OpenRouterOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.semaphore = new Semaphore(opts.concurrency ?? 2);
    this.maxAttempts = opts.maxAttempts ?? 6;
    this.sleepImpl = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.prices = opts.priceOverrides ?? {};
  }

  /** Running totals for the run — a copy, so callers cannot mutate the client's books. */
  stats(): UsageStats {
    return { ...this.totals };
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.opts.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': this.opts.referer,
      'X-Title': this.opts.title,
    };
  }

  /** Startup sanity check: warn when the configured model id is not on OpenRouter. */
  async listModelIds(): Promise<Set<string>> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}/models`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
    });
    if (!res.ok) throw new OpenRouterError(`GET /models failed`, res.status, await res.text());
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    const ids = new Set<string>();
    for (const m of body.data ?? []) if (typeof m.id === 'string') ids.add(m.id);
    return ids;
  }

  async chatJson(req: ChatJsonRequest): Promise<ChatJsonResult> {
    const schemaFormat = req.jsonSchema
      ? { type: 'json_schema' as const, json_schema: req.jsonSchema }
      : { type: 'json_object' as const };
    const result = await this.semaphore.run(() =>
      withRetry(
        () => this.attemptPost(req, schemaFormat),
        {
          maxAttempts: this.maxAttempts,
          sleepImpl: this.sleepImpl,
          random: this.random,
          onRetry: (attempt, delayMs, error) => {
            // Status only, never the body — bodies can echo prompt content.
            const status = error instanceof OpenRouterError ? error.status : undefined;
            this.opts.log?.warn('openrouter retry', { attempt, delay_ms: delayMs, ...(status !== undefined ? { status } : {}) });
          },
        },
      ),
    );
    // Every completed call counts, even when the response carried no usage block.
    this.totals.calls++;
    if (result.usage) {
      this.totals.tokens_in += result.usage.tokens_in;
      this.totals.tokens_out += result.usage.tokens_out;
      this.totals.usd_estimate += estimateUsd(priceFor(req.model, this.prices), result.usage.tokens_in, result.usage.tokens_out);
    }
    return result;
  }

  private async attemptPost(
    req: ChatJsonRequest,
    schemaFormat: { type: 'json_schema' | 'json_object'; json_schema?: typeof EXTRACTION_JSON_SCHEMA },
  ): Promise<ChatJsonResult> {
    try {
      const content = await this.post(req, schemaFormat);
      return this.finish(req, content, false);
    } catch (e) {
      if (!req.jsonSchema || !isSchemaRejection(e)) throw e;
      const content = await this.post(req, { type: 'json_object' as const });
      return this.finish(req, content, true);
    }
  }

  /** Parse the content, pull the usage `post()` stashed, and book it on this call's result. */
  private finish(_req: ChatJsonRequest, content: string, usedJsonObjectFallback: boolean): ChatJsonResult {
    const usage = this.lastCallUsage ?? undefined;
    this.lastCallUsage = null;
    return {
      json: parseJsonContent(content),
      content,
      usedJsonObjectFallback,
      ...(usage ? { usage } : {}),
    };
  }

  private lastCallUsage: { tokens_in: number; tokens_out: number } | null = null;

  private async post(req: ChatJsonRequest, responseFormat: unknown): Promise<string> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
      body: JSON.stringify({
        model: req.model,
        temperature: req.temperature ?? 0,
        max_tokens: req.maxTokens ?? 8000,
        response_format: responseFormat,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new OpenRouterError(`chat/completions ${res.status}`, res.status, text, res.headers.get('retry-after'));
    }
    let body: {
      choices?: { message?: { content?: unknown } }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      error?: { message?: string; code?: number };
    };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new OpenRouterError('chat/completions returned non-JSON', res.status, text);
    }
    if (body.error) throw new OpenRouterError(body.error.message ?? 'OpenRouter error', body.error.code ?? 500, text);
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new OpenRouterError('chat/completions returned no content', res.status, text);
    }
    const pin = typeof body.usage?.prompt_tokens === 'number' ? body.usage.prompt_tokens : 0;
    const pout = typeof body.usage?.completion_tokens === 'number' ? body.usage.completion_tokens : 0;
    this.lastCallUsage = pin || pout ? { tokens_in: pin, tokens_out: pout } : null;
    return content;
  }
}

function isSchemaRejection(e: unknown): boolean {
  if (!(e instanceof OpenRouterError)) return false;
  if (e.status === 400 || e.status === 404 || e.status === 415 || e.status === 422) return true;
  return /json[_ ]schema|response_format|structured output/i.test(e.body);
}

/** Models sometimes wrap JSON in a fenced block despite `response_format`. */
export function parseJsonContent(content: string): unknown {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(body);
  } catch {
    const first = body.indexOf('{');
    const last = body.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(body.slice(first, last + 1));
    throw new Error('LLM response is not JSON');
  }
}
