/** CLI wrapper for the researcher eval against the gold set (REDESIGN §6.1). */
import { runEval } from '../researcher/eval';
import type { Runtime } from '../runtime';

export interface EvalCommandOptions {
  candidate?: string;
  gold?: string;
}

export function runEvalCommand(rt: Runtime, opts: EvalCommandOptions): Promise<number> {
  return runEval(rt, {
    ...(opts.candidate ? { candidateDir: opts.candidate } : {}),
    ...(opts.gold ? { goldDir: opts.gold } : {}),
  });
}
