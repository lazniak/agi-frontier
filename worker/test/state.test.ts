import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_RUN_STATE, StateStore, diffSource, sourceKey, type SourceState } from '../src/state';

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
});
