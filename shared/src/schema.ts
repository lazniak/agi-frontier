import { z } from 'zod';

export const LAB_IDS = [
  'openai', 'anthropic', 'google', 'xai', 'meta',
  'deepseek', 'alibaba', 'moonshot', 'zhipu', 'mistral',
] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD expected');
const isoTs = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, 'ISO UTC timestamp expected');

export const SourceSchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
  quote: z.string().max(300).optional(),
  retrieved_at: isoTs,
  verified: z.boolean().optional(),
  verified_at: isoTs.optional(),
  via: z.string().optional(),
}).strict();

export const ScoreSchema = z.object({
  benchmark: z.string().min(1),
  value: z.number().min(0).max(100),
  config: z.string().optional(),
  note: z.string().optional(),
  reported_by: z.enum(['official', 'maintainer']),
  source: SourceSchema,
}).strict();

export const ReleaseStatusSchema = z.enum(['released', 'announced', 'rumored', 'cancelled']);
export const DatePrecisionSchema = z.enum(['day', 'month', 'quarter', 'year', 'unknown']);

export const ModelReleaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9.]+)+$/, 'slug like openai-gpt-5'),
  lab: z.enum(LAB_IDS),
  name: z.string().min(1),
  family: z.string().min(1),
  date: isoDate,
  date_precision: DatePrecisionSchema,
  status: ReleaseStatusSchema,
  expected_window: z.object({ start: isoDate, end: isoDate, source: SourceSchema }).strict().optional(),
  announcement: SourceSchema,
  sources: z.array(SourceSchema).optional(),
  scores: z.array(ScoreSchema),
  notes: z.string().optional(),
}).strict();

export const LabFileSchema = z.object({
  lab: z.enum(LAB_IDS),
  updated_at: isoTs,
  releases: z.array(ModelReleaseSchema),
}).strict().superRefine((file, ctx) => {
  const ids = new Set<string>();
  file.releases.forEach((r, i) => {
    if (r.lab !== file.lab) ctx.addIssue({ code: 'custom', path: ['releases', i, 'lab'], message: `release lab ${r.lab} != file lab ${file.lab}` });
    if (ids.has(r.id)) ctx.addIssue({ code: 'custom', path: ['releases', i, 'id'], message: `duplicate id ${r.id}` });
    ids.add(r.id);
    if (!r.id.startsWith(file.lab + '-')) ctx.addIssue({ code: 'custom', path: ['releases', i, 'id'], message: `id must start with "${file.lab}-"` });
    if (r.status === 'released' && r.date_precision === 'unknown') ctx.addIssue({ code: 'custom', path: ['releases', i, 'date_precision'], message: 'released models need a known date' });
    const seen = new Set<string>();
    r.scores.forEach((s, j) => {
      const key = s.benchmark + '|' + (s.config ?? '');
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['releases', i, 'scores', j], message: `duplicate score for ${key}` });
      seen.add(key);
    });
  });
});

export const LabSourceSchema = z.object({
  label: z.string(),
  url: z.string().url(),
  kind: z.enum(['rss', 'html', 'hf-org', 'json']),
}).strict();

export const LabSchema = z.object({
  id: z.enum(LAB_IDS),
  name: z.string(),
  short: z.string(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  color_note: z.string(),
  website: z.string().url(),
  sources: z.array(LabSourceSchema).min(1),
  flagship_hints: z.array(z.string()),
}).strict();

export const BenchmarkSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  name: z.string(),
  short: z.string(),
  description: z.string(),
  url: z.string().url(),
  unit: z.literal('%'),
  min: z.literal(0),
  max: z.literal(100),
  higher_is_better: z.literal(true),
  in_index: z.boolean(),
  legacy: z.boolean(),
  preferred_config: z.string(),
  human_baseline: z.number().nullable(),
  human_baseline_note: z.string().nullable(),
  introduced: z.number().int().min(2018).max(2030),
}).strict();

export const ChangeEventSchema = z.object({
  at: isoTs,
  actor: z.enum(['seed', 'worker', 'manual']),
  lab: z.enum(LAB_IDS),
  release_id: z.string(),
  kind: z.enum(['release_added', 'release_updated', 'score_added', 'score_updated', 'status_changed', 'verified']),
  summary: z.string(),
  source_url: z.string().url().optional(),
}).strict();

export const BundleSchema = z.object({
  generated_at: isoTs,
  version: z.literal(1),
  labs: z.array(LabSchema),
  benchmarks: z.array(BenchmarkSchema),
  releases: z.array(ModelReleaseSchema),
  recent_changes: z.array(ChangeEventSchema),
  worker: z.object({
    last_run_at: isoTs.nullable(),
    last_success_at: isoTs.nullable(),
    pages_polled: z.number().int(),
    pages_changed: z.number().int(),
    llm_model: z.string().nullable(),
  }).strict(),
}).strict();

/** Cross-file check: every score.benchmark must exist in benchmarks.json. */
export function findUnknownBenchmarks(
  releases: { scores: { benchmark: string }[] }[],
  benchmarkIds: Set<string>,
): string[] {
  const unknown = new Set<string>();
  for (const r of releases) for (const s of r.scores) if (!benchmarkIds.has(s.benchmark)) unknown.add(s.benchmark);
  return [...unknown].sort();
}
