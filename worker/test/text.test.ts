import { describe, expect, test } from 'bun:test';
import {
  isValidReleaseId,
  stripLinkDecoration,
  stripMarkdownLinks,
  nameKey,
  normaliseForMatch,
  normaliseText,
  quoteContainsValue,
  quoteMatches,
  releaseId,
  sha256,
  slugify,
  stripNumberCommas,
  truncate,
} from '../src/text';

describe('normaliseText', () => {
  test('collapses every kind of whitespace', () => {
    expect(normaliseText('  a \n\t b \r\n  c  ')).toBe('a b c');
  });

  test('folds curly quotes and apostrophes to ASCII', () => {
    expect(normaliseText('“Humanity’s Last Exam”')).toBe('"Humanity\'s Last Exam"');
    expect(normaliseText('itʼs ‘quoted’')).toBe("it's 'quoted'");
  });

  test('folds every dash variant to a hyphen', () => {
    expect(normaliseText('GPT‑5 – GPT—5 − GPT‐5')).toBe('GPT-5 - GPT-5 - GPT-5');
  });

  test('applies NFKC (full-width, ligatures, non-breaking space)', () => {
    expect(normaliseText('ＧＰＴ')).toBe('GPT');
    expect(normaliseText('a b')).toBe('a b');
    expect(normaliseText('ﬁne')).toBe('fine');
  });

  test('drops zero-width and soft-hyphen characters', () => {
    expect(normaliseText('GPT​-­5')).toBe('GPT-5');
  });

  test('preserves case; normaliseForMatch lowers it', () => {
    expect(normaliseText('Claude Opus')).toBe('Claude Opus');
    expect(normaliseForMatch('Claude Opus')).toBe('claude opus');
  });
});

describe('quoteMatches', () => {
  const page = `Introducing Claude Opus 4.5

    Claude Opus 4.5 is available today. It scores 80.9% on SWE-bench Verified and
    processes 1,234,567 tokens per request.`;

  test('finds a plain quote', () => {
    expect(quoteMatches(page, 'Claude Opus 4.5 is available today')).toBe(true);
  });

  test('matches across curly-quote and dash differences', () => {
    expect(quoteMatches('The model — named GPT‑5 — is “out”', 'The model - named GPT-5 - is "out"')).toBe(true);
  });

  test('matches across line breaks and doubled spaces', () => {
    expect(quoteMatches(page, 'It scores 80.9% on SWE-bench Verified and processes')).toBe(true);
  });

  test('ignores thousands separators', () => {
    expect(quoteMatches(page, 'processes 1234567 tokens')).toBe(true);
    expect(quoteMatches('processes 1234567 tokens', 'processes 1,234,567 tokens')).toBe(true);
  });

  test('is case-insensitive', () => {
    expect(quoteMatches(page, 'CLAUDE OPUS 4.5 IS AVAILABLE TODAY')).toBe(true);
  });

  test('rejects text that is not on the page', () => {
    expect(quoteMatches(page, 'Claude Opus 4.5 scores 99.9% on ARC-AGI-2')).toBe(false);
  });

  test('rejects empty and missing quotes', () => {
    expect(quoteMatches(page, '')).toBe(false);
    expect(quoteMatches(page, undefined)).toBe(false);
    expect(quoteMatches('', 'anything')).toBe(false);
  });

  test('matches a sentence that runs through a Markdown link (r.jina.ai output)', () => {
    // Real case: OpenAI DevDay, read through r.jina.ai.
    const proxied =
      "developers in July. Today we're launching a preview of the next generation of this model, " +
      '[GPT-4 Turbo(opens in a new window)](https://platform.openai.com/docs/models).';
    expect(quoteMatches(proxied, "Today we're launching a preview of the next generation of this model, GPT‑4 Turbo.")).toBe(true);
  });

  test('matches across screen-reader boilerplate inside an HTML link', () => {
    const page = 'Claude Opus 5 (opens in a new window) is available today.';
    expect(quoteMatches(page, 'Claude Opus 5 is available today.')).toBe(true);
  });

  test('stripping decorations does not invent a match', () => {
    const page = '[Some other model](https://x.example) is available today.';
    expect(quoteMatches(page, 'GPT-6 is available today.')).toBe(false);
  });

  test('a short quote is not matched by the space-insensitive pass', () => {
    // "a b c" would collapse to "abc" and hit "abcdef" — too short to be safe, so it must fail.
    expect(quoteMatches('abcdef', 'a b c')).toBe(false);
  });
});

describe('stripMarkdownLinks / stripLinkDecoration', () => {
  test('keeps the label and drops the target', () => {
    expect(stripMarkdownLinks('see [GPT-6](https://openai.com/x) today')).toBe('see GPT-6 today');
    expect(stripMarkdownLinks('see [GPT-6](https://openai.com/x "title") today')).toBe('see GPT-6 today');
  });

  test('leaves ordinary brackets and parentheses alone', () => {
    expect(stripMarkdownLinks('an array [1, 2] and a note (see below)')).toBe('an array [1, 2] and a note (see below)');
  });

  test('drops accessibility boilerplate and re-collapses spaces', () => {
    expect(stripLinkDecoration('GPT-6 (opens in a new window) ships today')).toBe('GPT-6 ships today');
    expect(stripLinkDecoration('GPT-6 (opens in a new tab) ships')).toBe('GPT-6 ships');
  });
});

describe('quoteContainsValue', () => {
  test('accepts the number as printed', () => {
    expect(quoteContainsValue('80.9% on SWE-bench Verified', 80.9)).toBe(true);
  });

  test('accepts an integer printed with one decimal', () => {
    expect(quoteContainsValue('scores 88.0% on MMLU', 88)).toBe(true);
    expect(quoteContainsValue('scores 88% on MMLU', 88)).toBe(true);
  });

  test('rejects a quote without the number', () => {
    expect(quoteContainsValue('state of the art on SWE-bench Verified', 80.9)).toBe(false);
  });
});

describe('stripNumberCommas', () => {
  test('only removes separators between digits', () => {
    expect(stripNumberCommas('1,234,567 and a, b')).toBe('1234567 and a, b');
  });
});

describe('slugify / releaseId', () => {
  test.each([
    ['GPT-5.1', 'gpt-5.1'],
    ['Claude Opus 4.5', 'claude-opus-4.5'],
    ['DeepSeek-V3.2-Exp', 'deepseek-v3.2-exp'],
    ['Qwen3-Max', 'qwen3-max'],
    ['Gemini 3 Pro', 'gemini-3-pro'],
    ['  Kimi   K2.5  ', 'kimi-k2.5'],
    ['Llama 4 (Behemoth)', 'llama-4-behemoth'],
    // NFKC turns the superscript into a plain 2; non-Latin letters are dropped.
    ['τ² Model 1', '2-model-1'],
  ])('%s -> %s', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  test('release ids satisfy the shared schema regex', () => {
    for (const [lab, name] of [
      ['openai', 'GPT-5.1'],
      ['anthropic', 'Claude Opus 4.5'],
      ['moonshot', 'Kimi K2.5'],
      ['meta', 'Llama 4'],
    ] as const) {
      expect(isValidReleaseId(releaseId(lab, name))).toBe(true);
    }
    expect(releaseId('openai', 'GPT-5.1')).toBe('openai-gpt-5.1');
  });

  test('rejects ids that would not match the schema', () => {
    expect(isValidReleaseId('openai')).toBe(false);
    expect(isValidReleaseId('openai--gpt')).toBe(false);
    expect(isValidReleaseId('OpenAI-GPT')).toBe(false);
  });
});

describe('nameKey', () => {
  test('is case- and space-insensitive but keeps version dots', () => {
    expect(nameKey('GPT-5.1')).toBe(nameKey('gpt 5.1'));
    expect(nameKey('Claude Opus 4.5')).toBe(nameKey('  claude   opus  4.5 '));
    expect(nameKey('GPT-5.1')).not.toBe(nameKey('GPT-5'));
  });
});

describe('sha256 / truncate', () => {
  test('hash is stable and content-sensitive', () => {
    expect(sha256('a')).toBe(sha256('a'));
    expect(sha256('a')).not.toBe(sha256('b'));
    expect(sha256('a')).toHaveLength(64);
  });

  test('truncate keeps short text untouched and marks long text', () => {
    expect(truncate('short', 100)).toBe('short');
    const long = 'word '.repeat(100);
    const cut = truncate(long, 50);
    expect(cut.length).toBeLessThan(long.length);
    expect(cut.endsWith('[...truncated]')).toBe(true);
  });
});

describe('quoteMatches — alphanumeric pass', () => {
  test('matches a markdown table row against a plain-text rendering of the same table', () => {
    const page = 'Benchmark GPT-4 Claude 3 Opus Gemini Ultra MMLU 86.4% 86.8% 83.7% GPQA 35.7% 50.4% 47.9%';
    expect(quoteMatches(page, '| MMLU | 86.4% | 86.8% | 83.7% |')).toBe(true);
    expect(quoteMatches(page, '| GPQA | 35.7% | 50.4% | 47.9% |')).toBe(true);
  });
  test('does not match short alphanumeric runs', () => {
    expect(quoteMatches('score 81.3 and 86.2 elsewhere', '| X | 81.3% |')).toBe(false);
  });
});
