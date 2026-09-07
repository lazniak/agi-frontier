import type { Benchmark, Bundle, ChangeEvent, ISOTimestamp, Lab, LabFile } from './types';

export type WorkerState = Bundle['worker'];

export const EMPTY_WORKER_STATE: WorkerState = {
  last_run_at: null,
  last_success_at: null,
  pages_polled: 0,
  pages_changed: 0,
  llm_model: null,
};

/** Assemble `data/public/latest.json`. Pure; callers read/write files. */
export function buildBundle(
  labs: Lab[],
  benchmarks: Benchmark[],
  labFiles: LabFile[],
  changes: ChangeEvent[],
  worker: WorkerState = EMPTY_WORKER_STATE,
  generatedAt: ISOTimestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  recentChangesLimit = 100,
): Bundle {
  const labOrder = new Map(labs.map((l, i) => [l.id, i] as const));
  const releases = labFiles
    .flatMap((f) => f.releases)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (labOrder.get(a.lab) ?? 0) - (labOrder.get(b.lab) ?? 0)));
  const recent_changes = [...changes].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, recentChangesLimit);
  return { generated_at: generatedAt, version: 1, labs, benchmarks, releases, recent_changes, worker };
}
