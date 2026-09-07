import { LabSchema, BenchmarkSchema, LabFileSchema } from '../shared/src/schema';
const labs = await Bun.file('data/labs.json').json();
const bms = await Bun.file('data/benchmarks.json').json();
const ex = await Bun.file('data/models/_example.json').json();
let ok = true;
for (const l of labs) { const r = LabSchema.safeParse(l); if (!r.success) { ok = false; console.log('lab', l.id, r.error.issues); } }
for (const b of bms) { const r = BenchmarkSchema.safeParse(b); if (!r.success) { ok = false; console.log('bm', b.id, r.error.issues); } }
const r = LabFileSchema.safeParse(ex); if (!r.success) { ok = false; console.log('example', r.error.issues); }
console.log(ok ? `contract OK: ${labs.length} labs, ${bms.length} benchmarks (${bms.filter((b:any)=>b.in_index).length} in index)` : 'contract FAILED');
