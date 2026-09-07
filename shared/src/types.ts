/**
 * AGI Frontier — data contract.
 *
 * Every file under `data/` MUST conform to these types (validated by `schema.ts`).
 * These types are shared verbatim by the worker (writer) and the web app (reader).
 * Changing them = changing the public audit format → update docs/METHODOLOGY.md too.
 */

/** ISO date `YYYY-MM-DD`. */
export type ISODate = string;
/** ISO timestamp `YYYY-MM-DDTHH:mm:ssZ`. */
export type ISOTimestamp = string;

export type LabId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'meta'
  | 'deepseek'
  | 'alibaba'
  | 'moonshot'
  | 'zhipu'
  | 'mistral';

export interface LabSource {
  /** Human label, e.g. "News", "Model cards", "Hugging Face org". */
  label: string;
  url: string;
  /** How the worker reads it. `rss` preferred when available. */
  kind: 'rss' | 'html' | 'hf-org' | 'json';
}

export interface Lab {
  id: LabId;
  name: string;
  /** Short display name for chart labels. */
  short: string;
  /** Brand colour used for this lab's line. `color_note` says whether it is official or approximate. */
  color: string;
  color_note: string;
  website: string;
  /** Pages the hourly worker polls for new flagship releases. */
  sources: LabSource[];
  /** Name patterns that identify the flagship tier (regex, case-insensitive). Hints for the LLM extractor, never the sole filter. */
  flagship_hints: string[];
}

export interface Benchmark {
  id: string;
  name: string;
  short: string;
  /** What the benchmark measures, one sentence, for the audit drawer. */
  description: string;
  url: string;
  /** All index benchmarks are percentages 0–100, higher is better. Kept explicit for auditability. */
  unit: '%';
  min: 0;
  max: 100;
  higher_is_better: true;
  /** Included in the Frontier Index fit. Non-index benchmarks are still recorded and displayed. */
  in_index: boolean;
  /** Saturated / historical benchmark: still fitted (it anchors 2023–2024 models) but shown as "legacy". */
  legacy: boolean;
  /** Preferred evaluation configuration when a lab reports several (e.g. "no tools", "semi-private eval"). */
  preferred_config: string;
  /** Human expert reference if published by the benchmark authors, else null. */
  human_baseline: number | null;
  human_baseline_note: string | null;
  /** Year the benchmark was published — explains missing coverage for older models. */
  introduced: number;
}

export interface Source {
  /** Canonical URL of the primary source: lab blog post, model card, system card, HF model card. */
  url: string;
  title?: string;
  /**
   * Exact verbatim snippet from the page that supports the claim (≤ 300 chars).
   * The worker's `verify` command re-fetches the page and checks the quote is a substring of its text.
   */
  quote?: string;
  retrieved_at: ISOTimestamp;
  /** Set by the worker after confirming `quote` appears in the fetched page. */
  verified?: boolean;
  verified_at?: ISOTimestamp;
  /** If a page could not be fetched directly (403 etc.), the fallback reader used, e.g. "r.jina.ai". */
  via?: string;
}

export interface Score {
  /** Must match a `Benchmark.id`. */
  benchmark: string;
  /** 0–100, as reported (e.g. 80.9). */
  value: number;
  /** Evaluation configuration as reported: "extended thinking", "no tools", "high effort", "pass@1", "semi-private", "AIME 2025", ... */
  config?: string;
  /** Anything needed to interpret the number honestly (e.g. "average of retail/airline/telecom domains"). */
  note?: string;
  /** `official` = the lab's own number; `maintainer` = the benchmark maintainer's leaderboard. Both enter the index; the UI flags the latter. */
  reported_by: 'official' | 'maintainer';
  source: Source;
}

export type ReleaseStatus =
  /** Publicly available (API or product). Solid point on the lab's line. */
  | 'released'
  /** Officially announced by the lab, not available yet. Grey hollow marker. */
  | 'announced'
  /** Credible reporting only, no lab confirmation. Grey dashed marker, off-index. */
  | 'rumored'
  /** Announced then cancelled/abandoned. Kept for history, faded. */
  | 'cancelled';

export type DatePrecision = 'day' | 'month' | 'quarter' | 'year' | 'unknown';

export interface ModelRelease {
  /** Stable slug: `<lab>-<model>`, e.g. `openai-gpt-5`. */
  id: string;
  lab: LabId;
  /** Display name exactly as the lab writes it. */
  name: string;
  /** Lineage for fork logic (e.g. "GPT", "Claude Opus", "Claude Fable", "Gemini Pro"). */
  family: string;
  /**
   * Public launch date (GA or public preview with API/product access).
   * For `announced`/`rumored`: the expected date if stated, else the announcement date.
   */
  date: ISODate;
  date_precision: DatePrecision;
  status: ReleaseStatus;
  /** For announced/rumored models: expected release window if the lab or reporting gave one. */
  expected_window?: { start: ISODate; end: ISODate; source: Source };
  /** The launch post / model card proving the release and its date. */
  announcement: Source;
  /** Additional supporting sources (system card, HF card, press). */
  sources?: Source[];
  scores: Score[];
  /** Caveats: naming changes, phased rollouts, export-control pauses, etc. */
  notes?: string;
}

export interface LabFile {
  lab: LabId;
  updated_at: ISOTimestamp;
  releases: ModelRelease[];
}

/** One row in `data/history/changes.jsonl` — the append-only audit log. */
export interface ChangeEvent {
  at: ISOTimestamp;
  /** `seed` = initial research; `worker` = hourly automation; `manual` = human edit. */
  actor: 'seed' | 'worker' | 'manual';
  lab: LabId;
  release_id: string;
  kind: 'release_added' | 'release_updated' | 'score_added' | 'score_updated' | 'status_changed' | 'verified';
  summary: string;
  source_url?: string;
}

/** The single JSON document the website loads: `data/public/latest.json`. */
export interface Bundle {
  generated_at: ISOTimestamp;
  version: 1;
  labs: Lab[];
  benchmarks: Benchmark[];
  releases: ModelRelease[];
  /** Tail of the audit log for the "what changed" feed. */
  recent_changes: ChangeEvent[];
  /** Worker health for the footer. */
  worker: {
    last_run_at: ISOTimestamp | null;
    last_success_at: ISOTimestamp | null;
    pages_polled: number;
    pages_changed: number;
    llm_model: string | null;
  };
}
