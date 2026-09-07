/**
 * Append a `release_added` audit row for every release that has none yet.
 * Used once after the initial research seed; idempotent.
 *   bun run scripts/seed-changes.ts
 */
import { readdirSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangeEvent, LabFile } from '../shared/src/types';

const root = join(import.meta.dir, '..');
const logPath = join(root, 'data/history/changes.jsonl');
const existing = new Set<string>();
if (existsSync(logPath)) {
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as ChangeEvent;
    if (e.kind === 'release_added') existing.add(e.release_id);
  }
}
const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
let added = 0;
const files = readdirSync(join(root, 'data/models')).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort();
for (const f of files) {
  const lab = JSON.parse(readFileSync(join(root, 'data/models', f), 'utf8')) as LabFile;
  for (const r of [...lab.releases].sort((a, b) => a.date.localeCompare(b.date))) {
    if (existing.has(r.id)) continue;
    const e: ChangeEvent = {
      at: now,
      actor: 'seed',
      lab: lab.lab,
      release_id: r.id,
      kind: 'release_added',
      summary: `${r.name} (${r.status}, ${r.date}) with ${r.scores.length} scores — initial research seed`,
      source_url: r.announcement.url,
    };
    appendFileSync(logPath, JSON.stringify(e) + '\n');
    added++;
  }
}
console.log(`seeded ${added} change rows (${existing.size} already present)`);
