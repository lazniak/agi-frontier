/** CLI wrapper for the weekly LMArena step (REDESIGN §6.1). */
import { runArena } from '../researcher/arena';
import type { Runtime } from '../runtime';

export interface ArenaCommandOptions {
  dryRun?: boolean;
}

export function runArenaCommand(rt: Runtime, opts: ArenaCommandOptions): Promise<number> {
  return runArena(rt, { ...(opts.dryRun ? { dryRun: true } : {}) });
}
