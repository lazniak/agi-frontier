import { describe, expect, test } from 'bun:test';
import { LabFileSchema } from '@agi/shared';
import type { LabFile } from '@agi/shared';
import { mergeReleases, type MergeContext } from '../src/merge';
import { stringifyLabFile } from '../src/canonical';
import type { NormalisedRelease } from '../src/llm';

const NOW = '2026-09-07T04:00:00Z';
const ctx: MergeContext = {
  now: NOW,
  sourceUrl: 'https://openai.com/index/introducing-gpt-6/',
  sourceTitle: 'Introducing GPT-6',
};

function emptyFile(): LabFile {
  return { lab: 'openai', updated_at: '2026-01-01T00:00:00Z', releases: [] };
}

function release(over: Partial<NormalisedRelease> = {}): NormalisedRelease {
  return {
    name: 'GPT-6',
    family: 'GPT',
    status: 'released',
    date: '2026-05-04',
    date_precision: 'day',
    announcement_quote: 'GPT-6 is available today in the API.',
    scores: [{ benchmark: 'gpqa-diamond', value: 92.4, config: 'no tools', quote: '92.4% on GPQA Diamond' }],
    ...over,
  };
}

describe('mergeReleases — new release', () => {
  const result = mergeReleases(emptyFile(), [release()], ctx);
  const added = result.file.releases[0];

  test('builds a schema-valid release with a lab-prefixed slug id', () => {
    expect(result.changed).toBe(true);
    expect(added?.id).toBe('openai-gpt-6');
    expect(LabFileSchema.safeParse(result.file).success).toBe(true);
  });

  test('stamps retrieved_at and marks the already-checked quote verified', () => {
    expect(added?.announcement.retrieved_at).toBe(NOW);
    expect(added?.announcement.verified).toBe(true);
    expect(added?.announcement.verified_at).toBe(NOW);
    expect(added?.announcement.url).toBe(ctx.sourceUrl);
  });

  test('records scores as official with their quote', () => {
    expect(added?.scores).toHaveLength(1);
    expect(added?.scores[0]?.reported_by).toBe('official');
    expect(added?.scores[0]?.source.quote).toBe('92.4% on GPQA Diamond');
    expect(added?.scores[0]?.config).toBe('no tools');
  });

  test('carries `via` through to every source it writes', () => {
    const viaResult = mergeReleases(emptyFile(), [release()], { ...ctx, via: 'r.jina.ai' });
    expect(viaResult.file.releases[0]?.announcement.via).toBe('r.jina.ai');
    expect(viaResult.file.releases[0]?.scores[0]?.source.via).toBe('r.jina.ai');
  });

  test('emits one release_added change event', () => {
    expect(result.changes.map((c) => c.kind)).toEqual(['release_added']);
    expect(result.changes[0]?.at).toBe(NOW);
    expect(result.changes[0]?.source_url).toBe(ctx.sourceUrl);
  });

  test('bumps updated_at only because something changed', () => {
    expect(result.file.updated_at).toBe(NOW);
    expect(mergeReleases(emptyFile(), [], ctx).file.updated_at).toBe('2026-01-01T00:00:00Z');
  });
});

describe('mergeReleases — idempotence', () => {
  test('running the same extraction twice yields a byte-identical file', () => {
    const first = mergeReleases(emptyFile(), [release()], ctx);
    const second = mergeReleases(first.file, [release()], { ...ctx, now: '2026-09-08T04:00:00Z' });
    expect(second.changed).toBe(false);
    expect(second.changes).toHaveLength(0);
    expect(stringifyLabFile(second.file)).toBe(stringifyLabFile(first.file));
  });

  test('three runs are still identical', () => {
    let file = emptyFile();
    const outputs: string[] = [];
    for (let i = 0; i < 3; i++) {
      file = mergeReleases(file, [release()], ctx).file;
      outputs.push(stringifyLabFile(file));
    }
    expect(new Set(outputs).size).toBe(1);
  });

  test('matches an existing release by name regardless of case and spacing', () => {
    const first = mergeReleases(emptyFile(), [release({ name: 'GPT-6' })], ctx);
    const second = mergeReleases(first.file, [release({ name: 'gpt 6' })], ctx);
    expect(second.file.releases).toHaveLength(1);
    expect(second.changed).toBe(false);
  });
});

describe('mergeReleases — updating an existing release', () => {
  const base = mergeReleases(
    emptyFile(),
    [release({ status: 'announced', date: '2026-05-01', date_precision: 'month', scores: [] })],
    ctx,
  ).file;

  test('adds a score whose benchmark+config is not present yet', () => {
    const next = mergeReleases(base, [release()], ctx);
    expect(next.file.releases[0]?.scores).toHaveLength(1);
    expect(next.changes.some((c) => c.kind === 'score_added')).toBe(true);
  });

  test('keeps a differing config as a separate score', () => {
    const withScore = mergeReleases(base, [release()], ctx).file;
    const other = release({ scores: [{ benchmark: 'gpqa-diamond', value: 94.1, config: 'with tools', quote: '94.1% on GPQA Diamond' }] });
    const next = mergeReleases(withScore, [other], ctx);
    expect(next.file.releases[0]?.scores).toHaveLength(2);
  });

  test('upgrades announced -> released and records status_changed', () => {
    const next = mergeReleases(base, [release({ status: 'released' })], ctx);
    expect(next.file.releases[0]?.status).toBe('released');
    expect(next.changes.some((c) => c.kind === 'status_changed')).toBe(true);
  });

  test('never downgrades a status', () => {
    const released = mergeReleases(base, [release({ status: 'released' })], ctx).file;
    const next = mergeReleases(released, [release({ status: 'announced' })], ctx);
    expect(next.file.releases[0]?.status).toBe('released');
    expect(next.changes.some((c) => c.kind === 'status_changed')).toBe(false);
  });

  test('never touches a cancelled release', () => {
    const cancelled: LabFile = {
      ...base,
      releases: base.releases.map((r) => ({ ...r, status: 'cancelled' as const })),
    };
    const next = mergeReleases(cancelled, [release({ status: 'released' })], ctx);
    expect(next.file.releases[0]?.status).toBe('cancelled');
  });

  test('refuses released when the date precision would stay unknown', () => {
    const vague = mergeReleases(
      emptyFile(),
      [release({ status: 'announced', date_precision: 'unknown', scores: [] })],
      ctx,
    ).file;
    const next = mergeReleases(vague, [release({ status: 'released', date_precision: 'unknown', scores: [] })], ctx);
    expect(next.file.releases[0]?.status).toBe('announced');
    expect(next.notes.join(' ')).toContain('released needs a known date precision');
  });

  test('improves date precision month -> day but never the other way', () => {
    const sharper = mergeReleases(base, [release({ date: '2026-05-04', date_precision: 'day' })], ctx);
    expect(sharper.file.releases[0]?.date).toBe('2026-05-04');
    expect(sharper.file.releases[0]?.date_precision).toBe('day');

    const blunter = mergeReleases(sharper.file, [release({ date: '2026-05-01', date_precision: 'month' })], ctx);
    expect(blunter.file.releases[0]?.date).toBe('2026-05-04');
    expect(blunter.file.releases[0]?.date_precision).toBe('day');
  });

  test('adds the page that produced a change as a supporting source, once', () => {
    const other = { ...ctx, sourceUrl: 'https://openai.com/index/gpt-6-system-card/' };
    const next = mergeReleases(base, [release()], other);
    expect(next.file.releases[0]?.sources?.map((s) => s.url)).toEqual([other.sourceUrl]);
    const again = mergeReleases(next.file, [release()], other);
    expect(again.file.releases[0]?.sources).toHaveLength(1);
  });

  test('does not add a source when nothing changed', () => {
    const done = mergeReleases(base, [release()], ctx).file;
    expect(done.releases[0]?.sources).toBeUndefined(); // the page is already the announcement
    const noop = mergeReleases(done, [release()], { ...ctx, sourceUrl: 'https://openai.com/index/unrelated/' });
    expect(noop.changed).toBe(false);
    expect(noop.file.releases[0]?.sources).toBeUndefined();
  });
});

describe('mergeReleases — id collisions and bad names', () => {
  test('a second model with the same slug gets a suffixed id', () => {
    const file = mergeReleases(emptyFile(), [release({ name: 'GPT-6' })], ctx).file;
    const collide: LabFile = { ...file, releases: [{ ...file.releases[0]!, name: 'Something Else' }] };
    const next = mergeReleases(collide, [release({ name: 'GPT-6' })], ctx);
    expect(next.file.releases.map((r) => r.id)).toEqual(['openai-gpt-6', 'openai-gpt-6-2']);
    expect(LabFileSchema.safeParse(next.file).success).toBe(true);
  });

  test('a name with no usable characters is skipped, not crashed on', () => {
    const next = mergeReleases(emptyFile(), [release({ name: '???' })], ctx);
    expect(next.file.releases).toHaveLength(0);
    expect(next.notes[0]).toContain('no usable characters');
  });
});

describe('mergeReleases — tiers never demote', () => {
  test('a new release records the explicit extraction tier, not the context tier', () => {
    const explicit = mergeReleases(emptyFile(), [release({ tier: 'small' })], { ...ctx, tier: 'flagship' });
    expect(explicit.file.releases[0]?.tier).toBe('small');
    // No tier anywhere: the field stays unset (unset = flagship by contract).
    const untiered = mergeReleases(emptyFile(), [release({ tier: undefined })], ctx);
    expect(untiered.file.releases[0]?.tier).toBeUndefined();
  });

  test('an existing tier is never overwritten, not even by an explicit extraction tier', () => {
    const seeded: LabFile = {
      ...emptyFile(),
      releases: [{ ...emptyFile().releases[0], id: 'openai-gpt-6', lab: 'openai', name: 'GPT-6', family: 'GPT', date: '2026-05-04', date_precision: 'day' as const, status: 'released' as const, announcement: { url: ctx.sourceUrl, retrieved_at: NOW, verified: true }, scores: [], tier: 'flagship' }],
    };
    const next = mergeReleases(seeded, [release({ tier: 'mid' })], ctx);
    expect(next.file.releases[0]?.tier).toBe('flagship');
    expect(next.changes.some((c) => c.kind === 'release_updated')).toBe(false);
  });

  test('an explicit mid/small fills an untiered release exactly once', () => {
    const seeded: LabFile = {
      ...emptyFile(),
      releases: [{ ...emptyFile().releases[0], id: 'openai-gpt-6', lab: 'openai', name: 'GPT-6', family: 'GPT', date: '2026-05-04', date_precision: 'day' as const, status: 'released' as const, announcement: { url: ctx.sourceUrl, retrieved_at: NOW, verified: true }, scores: [] }],
    };
    const first = mergeReleases(seeded, [release({ tier: 'mid' })], ctx);
    expect(first.file.releases[0]?.tier).toBe('mid');
    expect(first.changes.some((c) => c.kind === 'release_updated')).toBe(true);
    // A hint-derived `flagship` (rel.tier undefined) may not retag it; a later `small`
    // may not flip it either.
    const hintFlagship = mergeReleases(first.file, [release({ tier: undefined })], ctx);
    expect(hintFlagship.file.releases[0]?.tier).toBe('mid');
    const smaller = mergeReleases(hintFlagship.file, [release({ tier: 'small' })], ctx);
    expect(smaller.file.releases[0]?.tier).toBe('mid');
  });
});
