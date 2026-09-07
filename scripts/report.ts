/**
 * Print what the site will show: fitted index per model, ranking, frontier, per-lab forecast.
 *   bun run scripts/report.ts [asOf=YYYY-MM-DD]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Benchmark, Lab, LabFile, ModelRelease } from '../shared/src/types';
import {
  fitFrontierIndex, frontierLine, frontierVelocity, cadencePrior, forecastAll,
  rankCurrentFlagships, leadershipStripes, todayISO,
} from '../shared/src/index';

const root = join(import.meta.dir, '..');
const asOf = process.argv[2] ?? todayISO();
const labs = JSON.parse(readFileSync(join(root, 'data/labs.json'), 'utf8')) as Lab[];
const benchmarks = JSON.parse(readFileSync(join(root, 'data/benchmarks.json'), 'utf8')) as Benchmark[];
const releases: ModelRelease[] = readdirSync(join(root, 'data/models'))
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .flatMap((f) => (JSON.parse(readFileSync(join(root, 'data/models', f), 'utf8')) as LabFile).releases);

const fit = fitFrontierIndex(releases, benchmarks, { asOf });
console.log(`asOf=${asOf} releases=${releases.length} fitted=${Object.keys(fit.models).length} iters=${fit.iterations} converged=${fit.converged} residualSigma=${fit.residualSigma.toFixed(3)}`);
console.log('\nBenchmark difficulty δ (logit; + = harder):');
for (const id of fit.benchmarksInIndex) console.log(`  ${id.padEnd(20)} ${fit.difficulties[id]!.toFixed(2).padStart(6)}`);

console.log('\nAll fitted models (date, lab, name, index ± se, n):');
const rows = Object.values(fit.models).sort((a, b) => a.date.localeCompare(b.date));
for (const m of rows) {
  const r = releases.find((x) => x.id === m.release_id)!;
  console.log(`  ${m.date} ${m.lab.padEnd(9)} ${r.name.padEnd(28)} R ${m.rating.toFixed(0).padStart(5)}  idx ${m.index.toFixed(1).padStart(5)} ± ${m.se.toFixed(2)}  n=${m.n} ${m.tier}${m.qualified ? "" : "  (provisional)"}`);
}

console.log('\nRanking of current flagships:');
rankCurrentFlagships(fit, releases, asOf).forEach((m, i) => {
  const r = releases.find((x) => x.id === m.release_id)!;
  console.log(`  ${String(i + 1).padStart(2)}. ${r.name.padEnd(28)} ${m.lab.padEnd(9)} R ${m.rating.toFixed(0)}  idx ${m.index.toFixed(1)}  cov=${(m.coverage * 100).toFixed(0)}%${m.qualified ? "" : "  provisional"}`);
});

const line = frontierLine(fit);
console.log(`\nFrontier knots: ${line.length}; velocity(365d) = ${frontierVelocity(line, asOf)?.toFixed(2)} pts/30d`);
for (const k of line.slice(-6)) console.log(`  ${k.date} ${k.lab.padEnd(9)} ${k.index.toFixed(1)} ${k.release_id}`);
console.log('\nLeadership stripes (last 5):');
for (const s of leadershipStripes(fit).slice(-5)) console.log(`  ${s.from} → ${s.to ?? 'now'} ${s.lab} ${s.release_id}`);

const prior = cadencePrior(releases, asOf);
console.log(`\nCadence prior: mu=${prior.mu.toFixed(2)} (median ${Math.exp(prior.mu).toFixed(0)} d) sigma=${prior.sigma.toFixed(2)} n=${prior.n}`);
console.log('Forecasts:');
for (const f of forecastAll(labs.map((l) => l.id), releases, fit, { asOf })) {
  const n1 = f.next[0];
  console.log(`  ${f.lab.padEnd(9)} last=${f.lastRelease?.date ?? '-'} elapsed=${f.elapsedDays}d intervals=[${f.intervalsDays.join(',')}] mu=${f.mu.toFixed(2)} sigma=${f.sigma.toFixed(2)} P30=${(f.p30 * 100).toFixed(0)}% P90=${(f.p90 * 100).toFixed(0)}%` +
    (n1 ? ` next: ${n1.medianDate} [${n1.p16Date}..${n1.p84Date}] idx ${n1.index.toFixed(1)} (${n1.indexLow.toFixed(0)}–${n1.indexHigh.toFixed(0)}) cert=${n1.certainty.toFixed(2)} ${n1.source}` : ''));
}
