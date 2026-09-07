import { describe, expect, test } from 'bun:test';
import { parseArgs } from '../src/cli';
import { DISCOVER_WINDOW_DAYS, DiscoverResponseSchema, buildDiscoverPrompt } from '../src/commands/discover';
import { MAX_BACKOFF_MS, nextDelayMs, shouldDiscover } from '../src/commands/loop';
import { formatTable } from '../src/commands/verify';
import { PRESS_ALLOWLIST, hostMatches, isAllowedPress, itemDateOrToday, officialHosts } from '../src/pipeline';
import type { Lab } from '@agi/shared';

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
