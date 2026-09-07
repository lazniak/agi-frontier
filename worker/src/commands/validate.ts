import { print } from '../log';
import { formatReport, validateData } from '../validate';
import type { Runtime } from '../runtime';

export interface ValidateOptions {
  /** Restrict to specific `data/models/*.json` file names. */
  files?: string[];
  quiet?: boolean;
}

/** Exit code: 1 on any error, 0 otherwise (warnings never fail the run). */
export function runValidate(rt: Runtime, opts: ValidateOptions = {}): number {
  const report = validateData(rt.config.dataDir, opts.files);
  if (!opts.quiet) {
    for (const w of report.warnings) print('warn  ' + w);
    for (const e of report.errors) print('ERROR ' + e);
    print(formatReport(report));
  }
  return report.errors.length > 0 ? 1 : 0;
}
