import { BundleSchema, buildBundle } from '@agi/shared';
import { bundlePath, issuesToString, readAll, writeBundleFile } from '../data-store';
import { stringifyJson } from '../canonical';
import { StateStore } from '../state';
import { print } from '../log';
import type { Runtime } from '../runtime';

export interface BundleOptions {
  quiet?: boolean;
}

/** Build `data/public/latest.json` — the single document the website loads. */
export function runBundle(rt: Runtime, opts: BundleOptions = {}): number {
  const { labs, benchmarks, labFiles, changes } = readAll(rt.config.dataDir);
  const worker = StateStore.toWorkerState(rt.state.readRun());
  const bundle = buildBundle(labs, benchmarks, labFiles.map((f) => f.file), changes, worker);

  const parsed = BundleSchema.safeParse(bundle);
  if (!parsed.success) {
    rt.log.error('bundle failed schema validation', { issues: issuesToString(parsed.error.issues) });
    return 1;
  }

  writeBundleFile(rt.config.dataDir, stringifyJson(bundle));
  if (!opts.quiet) {
    print(
      `wrote ${bundlePath(rt.config.dataDir)} — ` +
        `${bundle.labs.length} labs, ${bundle.benchmarks.length} benchmarks, ` +
        `${bundle.releases.length} releases, ${bundle.recent_changes.length} recent changes`,
    );
  }
  return 0;
}
