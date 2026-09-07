import { BundleSchema, buildBundle, calibrateForecast, todayISO } from '@agi/shared';
import type { BacktestReport } from '@agi/shared';
import { bundlePath, issuesToString, readAll, writeBundleFile } from '../data-store';
import { stringifyJson } from '../canonical';
import { StateStore } from '../state';
import { print } from '../log';
import type { Runtime } from '../runtime';

export interface BundleOptions {
  quiet?: boolean;
  /** Skip the backtest + calibration (fast path for tests and dry runs). */
  skipBacktest?: boolean;
}

/**
 * Replay the release forecast over history and pick the conformal σ scale (REDESIGN §5): the
 * report — with the chosen `sigmaScale` — travels in the bundle so the site can show the
 * backtest card and apply the same scale to every window it draws. Pure maths, a few seconds.
 */
export function computeBacktest(
  releases: Parameters<typeof calibrateForecast>[0],
  benchmarks: Parameters<typeof calibrateForecast>[1],
  labIds: Parameters<typeof calibrateForecast>[2],
  to = todayISO(),
): BacktestReport {
  // Rows are dropped from the published report: the site recomputes the scrubbed rows itself
  // (backtestAsOf) and the aggregates + calibration curve are all the card needs (~1 KB vs 270 KB).
  return { ...calibrateForecast(releases, benchmarks, labIds, { to }).report, rows: [] };
}

/** Build `data/public/latest.json` — the single document the website loads. */
export function runBundle(rt: Runtime, opts: BundleOptions = {}): number {
  const { labs, benchmarks, labFiles, changes } = readAll(rt.config.dataDir);
  const worker = StateStore.toWorkerState(rt.state.readRun());
  const files = labFiles.map((f) => f.file);
  let backtest: BacktestReport | undefined;
  if (!opts.skipBacktest) {
    const t0 = performance.now();
    backtest = computeBacktest(
      files.flatMap((f) => f.releases),
      benchmarks,
      labs.map((l) => l.id),
    );
    rt.log.info('backtest calibrated', {
      n: backtest.n,
      coverage68: Number(backtest.coverage68.toFixed(3)),
      coverage90: Number(backtest.coverage90.toFixed(3)),
      sigma_scale: backtest.sigmaScale,
      ms: Math.round(performance.now() - t0),
    });
  }
  const bundle = buildBundle(labs, benchmarks, files, changes, worker, undefined, 100, backtest);

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
        `${bundle.releases.length} releases, ${bundle.recent_changes.length} recent changes` +
        (backtest
          ? ` · backtest n=${backtest.n} cov68=${backtest.coverage68.toFixed(2)} cov90=${backtest.coverage90.toFixed(2)} σ×${backtest.sigmaScale}`
          : ''),
    );
  }
  return 0;
}
