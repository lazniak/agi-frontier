import { describe, expect, test } from 'bun:test';
import { compileHints, haystack, isCandidate, rankCandidates } from '../src/candidates';
import type { SourceItem } from '../src/items';

const openaiHints = compileHints(['^GPT-\\d', '^o\\d', 'GPT-\\d+(\\.\\d+)?(?!.*(mini|nano))']);
const anthropicHints = compileHints(['Claude (Opus|Fable|Mythos)', 'Claude \\d(\\.\\d)? Opus']);

function item(title: string, link?: string): SourceItem {
  return link ? { key: link, title, link } : { key: `t:${title}`, title };
}

describe('compileHints', () => {
  test('skips invalid regexes instead of throwing', () => {
    expect(compileHints(['(unclosed', 'ok']).map((r) => r.source)).toEqual(['ok']);
  });
});

describe('haystack', () => {
  test('combines the title with the link slug', () => {
    expect(haystack(item('Read more', 'https://www.anthropic.com/news/claude-opus-4-5'))).toBe(
      'read more claude opus 4 5',
    );
  });

  test('falls back to the title when there is no link', () => {
    expect(haystack(item('Introducing GPT-6'))).toBe('introducing gpt-6');
  });
});

describe('isCandidate', () => {
  test('a flagship hint wins and is reported as the reason', () => {
    const v = isCandidate(item('GPT-6 is here'), openaiHints);
    expect(v.candidate).toBe(true);
    expect(v.reason.startsWith('hint:')).toBe(true);
  });

  test('a generic keyword is enough when no hint matches', () => {
    const v = isCandidate(item('Introducing a new way to build agents'), openaiHints);
    expect(v.candidate).toBe(true);
    expect(v.reason.startsWith('keyword:')).toBe(true);
  });

  test('an anonymous link title still matches via the URL slug', () => {
    const v = isCandidate(item('Read more', 'https://www.anthropic.com/news/claude-opus-5'), anthropicHints);
    expect(v.candidate).toBe(true);
  });

  test.each([
    'Careers at OpenAI',
    'Privacy policy',
    'Our economic blueprint for the UK',
    'Contact sales',
  ])('ignores %s', (title) => {
    expect(isCandidate(item(title), openaiHints).candidate).toBe(false);
  });

  test('ignores empty items', () => {
    expect(isCandidate(item(''), openaiHints)).toEqual({ candidate: false, reason: 'empty' });
  });
});

describe('rankCandidates', () => {
  test('hint matches come before keyword matches, non-candidates are dropped', () => {
    const items = [
      item('Announcing our new office'),
      item('Careers'),
      item('GPT-6 is here'),
      item('Introducing better search'),
    ];
    const ranked = rankCandidates(items, openaiHints);
    expect(ranked).toHaveLength(3);
    expect(ranked[0]?.item.title).toBe('GPT-6 is here');
    expect(ranked.map((r) => r.item.title)).not.toContain('Careers');
  });
});
