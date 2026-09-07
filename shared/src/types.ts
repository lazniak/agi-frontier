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
  /**
   * `%` — a pass rate 0–100. `elo` — a rating on an Elo scale (LMArena); converted to the
   * probability of beating `elo_reference` before the logit (REDESIGN §1.1).
   */
  unit: '%' | 'elo';
  min: number;
  max: number;
  higher_is_better: true;
  /** Required when `unit === 'elo'`: the rating that maps to p = 0.5. */
  elo_reference?: number | undefined;
  /** Observation weight in the Rasch fit (default 1; LMArena 2). */
  weight: number;
  /** Benchmark generation 1..n — the overlapping tiers that chain the rating across eras (REDESIGN §1.3). */
  generation: number;
  /** True when the number comes from human votes rather than a test (LMArena). Display flag. */
  community?: boolean | undefined;
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
  /** Free-text caveat about this source (e.g. "date taken from page metadata"). */
  note?: string;
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

/** Size tier within a lab's lineup. Absent on a release means `flagship`. */
export type ModelTier = 'flagship' | 'mid' | 'small';

/** Who put the release in the published dataset: the human-curated seed, or the OpenRouter researcher. */
export type DataOrigin = 'gold' | 'researcher';

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
  /** Lineup tier (REDESIGN §3). Absent ⇒ flagship. Only flagships form the frontier and the cadence. */
  tier?: ModelTier | undefined;
  /** Absent ⇒ gold (seed). The researcher writes `researcher`. */
  origin?: DataOrigin | undefined;
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

/* ------------------------------------------------------------ researcher */

/** How well the OpenRouter researcher reproduces the frozen gold set (REDESIGN §6.1, `eval`). */
export interface ResearcherEval {
  evaluated_at: ISOTimestamp;
  gold_releases: number;
  found_releases: number;
  matched_releases: number;
  precision_releases: number;
  recall_releases: number;
  gold_scores: number;
  matched_scores: number;
  score_recall: number;
  /** Mean |Δ| over matched scores, in the benchmark's unit. */
  score_mae: number;
  quotes_total: number;
  quotes_verified: number;
  quote_verified_rate: number;
  by_lab: Record<LabId, { gold: number; found: number; matched: number; scores_gold: number; scores_matched: number }>;
}

export interface ResearcherBudget {
  calls: number;
  tokens_in: number;
  tokens_out: number;
  usd_estimate: number;
}

/** Worker health + researcher status, published in the bundle (REDESIGN §6.3). */
export interface WorkerState {
  last_run_at: ISOTimestamp | null;
  last_success_at: ISOTimestamp | null;
  pages_polled: number;
  pages_changed: number;
  llm_model: string | null;
  /** When the loop will wake next — drives the "next research in …" progress bar. */
  next_run_at: ISOTimestamp | null;
  run_status: 'idle' | 'running';
  /** Human-readable current step while running (e.g. "poll · anthropic"). */
  run_step: string | null;
  interval_minutes: number;
  last_run_summary: string | null;
  researcher: {
    version: string;
    last_backfill_at: ISOTimestamp | null;
    last_arena_at: ISOTimestamp | null;
    last_eval_at: ISOTimestamp | null;
    eval: ResearcherEval | null;
    budget: ResearcherBudget | null;
  };
}

/* ------------------------------------------------------------- analytics */
/* Types of the derived quantities the shared maths produces (REDESIGN §2–5). The functions live
   in stages.ts / lineup.ts / backtest.ts; the shapes are part of the contract. */

/** Least-squares trend of the frontier's θ over a trailing window. */
export interface FrontierTrend {
  slopePerDay: number;
  /** θ at day number 0 (see timeline.dateToDayNumber). */
  intercept: number;
  slopeSe: number;
  residualSigma: number;
  n: number;
  windowDays: number;
  /** Day number the OLS was centred on (asOf). */
  refDay: number;
}

export type LevelKind = 'human' | 'saturation' | 'generation' | 'ceiling';

/** A rung of the y-axis ladder: a θ (and rating) with a meaning derived from the fit. */
export interface Level {
  id: string;
  kind: LevelKind;
  label: string;
  theta: number;
  rating: number;
  benchmark?: string;
  generation?: number;
}

/** When the frontier crossed (past) or is expected to cross (predicted) a level. */
export interface Crossing {
  level: Level;
  kind: 'past' | 'predicted';
  date: ISODate;
  p05?: ISODate;
  p16?: ISODate;
  p84?: ISODate;
  p95?: ISODate;
  release_id?: string;
  lab?: LabId;
}

export type PaceRegime = 'dormant' | 'climb' | 'acceleration' | 'takeoff';

/** A stretch of months in which the trailing-year pace stayed in one regime. */
export interface Era {
  start: ISODate;
  /** null = open (the current era). */
  end: ISODate | null;
  regime: PaceRegime;
  meanPace: number;
  maxPace: number;
}

/** One knot of a lab's lineup band: the flagship on top, the smallest current tier below. */
export interface BandPoint {
  date: ISODate;
  hiTheta: number;
  loTheta: number;
  hiId: string;
  loId: string;
}

/** One lab's k = 1 prediction made as of a date, against what then happened. */
export interface BacktestRow {
  asOf: ISODate;
  lab: LabId;
  predictedMedian: ISODate | null;
  p05: ISODate | null;
  p16: ISODate | null;
  p84: ISODate | null;
  p95: ISODate | null;
  predictedTheta: number | null;
  actual: { release_id: string; date: ISODate; theta: number | null } | null;
  /** actual − predicted median, days. */
  errorDays: number | null;
  in68: boolean | null;
  in90: boolean | null;
  /** actual θ − predicted θ (null when either is missing). */
  thetaError: number | null;
}

export interface BacktestReport {
  from: ISODate;
  to: ISODate;
  stepDays: number;
  /** Rows with a prediction AND an actual release — the ones coverage is measured over. */
  n: number;
  /** Rows with an actual but no prediction (the lab had no release yet as of `asOf`). */
  unforecastable: number;
  coverage68: number;
  coverage90: number;
  maeDays: number;
  medianAbsDays: number;
  biasDays: number;
  thetaMae: number | null;
  byLab: Record<LabId, { n: number; coverage68: number; coverage90: number; maeDays: number }>;
  /** Share of actual dates at or before the nominal-quantile date; perfect ⇒ observed = nominal. */
  calibration: { nominal: number; observed: number }[];
  /** σ multiplier the report was produced with (1 = unmodified shrinkage σ). */
  sigmaScale: number;
  /** Cadence recency half-life in days the report was produced with (Infinity = unweighted). */
  halfLifeDays: number;
  /** Whether the pooled cadence drift was applied to the forecasts. */
  drift: boolean;
  /** Pooled drift β·365 (log-gaps per year) estimated as of `to`; null with no intervals. */
  driftPerYear: number | null;
  rows: BacktestRow[];
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
  /** Backtest of the forecast over the whole history (REDESIGN §5); written by `bundle`. */
  backtest?: BacktestReport;
  /** Worker health for the footer. */
  worker: WorkerState & {
    last_run_at: ISOTimestamp | null;
    last_success_at: ISOTimestamp | null;
    pages_polled: number;
    pages_changed: number;
    llm_model: string | null;
  };
}
