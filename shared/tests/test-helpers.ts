/**
 * Fixture builders for the shared math tests. Not part of the public API, and outside
 * `shared/src` so that `web`/`worker` never compile it — `bun test` is the only consumer.
 */
import type { Benchmark, ISODate, LabId, ModelRelease, Score, Source } from '../src/types';
import { addDays } from '../src/timeline';
import { indexFromTheta } from '../src/frontier-index';

export function source(url = 'https://example.com/post'): Source {
  return { url, quote: 'verbatim quote', retrieved_at: '2026-01-01T00:00:00Z' };
}

export function benchmark(
  id: string,
  opts: { inIndex?: boolean; preferredConfig?: string; legacy?: boolean } = {},
): Benchmark {
  return {
    id,
    name: id,
    short: id,
    description: 'synthetic benchmark',
    url: 'https://example.com/bench',
    unit: '%',
    min: 0,
    max: 100,
    higher_is_better: true,
    in_index: opts.inIndex ?? true,
    legacy: opts.legacy ?? false,
    preferred_config: opts.preferredConfig ?? 'no tools, pass@1',
    human_baseline: null,
    human_baseline_note: null,
    introduced: 2024,
  };
}

export function score(
  bench: string,
  value: number,
  opts: { config?: string; reportedBy?: 'official' | 'maintainer'; url?: string } = {},
): Score {
  return {
    benchmark: bench,
    value,
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    reported_by: opts.reportedBy ?? 'official',
    source: source(opts.url),
  };
}

export function release(
  id: string,
  lab: LabId,
  date: ISODate,
  scores: Score[],
  opts: { status?: ModelRelease['status']; window?: { start: ISODate; end: ISODate } } = {},
): ModelRelease {
  return {
    id,
    lab,
    name: id,
    family: 'synthetic',
    date,
    date_precision: 'day',
    status: opts.status ?? 'released',
    ...(opts.window
      ? { expected_window: { start: opts.window.start, end: opts.window.end, source: source() } }
      : {}),
    announcement: source(),
    scores,
  };
}

/** Deterministic PRNG (mulberry32) so noisy fixtures are reproducible across runs. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller standard normal from a uniform generator. */
export function gaussian(next: () => number): number {
  const u = Math.max(next(), 1e-12);
  const v = next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function linspace(from: number, to: number, n: number): number[] {
  if (n === 1) return [from];
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(from + ((to - from) * i) / (n - 1));
  return out;
}

export interface RaschFixture {
  releases: ModelRelease[];
  benchmarks: Benchmark[];
  thetas: number[];
  deltas: number[];
  ids: string[];
}

/**
 * A complete Rasch matrix: score_mb = 100·σ(θ_m − δ_b), one release every `stepDays`.
 * `noise` (logit space) is added before converting to a percent, so a fit on a noiseless
 * fixture must reproduce θ and δ exactly.
 */
export function raschFixture(opts: {
  thetas: number[];
  deltas: number[];
  startDate?: ISODate;
  stepDays?: number;
  noise?: (m: number, b: number) => number;
  extraNonIndexBenchmarks?: number;
  labs?: LabId[];
}): RaschFixture {
  const { thetas, deltas } = opts;
  const startDate = opts.startDate ?? '2023-01-01';
  const stepDays = opts.stepDays ?? 30;
  const noise = opts.noise ?? (() => 0);
  const labs = opts.labs ?? (['openai', 'anthropic', 'google', 'xai', 'meta'] as LabId[]);

  const benchmarks: Benchmark[] = deltas.map((_, b) => benchmark(`b${b}`));
  for (let i = 0; i < (opts.extraNonIndexBenchmarks ?? 0); i++) {
    benchmarks.push(benchmark(`x${i}`, { inIndex: false }));
  }

  const ids: string[] = [];
  const releases: ModelRelease[] = thetas.map((theta, m) => {
    const id = `m-${String(m).padStart(3, '0')}`;
    ids.push(id);
    const scores = deltas.map((delta, b) => score(`b${b}`, indexFromTheta(theta - delta + noise(m, b))));
    for (let i = 0; i < (opts.extraNonIndexBenchmarks ?? 0); i++) {
      scores.push(score(`x${i}`, indexFromTheta(theta)));
    }
    return release(id, labs[m % labs.length]!, addDays(startDate, m * stepDays), scores);
  });

  return { releases, benchmarks, thetas, deltas, ids };
}
