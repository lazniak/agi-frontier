/**
 * Frontier Index — Rasch-style ability/difficulty fit over official benchmark scores.
 * See docs/METHODOLOGY.md §3. Pure functions, no I/O.
 *
 * API is frozen (web and worker code against it). Implementation: shared-math task.
 */
import type { Benchmark, ISODate, LabId, ModelRelease, Score } from './types';
import { dateToDayNumber } from './timeline';

export interface IndexFitOptions {
  /** Ridge penalty λ applied to θ and δ (default 0.05). */
  ridge?: number;
  /** Max alternating-least-squares iterations (default 200). */
  maxIter?: number;
  /** Convergence tolerance on max |Δθ|,|Δδ| (default 1e-6). */
  tolerance?: number;
  /** Percent clip before logit (default [0.5, 99.5]). */
  clip?: [number, number];
  /** Fit only `released` models with `date <= asOf`. Default: all released. */
  asOf?: ISODate;
}

export interface UsedScore {
  benchmark: string;
  value: number;
  /** Model-predicted percent for this benchmark: 100·σ(θ − δ). */
  predicted: number;
  /** Logit-space residual. */
  residual: number;
  reported_by: 'official' | 'maintainer';
  config?: string;
}

export interface ModelIndex {
  release_id: string;
  lab: LabId;
  date: ISODate;
  /** Ability on the logit scale. */
  theta: number;
  /** Frontier Index = 100·σ(θ). */
  index: number;
  /** Standard error of θ (residualSigma / √n). */
  se: number;
  /** 100·σ(θ ∓ se). */
  indexLow: number;
  indexHigh: number;
  /** Number of index benchmarks used. */
  n: number;
  /** n / number of index benchmarks (0–1). */
  coverage: number;
  used: UsedScore[];
}

export interface IndexFit {
  asOf: ISODate | null;
  /** Benchmark ids with in_index = true, in basket order. */
  benchmarksInIndex: string[];
  /** δ_b per benchmark id; mean over index benchmarks = 0. */
  difficulties: Record<string, number>;
  models: Record<string, ModelIndex>;
  /** Pooled logit-space residual σ. */
  residualSigma: number;
  iterations: number;
  converged: boolean;
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
export function logit(p: number): number {
  return Math.log(p / (1 - p));
}
/** 100·σ(θ). */
export function indexFromTheta(theta: number): number {
  return 100 * sigmoid(theta);
}
export function thetaFromIndex(index: number): number {
  return logit(Math.min(99.5, Math.max(0.5, index)) / 100);
}

/** Default percent clip applied before the logit transform (METHODOLOGY §3). */
export const DEFAULT_CLIP: [number, number] = [0.5, 99.5];

/**
 * Words carrying no information when matching a reported `config` against a benchmark's
 * `preferred_config`. Kept explicit (rather than "any short word") so the selection rule
 * is reproducible by anyone auditing the numbers.
 */
const CONFIG_STOPWORDS = new Set([
  'or', 'the', 'lab', 'default', 'record', 'in', 'config',
  'a', 'an', 'and', 'of', 'for', 'to', 'on', 'from', 'if', 'is', 'it',
  'e', 'g', 'eg', 'etc', 'that', 'which', 'what', 'when', 'only',
  'use', 'used', 'usually', 'all', 'else', 'fall', 'back',
]);

/** Lower-case, split on non-letters, drop stopwords. */
function configTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.toLowerCase().split(/[^a-z]+/)) {
    if (t.length > 0 && !CONFIG_STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

function sharesKeyword(config: string | undefined, preferred: Set<string>): boolean {
  if (!config) return false;
  for (const t of configTokens(config)) if (preferred.has(t)) return true;
  return false;
}

/**
 * Pick at most one score per index benchmark for a release:
 * official beats maintainer; a config containing a keyword of `preferred_config` beats one that does not;
 * otherwise the first listed. Deterministic. Implemented by the shared-math task.
 *
 * Returned in basket order (the order of `benchmarks`), never more than one entry per benchmark,
 * and never a benchmark with `in_index = false`.
 */
export function selectIndexScores(release: ModelRelease, benchmarks: Benchmark[]): Score[] {
  const out: Score[] = [];
  for (const b of benchmarks) {
    if (!b.in_index) continue;
    const preferred = configTokens(b.preferred_config);
    let best: Score | undefined;
    let bestRank = Number.POSITIVE_INFINITY;
    // `release.scores` order is the final tie-break, so walk it forwards and keep strict `<`.
    for (const s of release.scores) {
      if (s.benchmark !== b.id) continue;
      const rank = (s.reported_by === 'official' ? 0 : 2) + (sharesKeyword(s.config, preferred) ? 0 : 1);
      if (rank < bestRank) {
        bestRank = rank;
        best = s;
      }
    }
    if (best) out.push(best);
  }
  return out;
}

function clipPercent(value: number, clip: [number, number]): number {
  const lo = Math.min(clip[0], clip[1]);
  const hi = Math.max(clip[0], clip[1]);
  return value < lo ? lo : value > hi ? hi : value;
}

function byDateThenId(a: { date: ISODate; id: string }, b: { date: ISODate; id: string }): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : a.id.localeCompare(b.id);
}

/** Fit θ (per release) and δ (per benchmark). Implemented by the shared-math task. */
export function fitFrontierIndex(
  releases: ModelRelease[],
  benchmarks: Benchmark[],
  opts: IndexFitOptions = {},
): IndexFit {
  const ridge = opts.ridge ?? 0.05;
  const maxIter = opts.maxIter ?? 200;
  const tolerance = opts.tolerance ?? 1e-6;
  const clip = opts.clip ?? DEFAULT_CLIP;
  const asOf = opts.asOf ?? null;

  const indexBenchmarks = benchmarks.filter((b) => b.in_index);
  const benchmarksInIndex = indexBenchmarks.map((b) => b.id);
  const benchmarkSlot = new Map<string, number>();
  benchmarksInIndex.forEach((id, i) => benchmarkSlot.set(id, i));
  const B = benchmarksInIndex.length;

  const eligible = releases
    .filter((r) => r.status === 'released' && (asOf === null || r.date <= asOf))
    .slice()
    .sort(byDateThenId);

  // --- assemble the observation list -------------------------------------------------
  const modelRefs: ModelRelease[] = [];
  const obsM: number[] = [];
  const obsB: number[] = [];
  const obsY: number[] = [];
  const obsScore: Score[] = [];

  for (const r of eligible) {
    const picked = selectIndexScores(r, benchmarks);
    if (picked.length === 0) continue; // no index scores → no entry in fit.models at all
    const m = modelRefs.length;
    modelRefs.push(r);
    for (const s of picked) {
      const slot = benchmarkSlot.get(s.benchmark);
      if (slot === undefined) continue;
      obsM.push(m);
      obsB.push(slot);
      obsY.push(logit(clipPercent(s.value, clip) / 100));
      obsScore.push(s);
    }
  }

  const M = modelRefs.length;
  const N = obsY.length;
  const difficulties: Record<string, number> = {};
  for (const id of benchmarksInIndex) difficulties[id] = 0;

  if (M === 0 || N === 0) {
    return {
      asOf,
      benchmarksInIndex,
      difficulties,
      models: {},
      residualSigma: 0,
      iterations: 0,
      converged: true,
    };
  }

  // --- alternating least squares with ridge λ ----------------------------------------
  const theta = new Float64Array(M);
  const delta = new Float64Array(B);
  const prevTheta = new Float64Array(M);
  const prevDelta = new Float64Array(B);
  const accT = new Float64Array(M);
  const accB = new Float64Array(B);
  const nM = new Float64Array(M);
  const nB = new Float64Array(B);
  for (let k = 0; k < N; k++) {
    const m = obsM[k]!;
    const b = obsB[k]!;
    nM[m] = nM[m]! + 1;
    nB[b] = nB[b]! + 1;
  }
  const observedB: number[] = [];
  for (let b = 0; b < B; b++) if (nB[b]! > 0) observedB.push(b);
  const bObs = observedB.length;

  let iterations = 0;
  let converged = false;
  for (let it = 0; it < maxIter; it++) {
    iterations = it + 1;
    prevTheta.set(theta);
    prevDelta.set(delta);

    // θ_m = Σ_b (y_mb + δ_b) / (n_m + λ)
    accT.fill(0);
    for (let k = 0; k < N; k++) {
      const m = obsM[k]!;
      accT[m] = accT[m]! + obsY[k]! + delta[obsB[k]!]!;
    }
    for (let m = 0; m < M; m++) theta[m] = accT[m]! / (nM[m]! + ridge);

    // δ_b = Σ_m (θ_m − y_mb) / (n_b + λ); benchmarks with no observation stay at 0.
    accB.fill(0);
    for (let k = 0; k < N; k++) {
      const b = obsB[k]!;
      accB[b] = accB[b]! + theta[obsM[k]!]! - obsY[k]!;
    }
    for (let b = 0; b < B; b++) delta[b] = nB[b]! > 0 ? accB[b]! / (nB[b]! + ridge) : 0;

    // Re-centre δ over the observed index benchmarks and shift θ by the same amount,
    // which leaves every prediction θ_m − δ_b unchanged (METHODOLOGY §3).
    if (bObs > 0) {
      let c = 0;
      for (const b of observedB) c += delta[b]!;
      c /= bObs;
      if (c !== 0) {
        for (const b of observedB) delta[b] = delta[b]! - c;
        for (let m = 0; m < M; m++) theta[m] = theta[m]! - c;
      }
    }

    let maxStep = 0;
    for (let m = 0; m < M; m++) maxStep = Math.max(maxStep, Math.abs(theta[m]! - prevTheta[m]!));
    for (let b = 0; b < B; b++) maxStep = Math.max(maxStep, Math.abs(delta[b]! - prevDelta[b]!));
    if (maxStep < tolerance) {
      converged = true;
      break;
    }
  }

  for (let b = 0; b < B; b++) difficulties[benchmarksInIndex[b]!] = delta[b]!;

  // --- residual σ ---------------------------------------------------------------------
  let ss = 0;
  for (let k = 0; k < N; k++) {
    const r = obsY[k]! - (theta[obsM[k]!]! - delta[obsB[k]!]!);
    ss += r * r;
  }
  // Free parameters: M abilities + bObs difficulties − 1 (the mean(δ)=0 constraint).
  const dof = Math.max(1, N - (M + bObs - 1));
  const residualSigma = Math.sqrt(ss / dof);

  // --- per-model output ---------------------------------------------------------------
  const used: UsedScore[][] = Array.from({ length: M }, () => []);
  for (let k = 0; k < N; k++) {
    const m = obsM[k]!;
    const b = obsB[k]!;
    const pred = theta[m]! - delta[b]!;
    const s = obsScore[k]!;
    used[m]!.push({
      benchmark: s.benchmark,
      value: s.value,
      predicted: indexFromTheta(pred),
      residual: obsY[k]! - pred,
      reported_by: s.reported_by,
      ...(s.config !== undefined ? { config: s.config } : {}),
    });
  }

  const models: Record<string, ModelIndex> = {};
  for (let m = 0; m < M; m++) {
    const r = modelRefs[m]!;
    const th = theta[m]!;
    const n = nM[m]!;
    const se = n > 0 ? residualSigma / Math.sqrt(n) : 0;
    models[r.id] = {
      release_id: r.id,
      lab: r.lab,
      date: r.date,
      theta: th,
      index: indexFromTheta(th),
      se,
      indexLow: indexFromTheta(th - se),
      indexHigh: indexFromTheta(th + se),
      n,
      coverage: B > 0 ? n / B : 0,
      used: used[m]!,
    };
  }

  return { asOf, benchmarksInIndex, difficulties, models, residualSigma, iterations, converged };
}

export interface FrontierPoint {
  date: ISODate;
  index: number;
  release_id: string;
  lab: LabId;
}

/**
 * Running maximum of the index over released models, sorted by date.
 * Returns only the points where the maximum increases (step function knots).
 * Implemented by the shared-math task.
 */
export function frontierLine(fit: IndexFit): FrontierPoint[] {
  const models = Object.values(fit.models).slice().sort((a, b) => byDateThenId(
    { date: a.date, id: a.release_id },
    { date: b.date, id: b.release_id },
  ));
  const out: FrontierPoint[] = [];
  let best = Number.NEGATIVE_INFINITY;
  for (const m of models) {
    if (m.index > best) {
      best = m.index;
      out.push({ date: m.date, index: m.index, release_id: m.release_id, lab: m.lab });
    }
  }
  return out;
}

/**
 * Least-squares slope of the frontier step function sampled daily over the trailing `windowDays`
 * ending at `asOf`, expressed in index points per 30 days. null if fewer than 2 knots in window.
 * Implemented by the shared-math task.
 */
export function frontierVelocity(line: FrontierPoint[], asOf: ISODate, windowDays = 365): number | null {
  if (line.length === 0) return null;
  const endDay = dateToDayNumber(asOf);
  const startDay = endDay - Math.max(0, Math.round(windowDays));

  // Knots (distinct dates) that actually fall inside the window.
  const inWindow = new Set<string>();
  for (const p of line) {
    const d = dateToDayNumber(p.date);
    if (d >= startDay && d <= endDay) inWindow.add(p.date);
  }
  if (inWindow.size < 2) return null;

  const knotDays = line.map((p) => dateToDayNumber(p.date));
  const firstDay = knotDays[0]!;
  const from = Math.max(startDay, firstDay); // days before the first knot are excluded
  if (endDay < from) return null;

  let ptr = -1;
  let cur = 0;
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let d = from; d <= endDay; d++) {
    while (ptr + 1 < line.length && knotDays[ptr + 1]! <= d) {
      ptr++;
      cur = line[ptr]!.index;
    }
    if (ptr < 0) continue;
    const x = d - from; // centred origin keeps the normal equations well conditioned
    n++;
    sx += x;
    sy += cur;
    sxx += x * x;
    sxy += x * cur;
  }
  if (n < 2) return null;
  const denom = sxx - (sx * sx) / n;
  if (!(denom > 0)) return null;
  const slopePerDay = (sxy - (sx * sy) / n) / denom;
  return slopePerDay * 30;
}
