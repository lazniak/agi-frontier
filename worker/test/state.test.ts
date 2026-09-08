import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMPTY_RUN_STATE,
  StateStore,
  ZERO_USAGE,
  addUsage,
  diffSource,
  mergeSummaryLine,
  recordUsage,
  sourceKey,
  usageDelta,
  type RunState,
  type SourceState,
} from '../src/state';

const tmp = mkdtempSync(join(tmpdir(), 'agi-state-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('diffSource', () => {
  const now = '2026-09-07T00:00:00Z';

  test('a source seen for the first time is changed and everything is new', () => {
    const d = diffSource(undefined, 'h1', ['a', 'b'], now);
    expect(d.changed).toBe(true);
    expect(d.newItems).toEqual(['a', 'b']);
    expect(d.next).toEqual({ hash: 'h1', checked_at: now, changed_at: now, seen: ['a', 'b'] });
  });

  test('same hash and same items: unchanged, nothing new', () => {
    const prev: SourceState = { hash: 'h1', checked_at: '2026-09-06T00:00:00Z', changed_at: '2026-09-06T00:00:00Z', seen: ['a', 'b'] };
    const d = diffSource(prev, 'h1', ['a', 'b'], now);
    expect(d.changed).toBe(false);
    expect(d.newItems).toEqual([]);
    expect(d.next.checked_at).toBe(now);
    expect(d.next.changed_at).toBe('2026-09-06T00:00:00Z');
  });

  test('a new hash with a new item reports only the new item', () => {
    const prev: SourceState = { hash: 'h1', checked_at: now, changed_at: now, seen: ['a', 'b'] };
    const d = diffSource(prev, 'h2', ['c', 'a', 'b'], now);
    expect(d.changed).toBe(true);
    expect(d.newItems).toEqual(['c']);
    expect(d.next.seen).toEqual(['a', 'b', 'c']);
  });

  test('a reordered page changes the item hash but yields no new items', () => {
    const prev: SourceState = { hash: 'h1', checked_at: now, changed_at: now, seen: ['a', 'b'] };
    const d = diffSource(prev, 'h2', ['b', 'a'], now);
    expect(d.changed).toBe(true);
    expect(d.newItems).toEqual([]); // nothing costs an LLM call
  });

  test('the seen list is capped, dropping the oldest keys', () => {
    const many = Array.from({ length: 1300 }, (_, i) => `k${i}`);
    const d = diffSource(undefined, 'h', many, now);
    expect(d.next.seen).toHaveLength(1200);
    expect(d.next.seen[0]).toBe('k100');
    expect(d.next.seen.at(-1)).toBe('k1299');
  });

  test('the cap is larger than the biggest real source window (OpenAI RSS, 400 items)', () => {
    const feed = Array.from({ length: 400 }, (_, i) => `post-${i}`);
    const first = diffSource(undefined, 'h1', feed, now);
    // A year of weekly posts later, the original items must still count as seen.
    let state = first.next;
    for (let week = 0; week < 52; week++) {
      state = diffSource(state, `h${week}`, [`new-${week}`, ...feed], now).next;
    }
    expect(diffSource(state, 'h', feed, now).newItems).toEqual([]);
  });
});

describe('sourceKey', () => {
  test('namespaces a URL by lab', () => {
    expect(sourceKey('openai', 'https://openai.com/news/')).toBe('openai|https://openai.com/news/');
  });
});

describe('StateStore', () => {
  const store = new StateStore(tmp);

  test('returns defaults when nothing is on disk', () => {
    expect(store.readRun()).toEqual(EMPTY_RUN_STATE);
    expect(store.readHashes()).toEqual({});
  });

  test('round-trips run state and hashes', () => {
    const run = { ...EMPTY_RUN_STATE, last_run_at: '2026-09-07T01:00:00Z', pages_polled: 21, llm_model: 'x/y' };
    store.writeRun(run);
    store.writeHashes({ 'openai|u': { hash: 'h', checked_at: '2026-09-07T01:00:00Z', changed_at: null, seen: ['a'] } });
    expect(store.readRun()).toEqual(run);
    expect(store.readHashes()['openai|u']?.hash).toBe('h');
  });

  test('exposes the public worker state to the bundle, minus the loop bookkeeping', () => {
    const run = { ...EMPTY_RUN_STATE, last_discover_at: '2026-09-07T01:00:00Z', pages_polled: 3 };
    const pub = StateStore.toWorkerState(run);
    expect(pub).not.toHaveProperty('last_discover_at');
    expect(pub.pages_polled).toBe(3);
    expect(pub.run_status).toBe('idle');
    expect(pub.researcher.eval).toBeNull();
  });

  test('publishes usage_total and last_backfill_summary as explicit nulls for a pre-v3 state.json', () => {
    // An old state file has a researcher block without the two v3 keys; the shallow merge in
    // readRun keeps that block as-is, so toWorkerState must fill them in.
    const legacy = { ...EMPTY_RUN_STATE, researcher: { version: '2.0.0', last_backfill_at: null, last_arena_at: null, last_eval_at: null, eval: null, budget: null } } as RunState;
    const pub = StateStore.toWorkerState(legacy);
    expect(pub.researcher.usage_total).toBeNull();
    expect(pub.researcher.last_backfill_summary).toBeNull();
    // And a populated one passes straight through.
    const populated = recordUsage({ ...EMPTY_RUN_STATE, researcher: { ...EMPTY_RUN_STATE.researcher } }, { calls: 3, tokens_in: 10, tokens_out: 5, usd_estimate: 0.01 }, { research: true });
    expect(StateStore.toWorkerState(populated).researcher.usage_total).toEqual({ calls: 3, tokens_in: 10, tokens_out: 5, usd_estimate: 0.01 });
  });
});

describe('usage bookkeeping (REDESIGN §12.6)', () => {
  const delta = { calls: 107, tokens_in: 4_000_000, tokens_out: 120_000, usd_estimate: 2.03 };

  test('usageDelta subtracts the snapshot taken at run start; a missing snapshot means zero', () => {
    const after = { calls: 110, tokens_in: 4_000_500, tokens_out: 120_100, usd_estimate: 2.034 };
    expect(usageDelta(after, { calls: 3, tokens_in: 500, tokens_out: 100, usd_estimate: 0.004 })).toEqual(delta);
    expect(usageDelta(after, null)).toEqual(after);
  });

  test('addUsage sums and rounds USD to micro-dollars', () => {
    expect(addUsage(null, delta)).toEqual(delta);
    expect(addUsage(delta, { calls: 1, tokens_in: 1, tokens_out: 1, usd_estimate: 0.1 + 0.2 })).toEqual({
      calls: 108, tokens_in: 4_000_001, tokens_out: 120_001, usd_estimate: 2.33,
    });
    expect(addUsage(undefined, ZERO_USAGE)).toEqual(ZERO_USAGE);
  });

  test('a poll accumulates into usage_total but leaves budget alone; a research run sets both', () => {
    const run: RunState = { ...EMPTY_RUN_STATE, researcher: { ...EMPTY_RUN_STATE.researcher, budget: delta, usage_total: delta } };
    const poll = { calls: 2, tokens_in: 1000, tokens_out: 50, usd_estimate: 0.001 };
    recordUsage(run, poll, { research: false });
    expect(run.researcher.budget).toEqual(delta); // the 107-call backfill still shows
    expect(run.researcher.usage_total).toEqual({ calls: 109, tokens_in: 4_001_000, tokens_out: 120_050, usd_estimate: 2.031 });
    const research = { calls: 5, tokens_in: 100, tokens_out: 10, usd_estimate: 0.01 };
    recordUsage(run, research, { research: true });
    expect(run.researcher.budget).toEqual(research);
    expect(run.researcher.usage_total?.calls).toBe(114);
  });

  const backfill = 'backfill: 10 labs, 8 candidates, 1 release / 0 scores, 107 calls · 2.03 USD';
  const evalLine = 'eval: 0/102 gold matched, precision 0, recall 0, score recall 0 → promote NOT MET';
  const arena = 'arena: 200 rows, 40 matched, 12 scores written to 3 lab files, 5 unmatched';

  test('mergeSummaryLine replaces only the segment of the step that reported', () => {
    expect(mergeSummaryLine(null, backfill)).toBe(backfill);
    expect(mergeSummaryLine(backfill, evalLine)).toBe(`${backfill} · ${evalLine}`);
    // A second eval replaces the first eval segment, never stacks — and the backfill segment
    // survives with its own ` · 2.03 USD` tail intact (that separator is not a segment break).
    expect(mergeSummaryLine(`${backfill} · ${evalLine}`, 'eval: 1/102 gold matched')).toBe(`${backfill} · eval: 1/102 gold matched`);
    // An arena line no longer wipes the backfill line, and vice versa — segments are per step.
    expect(mergeSummaryLine(`${backfill} · ${evalLine}`, arena)).toBe(`${arena} · ${backfill} · ${evalLine}`);
    expect(mergeSummaryLine(arena, evalLine)).toBe(`${arena} · ${evalLine}`);
    expect(mergeSummaryLine(arena, 'arena: 1 row, 0 matched')).toBe('arena: 1 row, 0 matched');
    // A line from an unknown step has no segment of its own and stands alone, as before.
    expect(mergeSummaryLine(`${arena} · ${backfill}`, 'poll: 23 pages, 1 changed')).toBe('poll: 23 pages, 1 changed');
  });

  test('one loop iteration (arena → backfill → eval) publishes all three lines', () => {
    // The weekly gates start null together and share the same interval, so the three steps run
    // back-to-back seconds apart. Before per-step segments the panel only ever showed the eval.
    let line = mergeSummaryLine(null, arena);
    line = mergeSummaryLine(line, backfill);
    line = mergeSummaryLine(line, evalLine);
    expect(line).toBe(`${arena} · ${backfill} · ${evalLine}`);
    expect(line.startsWith('arena:')).toBe(true);
    expect(line).toContain('backfill: 10 labs');
    expect(line).toContain('promote NOT MET');
  });

  test('a fresh backfill drops the eval that measured the previous candidate set', () => {
    const standing = `${arena} · ${backfill} · ${evalLine}`;
    const next = 'backfill: 1 lab, 2 candidates, 2 releases / 3 scores, 4 calls · 0.10 USD';
    // The arena result is independent of the candidate set and stays; the eval is now stale.
    expect(mergeSummaryLine(standing, next)).toBe(`${arena} · ${next}`);
  });
});
