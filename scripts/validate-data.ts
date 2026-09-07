/**
 * Validate data files against the shared contract.
 *   bun run scripts/validate-data.ts                 # all of data/
 *   bun run scripts/validate-data.ts data/models/openai.json
 * Exit 1 on any error. Warnings (non-fatal) are printed too.
 */
import { readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { LabSchema, BenchmarkSchema, LabFileSchema, findOutOfRangeScores, findUnknownBenchmarks } from '../shared/src/schema';

const root = join(import.meta.dir, '..');
const args = process.argv.slice(2);
let errors = 0;
let warnings = 0;
const err = (m: string) => { errors++; console.error('ERROR ' + m); };
const warn = (m: string) => { warnings++; console.warn('warn  ' + m); };

const labs = await Bun.file(join(root, 'data/labs.json')).json();
const bms = await Bun.file(join(root, 'data/benchmarks.json')).json();
for (const l of labs) { const r = LabSchema.safeParse(l); if (!r.success) err(`labs.json ${l?.id}: ${JSON.stringify(r.error.issues)}`); }
for (const b of bms) { const r = BenchmarkSchema.safeParse(b); if (!r.success) err(`benchmarks.json ${b?.id}: ${JSON.stringify(r.error.issues)}`); }
const labIds = new Set<string>(labs.map((l: any) => l.id));
const bmIds = new Set<string>(bms.map((b: any) => b.id));
const indexBms = new Set<string>(bms.filter((b: any) => b.in_index).map((b: any) => b.id));

const files = args.length
  ? args.map((a) => join(root, a))
  : readdirSync(join(root, 'data/models')).filter((f) => f.endsWith('.json') && !f.startsWith('_')).map((f) => join(root, 'data/models', f));

let releases = 0, scores = 0, quoted = 0, indexScores = 0;
for (const file of files) {
  const name = basename(file);
  let json: unknown;
  try { json = await Bun.file(file).json(); } catch (e) { err(`${name}: invalid JSON (${(e as Error).message})`); continue; }
  const r = LabFileSchema.safeParse(json);
  if (!r.success) { for (const i of r.error.issues) err(`${name} ${i.path.join('.')}: ${i.message}`); continue; }
  const f = r.data;
  if (!labIds.has(f.lab)) err(`${name}: unknown lab ${f.lab}`);
  if (name !== `${f.lab}.json` && !name.startsWith('_')) err(`${name}: file name must be ${f.lab}.json`);
  const unknown = findUnknownBenchmarks(f.releases, bmIds);
  if (unknown.length) err(`${name}: unknown benchmark ids: ${unknown.join(', ')}`);
  for (const o of findOutOfRangeScores(f.releases, bms)) err(`${name} ${o.release_id} ${o.benchmark}: value ${o.value} outside the benchmark range`);
  for (const rel of f.releases) {
    releases++;
    if (rel.status === 'released' && rel.scores.length === 0) warn(`${name} ${rel.id}: released model with no scores`);
    if (!rel.announcement.quote) warn(`${name} ${rel.id}: announcement has no quote`);
    if (rel.status === 'released' && rel.date > new Date().toISOString().slice(0, 10)) err(`${name} ${rel.id}: released in the future`);
    for (const s of rel.scores) {
      scores++;
      if (indexBms.has(s.benchmark)) indexScores++;
      if (s.source.quote) {
        quoted++;
        const num = String(s.value);
        const alt = s.value.toFixed(1);
        const q = s.source.quote.replace(/,/g, '');
        if (!q.includes(num) && !q.includes(alt) && !q.includes(String(Math.round(s.value)))) warn(`${name} ${rel.id} ${s.benchmark}: quote does not contain the value ${s.value}`);
      } else warn(`${name} ${rel.id} ${s.benchmark}: score without quote`);
    }
  }
}
console.log(`files=${files.length} releases=${releases} scores=${scores} (index=${indexScores}, quoted=${quoted}) errors=${errors} warnings=${warnings}`);
process.exit(errors ? 1 : 0);
