/**
 * Cheap, LLM-free pre-filter. Everything that survives costs one OpenRouter call,
 * so this is the main cost lever after the page hash-diff.
 */
import type { SourceItem } from './items';
import { normaliseForMatch } from './text';

/** Words that almost always accompany a flagship announcement, regardless of lab. */
export const GENERIC_PATTERNS: RegExp[] = [
  /\bintroduc(?:ing|e|es)\b/i,
  /\bannounc(?:ing|e|es|ed|ement)\b/i,
  /\bunveil(?:ing|s|ed)?\b/i,
  /\bmodels?\b/i,
  /\brelease[sd]?\b/i,
  /\blaunch(?:ing|es|ed)?\b/i,
  /\bgpt\b|\bgpt-\d/i,
  /\bclaude\b/i,
  /\bgemini\b/i,
  /\bgrok\b/i,
  /\bllama\b/i,
  /\bdeepseek\b/i,
  /\bqwen\d*\b/i,
  /\bkimi\b/i,
  /\bglm\b/i,
  /\bmistral\b|\bmagistral\b/i,
];

export interface CandidateVerdict {
  candidate: boolean;
  /** Which rule fired, for the debug log and the `--dry-run` table. */
  reason: string;
}

/** Compile `flagship_hints` once per lab; a bad regex in data must not crash the worker. */
export function compileHints(hints: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const h of hints) {
    try {
      out.push(new RegExp(h, 'i'));
    } catch {
      /* invalid regex in labs.json — ignored, validate warns about it */
    }
  }
  return out;
}

/** Title plus the last path segment of the link, which is where slugs like `claude-opus-4-5` live. */
export function haystack(item: SourceItem): string {
  const parts = [item.title];
  if (item.link) {
    try {
      const path = new URL(item.link).pathname.replace(/\/+$/, '');
      const last = path.slice(path.lastIndexOf('/') + 1);
      if (last) parts.push(last.replace(/[-_]+/g, ' '));
    } catch {
      /* not a URL — title alone */
    }
  }
  return normaliseForMatch(parts.join(' '));
}

export function isCandidate(item: SourceItem, hints: RegExp[]): CandidateVerdict {
  const text = haystack(item);
  if (!text) return { candidate: false, reason: 'empty' };
  for (const re of hints) {
    if (re.test(text)) return { candidate: true, reason: `hint:${re.source}` };
  }
  for (const re of GENERIC_PATTERNS) {
    if (re.test(text)) return { candidate: true, reason: `keyword:${re.source}` };
  }
  return { candidate: false, reason: 'no match' };
}

/** Hint matches first — those are the most likely flagship posts and the budget is finite. */
export function rankCandidates(items: SourceItem[], hints: RegExp[]): { item: SourceItem; reason: string }[] {
  const out: { item: SourceItem; reason: string; rank: number }[] = [];
  for (const item of items) {
    const v = isCandidate(item, hints);
    if (!v.candidate) continue;
    out.push({ item, reason: v.reason, rank: v.reason.startsWith('hint:') ? 0 : 1 });
  }
  out.sort((a, b) => a.rank - b.rank);
  return out.map(({ item, reason }) => ({ item, reason }));
}
