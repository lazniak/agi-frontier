/** CLI wrapper for promoting researched data into data/models (REDESIGN §6.1). */
import { runPromote } from '../researcher/promote';
import type { Runtime } from '../runtime';

export interface PromoteCommandOptions {
  force?: boolean;
}

export function runPromoteCommand(rt: Runtime, opts: PromoteCommandOptions): Promise<number> {
  return runPromote(rt, { ...(opts.force ? { force: true } : {}) });
}
