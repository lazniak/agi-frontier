/**
 * OpenRouter extraction: page text in, candidate flagship releases out.
 *
 * Two hard rules encoded here:
 *  - the model must return a verbatim quote for every date/status claim and every score;
 *  - {@link validateExtraction} throws all of that away again unless the quote is really a
 *    substring of the page we fetched. Nothing an LLM says reaches `data/` on trust alone.
 */
import { z } from 'zod';
import type { Benchmark, DatePrecision, ISODate, Lab, ReleaseStatus } from '@agi/shared';
import { quoteContainsValue, quoteMatches, truncate } from './text';

export const MAX_PAGE_CHARS = 60_000;
export const MAX_QUOTE_CHARS = 300;

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
          required: ['name', 'family', 'status', 'date', 'date_precision', 'announcement_quote', 'scores', 'notes'],
          properties: {
            name: { type: 'string', description: 'Model name exactly as the lab writes it, e.g. "GPT-5.1".' },
            family: { type: 'string', description: 'Lineage, e.g. "GPT", "Claude Opus", "Gemini Pro".' },
            status: { type: 'string', enum: ['released', 'announced', 'rumored'] },
            date: { type: ['string', 'null'], description: 'YYYY-MM-DD or YYYY-MM, null if the page gives none.' },
            date_precision: { type: 'string', enum: ['day', 'month', 'quarter', 'year', 'unknown'] },
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
                  value: { type: 'number', description: 'Percentage 0-100 as reported.' },
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
  const benchmarkLines = input.benchmarks.map(
    (b) => `- ${b.id} — ${b.name}${b.short && b.short !== b.name ? ` (${b.short})` : ''}; preferred config: ${b.preferred_config}`,
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
    '- `value` is a percentage 0-100 exactly as printed (80.9, not 0.809).',
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
      for (const s of raw.scores) {
        const benchmark = s.benchmark.trim();
        const sq = s.quote.trim();
        if (!opts.benchmarkIds.has(benchmark)) {
          dropped.push({ kind: 'score', name, benchmark, reason: 'benchmark not in basket' });
          continue;
        }
        if (!Number.isFinite(s.value) || s.value < 0 || s.value > 100) {
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

export interface OpenRouterOptions {
  apiKey: string;
  baseUrl: string;
  referer: string;
  title: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
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
}

export class OpenRouterError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

export class OpenRouterClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenRouterOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
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
    try {
      const content = await this.post(req, schemaFormat);
      return { json: parseJsonContent(content), content, usedJsonObjectFallback: false };
    } catch (e) {
      if (!req.jsonSchema || !isSchemaRejection(e)) throw e;
      const content = await this.post(req, { type: 'json_object' as const });
      return { json: parseJsonContent(content), content, usedJsonObjectFallback: true };
    }
  }

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
    if (!res.ok) throw new OpenRouterError(`chat/completions ${res.status}`, res.status, text);
    let body: {
      choices?: { message?: { content?: unknown } }[];
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
