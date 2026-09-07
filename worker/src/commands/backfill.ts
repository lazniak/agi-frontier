/** CLI wrapper for the researcher backfill (REDESIGN §6.1). Thin: flags -> researcher module. */
import { runBackfill } from '../researcher/backfill';
import type { Runtime } from '../runtime';
import type { LabId } from '@agi/shared';

export interface BackfillCommandOptions {
  lab?: LabId;
  out?: string;
  incremental?: boolean;
  dryRun?: boolean;
}

export function runBackfillCommand(rt: Runtime, opts: BackfillCommandOptions): Promise<number> {
  return runBackfill(rt, {
    ...(opts.lab ? { lab: opts.lab } : {}),
    ...(opts.out ? { out: opts.out } : {}),
    ...(opts.incremental ? { incremental: true } : {}),
    ...(opts.dryRun ? { dryRun: true } : {}),
  });
}