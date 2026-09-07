/**
 * Re-fetch every source URL in `data/models/*.json` and check that its `quote` really is a
 * substring of the page. Writes `verified` / `verified_at` back and appends one `verified`
 * ChangeEvent per release. This is the audit that keeps the site honest over time.
 */
import type { ChangeEvent, LabId, ModelRelease, Source } from '@agi/shared';
import { appendChanges, readLabFiles, writeLabFile } from '../data-store';
import { isoNow } from '../fetcher';
import { print } from '../log';
import { change } from '../merge';
import { quoteMatches } from '../text';
import type { Runtime } from '../runtime';

export interface VerifyOptions {
  lab?: LabId;
  onlyUnverified?: boolean;
  limit?: number;
}

interface SourceRef {
  lab: LabId;
  release: ModelRelease;
  /** Where the source sits, for the report: `announcement`, `sources[1]`, `score:gpqa-diamond`, ... */
  where: string;
  source: Source;
}

export async function runVerify(rt: Runtime, opts: VerifyOptions = {}): Promise<number> {
  const now = isoNow();
  const files = readLabFiles(rt.config.dataDir).filter((f) => !opts.lab || f.file.lab === opts.lab);
  if (files.length === 0) {
    print('no lab files to verify');
    return 0;
  }

  const unverified: { lab: string; release: string; where: string; url: string; reason: string; quote: string }[] = [];
  const changes: ChangeEvent[] = [];
  let checked = 0;
  let ok = 0;
  let failed = 0;
  let skippedNoQuote = 0;
  let budget = opts.limit ?? Number.POSITIVE_INFINITY;

  for (const loaded of files) {
    let touched = false;
    for (const release of loaded.file.releases) {
      let relChecked = 0;
      let relOk = 0;
      for (const ref of releaseSourceRefs(loaded.file.lab, release)) {
        if (budget <= 0) break;
        const { source } = ref;
        if (!source.quote) {
          skippedNoQuote++;
          continue;
        }
        if (opts.onlyUnverified && source.verified === true) continue;

        budget--;
        checked++;
        relChecked++;
        const page = await rt.fetcher(source.url, { minTextLength: 200 });
        const matched = page.ok && quoteMatches(page.text, source.quote);
        source.verified = matched;
        source.verified_at = now;
        if (page.via) source.via = page.via;
        else if (page.ok && source.via) delete source.via;
        touched = true;

        if (matched) {
          ok++;
          relOk++;
        } else {
          failed++;
          unverified.push({
            lab: loaded.file.lab,
            release: release.id,
            where: ref.where,
            url: source.url,
            reason: page.ok ? 'quote not found on page' : `fetch failed (status ${page.status}${page.error ? `: ${page.error}` : ''})`,
            quote: source.quote,
          });
        }
        rt.log.debug('verified source', {
          lab: loaded.file.lab,
          release: release.id,
          where: ref.where,
          url: source.url,
          matched,
          via: page.via,
        });
      }
      if (relChecked > 0) {
        changes.push(
          change(
            now,
            'worker',
            loaded.file.lab,
            release.id,
            'verified',
            `${relOk}/${relChecked} quotes verified`,
            release.announcement.url,
          ),
        );
      }
    }
    if (touched) {
      loaded.file.updated_at = now;
      writeLabFile(rt.config.dataDir, loaded.file);
    }
  }

  if (changes.length > 0) appendChanges(rt.config.dataDir, changes);

  print('');
  if (unverified.length === 0) {
    print(`verify: ${ok}/${checked} quotes verified, ${skippedNoQuote} source(s) without a quote — nothing unverified`);
  } else {
    print(`verify: ${ok}/${checked} verified, ${failed} UNVERIFIED, ${skippedNoQuote} without a quote`);
    print('');
    print(formatTable(
      ['lab', 'release', 'where', 'reason', 'url'],
      unverified.map((u) => [u.lab, u.release, u.where, u.reason, u.url]),
    ));
    print('');
    for (const u of unverified) print(`  ${u.release} ${u.where}: "${truncateQuote(u.quote)}"`);
  }
  return 0;
}

function releaseSourceRefs(lab: LabId, release: ModelRelease): SourceRef[] {
  const refs: SourceRef[] = [{ lab, release, where: 'announcement', source: release.announcement }];
  (release.sources ?? []).forEach((source, i) => refs.push({ lab, release, where: `sources[${i}]`, source }));
  release.scores.forEach((s) => refs.push({ lab, release, where: `score:${s.benchmark}`, source: s.source }));
  if (release.expected_window) {
    refs.push({ lab, release, where: 'expected_window', source: release.expected_window.source });
  }
  return refs;
}

function truncateQuote(q: string): string {
  return q.length <= 90 ? q : q.slice(0, 87) + '...';
}

export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}
