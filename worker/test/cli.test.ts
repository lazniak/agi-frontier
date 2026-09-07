import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../src/cli';
import { DISCOVER_WINDOW_DAYS, DiscoverResponseSchema, buildDiscoverPrompt } from '../src/commands/discover';
import { MAX_BACKOFF_MS, nextDelayMs, shouldArena, shouldBackfill, shouldDiscover, shouldRunWeekly } from '../src/commands/loop';
import { formatTable } from '../src/commands/verify';
import { PRESS_ALLOWLIST, hostMatches, isAllowedPress, itemDateOrToday, officialHosts } from '../src/pipeline';
import { EMPTY_RUN_STATE, StateStore, markIdle, markRunning, summariseRun } from '../src/state';
import type { Lab } from '@agi/shared';

const tmp = mkdtempSync(join(tmpdir(), 'agi-cli-'));

describe('parseArgs', () => {
  test('reads the command, boolean flags and value flags', () => {
    expect(parseArgs(['poll', '--lab', 'openai', '--dry-run'])).toEqual({
      command: 'poll',
      flags: { lab: 'openai', 'dry-run': true },
      positional: [],
    });
  });

  test('accepts --flag=value', () => {
    expect(parseArgs(['verify', '--limit=25']).flags['limit']).toBe('25');
  });

  test('defaults to help with no arguments', () => {
    expect(parseArgs([]).command).toBe('help');
  });

  test('a flag directly before another flag stays boolean', () => {
    expect(parseArgs(['verify', '--only-unverified', '--lab', 'meta']).flags).toEqual({
      'only-unverified': true,
      lab: 'meta',
    });
  });
});

describe('loop scheduling', () => {
  test('no failures: the interval plus jitter', () => {
    expect(nextDelayMs(3_600_000, 0, () => 0.5)).toBe(3_600_000);
    expect(nextDelayMs(3_600_000, 0, () => 1)).toBe(3_900_000);
    expect(nextDelayMs(3_600_000, 0, () => 0)).toBe(3_300_000);
  });

  test('backs off exponentially and caps at six hours', () => {
    expect(nextDelayMs(3_600_000, 1, () => 0.5)).toBe(7_200_000);
    expect(nextDelayMs(3_600_000, 2, () => 0.5)).toBe(14_400_000);
    expect(nextDelayMs(3_600_000, 10, () => 0.5)).toBe(MAX_BACKOFF_MS);
  });

  test('never returns a non-positive delay', () => {
    expect(nextDelayMs(1000, 0, () => 0)).toBeGreaterThan(0);
  });

  test('discover runs at most once a day, and not at all when disabled', () => {
    const now = Date.parse('2026-09-07T12:00:00Z');
    expect(shouldDiscover(null, now, true)).toBe(true);
    expect(shouldDiscover('2026-09-07T11:00:00Z', now, true)).toBe(false);
    expect(shouldDiscover('2026-09-06T11:00:00Z', now, true)).toBe(true);
    expect(shouldDiscover('not a date', now, true)).toBe(true);
    expect(shouldDiscover(null, now, false)).toBe(false);
  });

  test('shouldArena / shouldBackfill fire weekly and respect the enable flag', () => {
    const now = Date.parse('2026-09-07T12:00:00Z');
    const day = 86_400_000;
    expect(shouldArena(null, now, true)).toBe(true);
    expect(shouldArena('2026-09-06T12:00:00Z', now, true)).toBe(false);
    expect(shouldArena('2026-08-31T11:00:00Z', now, true)).toBe(true);
    expect(shouldBackfill('2026-09-05T12:00:00Z', now, true)).toBe(false);
    expect(shouldBackfill('2026-08-24T12:00:00Z', now, true)).toBe(true);
    expect(shouldArena(null, now, false)).toBe(false);
    expect(shouldBackfill(null, now, false)).toBe(false);
    // An unparseable timestamp counts as "never ran".
    expect(shouldArena('garbage', now, true)).toBe(true);
  });

  test('shouldRunWeekly accepts a custom interval', () => {
    const now = Date.parse('2026-09-07T12:00:00Z');
    expect(shouldRunWeekly('2026-09-05T11:59:00Z', now, true, 2 * 86_400_000)).toBe(true);
    expect(shouldRunWeekly('2026-09-06T12:00:00Z', now, true, 2 * 86_400_000)).toBe(false);
    expect(shouldRunWeekly('2026-09-06T13:00:00Z', now, true, 86_400_000)).toBe(false);
  });
});

describe('discover targeting', () => {
  const lab = {
    id: 'anthropic',
    name: 'Anthropic',
    website: 'https://www.anthropic.com',
    sources: [
      { label: 'News', url: 'https://www.anthropic.com/news', kind: 'html' },
      { label: 'Docs', url: 'https://docs.anthropic.com/en/docs/about-claude/models/overview', kind: 'html' },
    ],
    flagship_hints: [],
  } as unknown as Lab;
  const hosts = officialHosts(lab);

  test('the lab domain and its subdomains count as official', () => {
    expect(hostMatches('https://www.anthropic.com/news/claude-opus-5', hosts)).toBe(true);
    expect(hostMatches('https://docs.anthropic.com/en/docs/models', hosts)).toBe(true);
    expect(hostMatches('https://anthropic.com/news', hosts)).toBe(true);
  });

  test('anything else is not official', () => {
    expect(hostMatches('https://techcrunch.com/anthropic-opus-5', hosts)).toBe(false);
    expect(hostMatches('https://notanthropic.com/x', hosts)).toBe(false);
    expect(hostMatches('not a url', hosts)).toBe(false);
  });

  test('the press allowlist matches domains and subdomains only', () => {
    for (const domain of PRESS_ALLOWLIST) expect(isAllowedPress(`https://${domain}/story`)).toBe(true);
    expect(isAllowedPress('https://www.reuters.com/technology/story')).toBe(true);
    expect(isAllowedPress('https://reuters.com.evil.example/story')).toBe(false);
    expect(isAllowedPress('https://some-blog.example/story')).toBe(false);
  });

  test('the prompt names the lab, the date and the 45-day window', () => {
    const prompt = buildDiscoverPrompt(lab, '2026-09-07');
    expect(prompt).toContain('Anthropic');
    expect(prompt).toContain('2026-09-07');
    expect(prompt).toContain(String(DISCOVER_WINDOW_DAYS));
    expect(prompt).toContain('"items"');
  });

  test('an unexpected status degrades to rumored instead of failing the whole response', () => {
    const parsed = DiscoverResponseSchema.safeParse({
      items: [{ name: 'Claude Opus 5', status: 'shipped', url: 'https://www.anthropic.com/news/x' }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.items[0]?.status).toBe('rumored');
  });
});

describe('itemDateOrToday', () => {
  const now = new Date('2026-09-07T10:00:00Z');

  test('parses RFC-822 and ISO dates', () => {
    expect(itemDateOrToday('Mon, 12 Jan 2026 17:00:00 GMT', now)).toBe('2026-01-12');
    expect(itemDateOrToday('2026-03-01T10:00:00Z', now)).toBe('2026-03-01');
  });

  test('falls back to today for missing or unparseable dates', () => {
    expect(itemDateOrToday(undefined, now)).toBe('2026-09-07');
    expect(itemDateOrToday('whenever', now)).toBe('2026-09-07');
  });
});

describe('formatTable', () => {
  test('pads columns to the widest cell', () => {
    const table = formatTable(['a', 'bbb'], [['xx', 'y']]);
    const [header, rule, row] = table.split('\n');
    expect(header).toBe('a   bbb');
    expect(rule).toBe('--  ---');
    expect(row).toBe('xx  y');
  });
});

describe('run-state helpers (markRunning / markIdle / summariseRun)', () => {
  test('markRunning flips the published status and records the step', () => {
    const store = new StateStore(tmp);
    store.writeRun({ ...EMPTY_RUN_STATE });
    const run = markRunning(store, 'poll · anthropic', '2026-09-07T05:00:00Z');
    expect(run.run_status).toBe('running');
    expect(run.run_step).toBe('poll · anthropic');
    expect(run.last_run_at).toBe('2026-09-07T05:00:00Z');
    const reread = store.readRun();
    expect(reread.run_status).toBe('running');
    expect(reread.run_step).toBe('poll · anthropic');
  });

  test('markIdle schedules the next run and keeps the summary', () => {
    const store = new StateStore(tmp);
    store.writeRun({ ...EMPTY_RUN_STATE });
    markRunning(store, 'backfill --incremental');
    markIdle(store, {
      nextRunAt: '2026-09-07T06:00:00Z',
      summary: 'poll: 23 pages, 1 changed · 0.004 USD',
      intervalMinutes: 60,
    });
    const run = store.readRun();
    expect(run.run_status).toBe('idle');
    expect(run.run_step).toBeNull();
    expect(run.next_run_at).toBe('2026-09-07T06:00:00Z');
    expect(run.last_run_summary).toBe('poll: 23 pages, 1 changed · 0.004 USD');
    expect(run.interval_minutes).toBe(60);
  });

  test('markIdle without a summary leaves the previous one in place', () => {
    const store = new StateStore(tmp);
    store.writeRun({ ...EMPTY_RUN_STATE, last_run_summary: 'old' });
    markIdle(store, { nextRunAt: null });
    expect(store.readRun().last_run_summary).toBe('old');
  });

  test('summariseRun formats the one-liner and skips empty parts', () => {
    expect(summariseRun('poll', { pages: 23, changed: 1, 'LLM calls': 2, 'new releases': 0 })).toBe(
      'poll: 23 pages, 1 changed, 2 LLM calls, 0 new releases',
    );
    expect(summariseRun('poll', { pages: 5, errors: undefined }, 0.0041)).toBe('poll: 5 pages · 0.004 USD');
    expect(summariseRun('arena', {})).toBe('arena: nothing to report');
  });
});
