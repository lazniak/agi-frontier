import { describe, expect, test } from 'bun:test';
import type { LabFile, ModelRelease } from '@agi/shared';
import { canonicalLabFile, canonicalSource, sortReleases, stringifyLabFile } from '../src/canonical';

function release(id: string, date: string): ModelRelease {
  return {
    id,
    lab: 'openai',
    name: id,
    family: 'GPT',
    date,
    date_precision: 'day',
    status: 'released',
    announcement: { url: 'https://openai.com/x', retrieved_at: '2026-09-07T00:00:00Z' },
    scores: [],
  };
}

describe('canonicalSource', () => {
  test('puts keys in contract order regardless of input order', () => {
    const source = canonicalSource({
      verified: true,
      retrieved_at: '2026-09-07T00:00:00Z',
      url: 'https://openai.com/x',
      quote: 'available today',
    });
    expect(Object.keys(source)).toEqual(['url', 'quote', 'retrieved_at', 'verified']);
  });

  test('keeps fields the shared contract adds later instead of dropping them', () => {
    const source = canonicalSource({
      url: 'https://openai.com/x',
      retrieved_at: '2026-09-07T00:00:00Z',
      note: 'date taken from page metadata',
    });
    expect(source.note).toBe('date taken from page metadata');
  });

  test('drops undefined values so they never reach the JSON', () => {
    const source = canonicalSource({ url: 'u', retrieved_at: 't', title: undefined });
    expect('title' in source).toBe(false);
  });
});

describe('canonicalLabFile', () => {
  const file: LabFile = {
    lab: 'openai',
    updated_at: '2026-09-07T00:00:00Z',
    releases: [release('openai-gpt-6', '2026-05-04'), release('openai-gpt-5', '2025-08-07')],
  };

  test('sorts releases by date', () => {
    expect(canonicalLabFile(file).releases.map((r) => r.id)).toEqual(['openai-gpt-5', 'openai-gpt-6']);
  });

  test('breaks date ties by id so the order is total', () => {
    const sorted = sortReleases([release('openai-b', '2026-01-01'), release('openai-a', '2026-01-01')]);
    expect(sorted.map((r) => r.id)).toEqual(['openai-a', 'openai-b']);
  });

  test('serialises as 2-space JSON with a trailing newline', () => {
    const text = stringifyLabFile(file);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "lab": "openai",');
    expect(text.split('\n')[0]).toBe('{');
  });

  test('is stable: canonicalising twice changes nothing', () => {
    expect(stringifyLabFile(canonicalLabFile(file))).toBe(stringifyLabFile(file));
  });
});
