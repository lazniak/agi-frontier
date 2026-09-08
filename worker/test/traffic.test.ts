/**
 * Traffic-scaled research cadence (REDESIGN §12.8).
 *
 * Three things are being defended here, in order of how badly they would hurt if they broke:
 * the privacy properties (no address anywhere in what we persist), the counting (a visitor number
 * shown on a public site must not double-count a crash or lose a day), and the tier arithmetic.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '../src/log';
import { createRuntime } from '../src/runtime';
import { refreshCadence, shouldArena, shouldBackfill } from '../src/commands/loop';
import { EMPTY_RUN_STATE, StateStore } from '../src/state';
import {
  CADENCE_TIERS,
  EMPTY_TRAFFIC_STATE,
  MAX_LOG_BYTES,
  applyHysteresis,
  computeCadence,
  hashAddress,
  ingestTrafficLog,
  ingestVisits,
  monthToDateUsd,
  parseTrafficLine,
  parseTrafficLog,
  tierFor,
  truncateTrafficLog,
  utcDay,
  visitorsPerDay,
  type TrafficState,
  type TrafficVisit,
} from '../src/traffic';

const tmp = mkdtempSync(join(tmpdir(), 'agi-traffic-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0';

function line(parts: Partial<{ addr: string; ts: string; method: string; uri: string; status: string; ua: string }> = {}): string {
  const p = {
    addr: '203.0.113.7',
    ts: '2026-09-08T10:00:00+00:00',
    method: 'GET',
    uri: '/latest.json',
    status: '200',
    ua: BROWSER_UA,
    ...parts,
  };
  return `${p.addr}|${p.ts}|${p.method}|${p.uri}|${p.status}|${p.ua}`;
}

/** Deterministic salts so a test can assert on hashes without depending on randomness. */
function fixedSalts(prefix = 's'): () => string {
  let n = 0;
  return () => `${prefix}${n++}`;
}

const visit = (day: string, address: string): TrafficVisit => ({ day, address });

describe('parseTrafficLine', () => {
  test('a plain browser hit on /latest.json is one visit', () => {
    expect(parseTrafficLine(line())).toEqual({ day: '2026-09-08', address: '203.0.113.7' });
  });

  test('a forwarded-for chain counts the first address — the client, not the proxies', () => {
    expect(parseTrafficLine(line({ addr: '203.0.113.7, 198.51.100.4, 10.0.0.1' }))).toEqual({
      day: '2026-09-08',
      address: '203.0.113.7',
    });
  });

  test('IPv6 survives the address check (colons are not a field separator here)', () => {
    expect(parseTrafficLine(line({ addr: '2001:db8::42' }))).toEqual({ day: '2026-09-08', address: '2001:db8::42' });
  });

  test('bots are dropped by user-agent, not counted as malformed', () => {
    for (const ua of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0)',
      'AhrefsSpider/1.0',
      'curl/8.7.1',
      'Wget/1.21',
      'python-requests/2.32.3',
      'Go-http-client/2.0',
      'Mozilla/5.0 HeadlessChrome/131.0.0.0',
      'SomeCrawler/1.0',
    ]) {
      expect(parseTrafficLine(line({ ua }))).toBe('bot');
    }
  });

  test('anything that is not a served GET /latest.json is ignored', () => {
    expect(parseTrafficLine(line({ uri: '/' }))).toBe('ignored');
    expect(parseTrafficLine(line({ uri: '/assets/app-9f3.js' }))).toBe('ignored');
    expect(parseTrafficLine(line({ method: 'HEAD' }))).toBe('ignored');
    expect(parseTrafficLine(line({ status: '404' }))).toBe('ignored');
    expect(parseTrafficLine(line({ status: '500' }))).toBe('ignored');
    expect(parseTrafficLine('')).toBe('ignored');
    expect(parseTrafficLine('   ')).toBe('ignored');
  });

  test('a 304 is still a page load: the bundle is cached for 300 s, the visitor is real', () => {
    expect(parseTrafficLine(line({ status: '304' }))).toEqual({ day: '2026-09-08', address: '203.0.113.7' });
  });

  test('malformed lines are skipped rather than guessed at', () => {
    expect(parseTrafficLine('203.0.113.7|2026-09-08T10:00:00+00:00|GET')).toBeNull(); // torn write
    expect(parseTrafficLine(line({ addr: '-' }))).toBeNull(); // no X-Forwarded-For header
    expect(parseTrafficLine(line({ addr: '' }))).toBeNull();
    expect(parseTrafficLine(line({ addr: 'not an address' }))).toBeNull();
    expect(parseTrafficLine(line({ ts: 'yesterday' }))).toBeNull();
    expect(parseTrafficLine(line({ status: 'x' }))).toBeNull();
  });

  test('a user-agent containing a pipe does not shift the fields', () => {
    const parsed = parseTrafficLine(line({ ua: 'Weird/1.0 (a|b|c)' }));
    expect(parsed).toEqual({ day: '2026-09-08', address: '203.0.113.7' });
  });

  test('parseTrafficLog counts each rejection reason separately', () => {
    const log = [
      line(),
      line({ addr: '198.51.100.9' }),
      line({ ua: 'Googlebot/2.1' }),
      line({ uri: '/' }),
      'garbage',
      '',
    ].join('\n');
    const r = parseTrafficLog(log);
    expect(r.visits).toHaveLength(2);
    expect(r.bots).toBe(1);
    expect(r.ignored).toBe(2); // the "/" hit and the trailing empty line
    expect(r.malformed).toBe(1);
  });
});

describe('UTC day boundaries', () => {
  test('the day rolls at 00:00 UTC, not at any local midnight', () => {
    expect(parseTrafficLine(line({ ts: '2026-09-08T23:59:59+00:00' }))).toEqual({ day: '2026-09-08', address: '203.0.113.7' });
    expect(parseTrafficLine(line({ ts: '2026-09-09T00:00:00+00:00' }))).toEqual({ day: '2026-09-09', address: '203.0.113.7' });
  });

  test('an offset timestamp is converted before the date is taken', () => {
    // 2026-09-09T01:30+02:00 is 2026-09-08T23:30Z — still the 8th.
    expect(parseTrafficLine(line({ ts: '2026-09-09T01:30:00+02:00' }))).toEqual({ day: '2026-09-08', address: '203.0.113.7' });
    // 2026-09-08T22:30-04:00 is 2026-09-09T02:30Z — already the 9th.
    expect(parseTrafficLine(line({ ts: '2026-09-08T22:30:00-04:00' }))).toEqual({ day: '2026-09-09', address: '203.0.113.7' });
  });

  test('utcDay agrees with the ISO prefix', () => {
    expect(utcDay(Date.parse('2026-01-01T00:00:00Z'))).toBe('2026-01-01');
    expect(utcDay(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12-31');
  });
});

describe('unique counting', () => {
  const now = Date.parse('2026-09-08T12:00:00Z');

  test('the same address several times in a day is one visitor', () => {
    const s = ingestVisits(EMPTY_TRAFFIC_STATE, [visit('2026-09-08', '203.0.113.7'), visit('2026-09-08', '203.0.113.7')], now, fixedSalts());
    expect(s.open?.hashes).toHaveLength(1);
  });

  test('different addresses are different visitors', () => {
    const s = ingestVisits(
      EMPTY_TRAFFIC_STATE,
      [visit('2026-09-08', '203.0.113.7'), visit('2026-09-08', '198.51.100.4'), visit('2026-09-08', '203.0.113.7')],
      now,
      fixedSalts(),
    );
    expect(s.open?.hashes).toHaveLength(2);
  });

  test('a day closes to a bare count and the salt goes with the hashes', () => {
    const day1 = ingestVisits(
      EMPTY_TRAFFIC_STATE,
      [visit('2026-09-08', '203.0.113.7'), visit('2026-09-08', '198.51.100.4')],
      now,
      fixedSalts(),
    );
    const day2 = ingestVisits(day1, [], Date.parse('2026-09-09T00:05:00Z'), fixedSalts('t'));
    expect(day2.days).toEqual([{ date: '2026-09-08', unique: 2 }]);
    expect(day2.open).toBeNull();
    expect(JSON.stringify(day2)).not.toContain('s0'); // the salt did not survive the close
  });

  test('the same visitor on two days counts once per day, with unlinkable hashes', () => {
    const salts = fixedSalts();
    const d1 = ingestVisits(EMPTY_TRAFFIC_STATE, [visit('2026-09-08', '203.0.113.7')], now, salts);
    const d2 = ingestVisits(d1, [visit('2026-09-09', '203.0.113.7')], Date.parse('2026-09-09T09:00:00Z'), salts);
    expect(d2.days).toEqual([{ date: '2026-09-08', unique: 1 }]);
    expect(d2.open?.hashes).toHaveLength(1);
    // Different per-day salt ⇒ the same address hashes differently, so days cannot be joined.
    expect(d2.open?.hashes[0]).not.toBe(d1.open?.hashes[0]);
  });

  test('out-of-order lines still land in the right day', () => {
    const s = ingestVisits(
      EMPTY_TRAFFIC_STATE,
      [visit('2026-09-09', '203.0.113.7'), visit('2026-09-08', '198.51.100.4'), visit('2026-09-09', '203.0.113.7')],
      Date.parse('2026-09-09T09:00:00Z'),
      fixedSalts(),
    );
    expect(s.days).toEqual([{ date: '2026-09-08', unique: 1 }]);
    expect(s.open?.date).toBe('2026-09-09');
    expect(s.open?.hashes).toHaveLength(1);
  });

  test('only 14 closed days are retained', () => {
    let s: TrafficState = EMPTY_TRAFFIC_STATE;
    for (let i = 0; i < 20; i++) {
      const day = utcDay(Date.parse('2026-09-01T00:00:00Z') + i * 86_400_000);
      s = ingestVisits(s, [visit(day, `203.0.113.${i}`)], Date.parse(`${day}T12:00:00Z`), fixedSalts(`x${i}`));
    }
    expect(s.days).toHaveLength(14);
    expect(s.days[0]?.date).toBe('2026-09-06'); // days 1–5 dropped, 6–19 kept, 20 still open
    expect(s.open?.date).toBe('2026-09-20');
  });

  test('no raw address appears anywhere in the persisted state', () => {
    const s = ingestVisits(
      EMPTY_TRAFFIC_STATE,
      [visit('2026-09-08', '203.0.113.7'), visit('2026-09-08', '2001:db8::42')],
      now,
      fixedSalts(),
    );
    const json = JSON.stringify(s);
    expect(json).not.toContain('203.0.113.7');
    expect(json).not.toContain('2001:db8');
    expect(s.open?.hashes.every((h) => /^[0-9a-f]{12}$/.test(h))).toBe(true);
  });

  test('hashAddress is salted: the same address under two salts is two different hashes', () => {
    expect(hashAddress('203.0.113.7', 'a')).not.toBe(hashAddress('203.0.113.7', 'b'));
    expect(hashAddress('203.0.113.7', 'a')).toBe(hashAddress('203.0.113.7', 'a'));
    expect(hashAddress('203.0.113.7', 'a')).toHaveLength(12);
  });
});

describe('visitorsPerDay', () => {
  const days = (counts: number[]): TrafficState => ({
    ...EMPTY_TRAFFIC_STATE,
    days: counts.map((unique, i) => ({ date: utcDay(Date.parse('2026-09-01T00:00:00Z') + i * 86_400_000), unique })),
  });

  test('nothing measured yet reads as zero over zero days, not as a division by zero', () => {
    expect(visitorsPerDay(EMPTY_TRAFFIC_STATE)).toEqual({ mean: 0, days: 0 });
  });

  test('a young install averages what it has', () => {
    expect(visitorsPerDay(days([4, 6]))).toEqual({ mean: 5, days: 2 });
  });

  test('only the last seven closed days count', () => {
    expect(visitorsPerDay(days([100, 100, 100, 0, 0, 0, 0, 0, 0, 0]))).toEqual({ mean: 0, days: 7 });
  });

  test('the open day is excluded — it is partial and would drag the mean down', () => {
    const s: TrafficState = { ...days([10, 10]), open: { date: '2026-09-03', salt: 's', hashes: ['aa'] } };
    expect(visitorsPerDay(s)).toEqual({ mean: 10, days: 2 });
  });
});

describe('tier mapping (REDESIGN §12.8)', () => {
  test('the published table', () => {
    expect(CADENCE_TIERS.map((t) => [t.id, t.minVisitors, t.intervalHours])).toEqual([
      ['weekly', 0, 168],
      ['often', 3, 72],
      ['daily', 10, 24],
      ['twice-daily', 30, 12],
      ['frequent', 100, 6],
    ]);
  });

  test('every band boundary maps to the right tier', () => {
    expect(tierFor(0).id).toBe('weekly');
    expect(tierFor(2.99).id).toBe('weekly');
    expect(tierFor(3).id).toBe('often');
    expect(tierFor(9.99).id).toBe('often');
    expect(tierFor(10).id).toBe('daily');
    expect(tierFor(29.99).id).toBe('daily');
    expect(tierFor(30).id).toBe('twice-daily');
    expect(tierFor(99.99).id).toBe('twice-daily');
    expect(tierFor(100).id).toBe('frequent');
    expect(tierFor(50_000).id).toBe('frequent');
  });
});

describe('hysteresis', () => {
  const withDays = (tier: TrafficState['tier'], dates: string[], below = 0, belowDate: string | null = null): TrafficState => ({
    ...EMPTY_TRAFFIC_STATE,
    tier,
    below_days: below,
    below_date: belowDate,
    days: dates.map((date) => ({ date, unique: 1 })),
  });

  test('up is immediate — traffic that has arrived deserves fresher data now', () => {
    const s = applyHysteresis(withDays('weekly', ['2026-09-07']), 'daily');
    expect(s.tier).toBe('daily');
    expect(s.below_days).toBe(0);
  });

  test('a jump of several tiers is still taken in one step', () => {
    expect(applyHysteresis(withDays('weekly', ['2026-09-07']), 'frequent').tier).toBe('frequent');
  });

  test('down needs two consecutive closed days below the band', () => {
    const day1 = applyHysteresis(withDays('daily', ['2026-09-07']), 'often');
    expect(day1.tier).toBe('daily');
    expect(day1.below_days).toBe(1);
    expect(day1.below_date).toBe('2026-09-07');

    const day2 = applyHysteresis({ ...day1, days: [...day1.days, { date: '2026-09-08', unique: 1 }] }, 'often');
    expect(day2.tier).toBe('often');
    expect(day2.below_days).toBe(0);
    expect(day2.below_date).toBeNull();
  });

  test('the hourly loop cannot advance the counter twice within one day', () => {
    const first = applyHysteresis(withDays('daily', ['2026-09-07']), 'often');
    const again = applyHysteresis(first, 'often');
    const andAgain = applyHysteresis(again, 'often');
    expect(andAgain.below_days).toBe(1);
    expect(andAgain.tier).toBe('daily');
  });

  test('one quiet day followed by a busy one leaves the tier untouched', () => {
    const quiet = applyHysteresis(withDays('daily', ['2026-09-07']), 'often');
    const busy = applyHysteresis({ ...quiet, days: [...quiet.days, { date: '2026-09-08', unique: 40 }] }, 'daily');
    expect(busy.tier).toBe('daily');
    expect(busy.below_days).toBe(0);
    expect(busy.below_date).toBeNull();
  });

  test('with nothing measured yet the tier cannot drift down', () => {
    expect(applyHysteresis({ ...EMPTY_TRAFFIC_STATE, tier: 'daily' }, 'weekly').tier).toBe('daily');
  });
});

describe('monthly spend guard', () => {
  test('the anchor is taken on the first sight of a month, so a lifetime total is not a debt', () => {
    const r = monthToDateUsd(EMPTY_TRAFFIC_STATE, 412.5, Date.parse('2026-09-08T00:00:00Z'));
    expect(r.usd).toBe(0);
    expect(r.state.spend_month).toBe('2026-09');
    expect(r.state.spend_month_start_usd).toBe(412.5);
  });

  test('within the month it is the difference from the anchor', () => {
    const anchored = monthToDateUsd(EMPTY_TRAFFIC_STATE, 400, Date.parse('2026-09-01T00:00:00Z')).state;
    expect(monthToDateUsd(anchored, 461.25, Date.parse('2026-09-20T00:00:00Z')).usd).toBe(61.25);
  });

  test('a new month resets the anchor', () => {
    const anchored = monthToDateUsd(EMPTY_TRAFFIC_STATE, 400, Date.parse('2026-09-01T00:00:00Z')).state;
    const october = monthToDateUsd(anchored, 470, Date.parse('2026-10-01T00:00:00Z'));
    expect(october.usd).toBe(0);
    expect(october.state.spend_month_start_usd).toBe(470);
  });

  test('a wiped lifetime total cannot produce a negative month', () => {
    const anchored = monthToDateUsd(EMPTY_TRAFFIC_STATE, 400, Date.parse('2026-09-01T00:00:00Z')).state;
    expect(monthToDateUsd(anchored, 0, Date.parse('2026-09-05T00:00:00Z')).usd).toBe(0);
  });
});

describe('computeCadence', () => {
  const busy: TrafficState = {
    ...EMPTY_TRAFFIC_STATE,
    tier: 'daily',
    days: Array.from({ length: 7 }, (_, i) => ({ date: utcDay(Date.parse('2026-09-01T00:00:00Z') + i * 86_400_000), unique: 14 })),
  };
  const now = Date.parse('2026-09-08T12:00:00Z');

  test('14 visitors a day means a daily research run', () => {
    const { cadence } = computeCadence({
      traffic: busy,
      usageTotalUsd: 0,
      monthlyBudgetUsd: 60,
      lastResearchAt: '2026-09-08T06:00:00Z',
      now,
    });
    expect(cadence).toEqual({
      tier: 'daily',
      interval_hours: 24,
      visitors_per_day: 14,
      days_measured: 7,
      capped: false,
      next_research_at: '2026-09-09T06:00:00Z',
    });
  });

  test('a worker that has never researched gets a null stamp, i.e. run now', () => {
    const { cadence } = computeCadence({ traffic: busy, usageTotalUsd: 0, monthlyBudgetUsd: 60, lastResearchAt: null, now });
    expect(cadence.next_research_at).toBeNull();
  });

  test('no traffic at all is the weekly default, honestly labelled as unmeasured', () => {
    const { cadence } = computeCadence({
      traffic: EMPTY_TRAFFIC_STATE,
      usageTotalUsd: 0,
      monthlyBudgetUsd: 60,
      lastResearchAt: '2026-09-01T00:00:00Z',
      now,
    });
    expect(cadence.tier).toBe('weekly');
    expect(cadence.interval_hours).toBe(168);
    expect(cadence.days_measured).toBe(0);
    expect(cadence.visitors_per_day).toBe(0);
    expect(cadence.next_research_at).toBe('2026-09-08T00:00:00Z');
  });

  test('over the monthly budget the cadence drops to weekly and says so', () => {
    const anchored: TrafficState = { ...busy, spend_month: '2026-09', spend_month_start_usd: 10 };
    const { cadence, traffic } = computeCadence({
      traffic: anchored,
      usageTotalUsd: 75,
      monthlyBudgetUsd: 60,
      lastResearchAt: '2026-09-08T06:00:00Z',
      now,
    });
    expect(cadence.capped).toBe(true);
    expect(cadence.tier).toBe('weekly');
    expect(cadence.interval_hours).toBe(168);
    // The cap is an override, not a demotion: the earned tier is still there for next month.
    expect(traffic.tier).toBe('daily');
  });

  test('a zero budget disables the guard rather than wedging the researcher at weekly', () => {
    const anchored: TrafficState = { ...busy, spend_month: '2026-09', spend_month_start_usd: 0 };
    const { cadence } = computeCadence({
      traffic: anchored,
      usageTotalUsd: 999,
      monthlyBudgetUsd: 0,
      lastResearchAt: '2026-09-08T06:00:00Z',
      now,
    });
    expect(cadence.capped).toBe(false);
    expect(cadence.tier).toBe('daily');
  });
});

describe('log ingest and truncation', () => {
  let n = 0;
  const logFile = (): string => join(tmp, `traffic-${n++}.log`);

  test('the state is persisted before the log is truncated, and the log is emptied after', () => {
    const path = logFile();
    writeFileSync(path, [line(), line({ addr: '198.51.100.4' })].join('\n') + '\n');
    let sizeAtCommit = -1;
    const r = ingestTrafficLog({
      path,
      state: EMPTY_TRAFFIC_STATE,
      now: Date.parse('2026-09-08T12:00:00Z'),
      saltFn: fixedSalts(),
      commit: () => {
        sizeAtCommit = statSync(path).size;
      },
    });
    expect(sizeAtCommit).toBeGreaterThan(0); // committed while the log was still there
    expect(statSync(path).size).toBe(0);
    expect(r.truncated).toBe(true);
    expect(r.read).toBe(true);
    expect(r.state.open?.hashes).toHaveLength(2);
  });

  test('a crash between the commit and the truncate cannot double-count on re-read', () => {
    const path = logFile();
    const text = [line(), line({ addr: '198.51.100.4' }), line()].join('\n') + '\n';
    writeFileSync(path, text);
    const now = Date.parse('2026-09-08T12:00:00Z');

    // First pass: state written, then the process dies before truncating.
    const first = ingestTrafficLog({ path, state: EMPTY_TRAFFIC_STATE, now, saltFn: fixedSalts(), commit: () => {} });
    expect(first.state.open?.hashes).toHaveLength(2);

    // Second pass reads exactly the same bytes again.
    const second = ingestTrafficLog({ path, state: first.state, now, saltFn: fixedSalts('t'), commit: () => {} });
    expect(second.state.open?.hashes).toHaveLength(2);
    expect(second.state.open?.hashes).toEqual(first.state.open?.hashes ?? []);
  });

  test('a crash whose replay lands after midnight neither double-counts nor loses the day', () => {
    const path = logFile();
    writeFileSync(path, [line(), line({ addr: '198.51.100.4' })].join('\n') + '\n');
    const first = ingestTrafficLog({
      path,
      state: EMPTY_TRAFFIC_STATE,
      now: Date.parse('2026-09-08T23:59:00Z'),
      saltFn: fixedSalts(),
      commit: () => {},
    });
    // The day closes on the replay, and the replayed lines do not inflate the closed count.
    const replay = ingestTrafficLog({
      path,
      state: first.state,
      now: Date.parse('2026-09-09T00:05:00Z'),
      saltFn: fixedSalts('t'),
      commit: () => {},
    });
    expect(replay.state.days).toEqual([{ date: '2026-09-08', unique: 2 }]);

    // And a third replay against the now-closed day is a no-op rather than an addition.
    const third = ingestTrafficLog({
      path,
      state: replay.state,
      now: Date.parse('2026-09-09T01:00:00Z'),
      saltFn: fixedSalts('u'),
      commit: () => {},
    });
    expect(third.state.days).toEqual([{ date: '2026-09-08', unique: 2 }]);
    expect(third.state.open).toBeNull();
  });

  test('a log that grew during the ingest is left for the next run instead of being clipped', () => {
    const path = logFile();
    writeFileSync(path, line() + '\n');
    const bytes = statSync(path).size;
    writeFileSync(path, line() + '\n' + line({ addr: '198.51.100.4' }) + '\n'); // nginx appended
    expect(truncateTrafficLog(path, bytes)).toBe(false);
    expect(statSync(path).size).toBeGreaterThan(0);
  });

  test('past the hard size cap it truncates anyway — unbounded growth is the worse failure', () => {
    const path = logFile();
    writeFileSync(path, 'x'.repeat(MAX_LOG_BYTES + 1));
    expect(truncateTrafficLog(path, 1)).toBe(true);
    expect(statSync(path).size).toBe(0);
  });

  test('a missing log means "nothing measured", not an error', () => {
    const r = ingestTrafficLog({
      path: join(tmp, 'does-not-exist.log'),
      state: EMPTY_TRAFFIC_STATE,
      now: Date.parse('2026-09-08T12:00:00Z'),
      commit: () => {},
    });
    expect(r.read).toBe(false);
    expect(r.truncated).toBe(false);
    expect(r.state.days).toEqual([]);
  });

  test('with no log at all yesterday still closes, so the mean keeps moving', () => {
    const open: TrafficState = { ...EMPTY_TRAFFIC_STATE, open: { date: '2026-09-08', salt: 's', hashes: ['aa', 'bb'] } };
    const r = ingestTrafficLog({
      path: join(tmp, 'does-not-exist.log'),
      state: open,
      now: Date.parse('2026-09-09T00:10:00Z'),
      commit: () => {},
    });
    expect(r.state.days).toEqual([{ date: '2026-09-08', unique: 2 }]);
    expect(r.state.open).toBeNull();
  });
});

describe('loop gate honours the cadence', () => {
  const now = Date.parse('2026-09-08T12:00:00Z');
  const hours = (h: number): number => h * 3_600_000;

  test('a daily cadence lets the researcher run a day after the last one, not a week', () => {
    expect(shouldBackfill('2026-09-07T06:00:00Z', now, true, hours(24))).toBe(true);
    expect(shouldArena('2026-09-07T06:00:00Z', now, true, hours(24))).toBe(true);
    // …and the same stamp is still too fresh for the weekly default.
    expect(shouldBackfill('2026-09-07T06:00:00Z', now, true)).toBe(false);
  });

  test('inside the interval it stays put', () => {
    expect(shouldBackfill('2026-09-08T06:00:00Z', now, true, hours(24))).toBe(false);
    expect(shouldArena('2026-09-08T09:00:00Z', now, true, hours(6))).toBe(false);
    expect(shouldArena('2026-09-08T05:00:00Z', now, true, hours(6))).toBe(true);
  });

  test('a null stamp still means run now, at any cadence', () => {
    expect(shouldBackfill(null, now, true, hours(168))).toBe(true);
    expect(shouldArena(null, now, true, hours(6))).toBe(true);
  });

  test('the enable flags still win', () => {
    expect(shouldBackfill(null, now, false, hours(6))).toBe(false);
    expect(shouldArena(null, now, false, hours(6))).toBe(false);
  });
});

describe('refreshCadence end to end', () => {
  test('ingests, publishes the cadence and keeps the measurement out of the bundle', () => {
    const stateDir = mkdtempSync(join(tmp, 'state-'));
    const path = join(stateDir, 'traffic.log');
    const day = '2026-09-08';
    // Seven closed days at 14 visitors, plus a live log for today.
    const seeded = {
      ...EMPTY_RUN_STATE,
      researcher: { ...EMPTY_RUN_STATE.researcher, last_backfill_at: '2026-09-08T06:00:00Z' },
      traffic: {
        ...EMPTY_TRAFFIC_STATE,
        days: Array.from({ length: 7 }, (_, i) => ({
          date: utcDay(Date.parse('2026-09-01T00:00:00Z') + i * 86_400_000),
          unique: 14,
        })),
      },
    };
    const store = new StateStore(stateDir);
    store.writeRun(seeded);
    writeFileSync(
      path,
      [
        line({ ts: `${day}T08:00:00+00:00` }),
        line({ ts: `${day}T08:00:01+00:00`, ua: 'Googlebot/2.1' }),
        line({ ts: `${day}T09:00:00+00:00`, addr: '198.51.100.4, 10.0.0.1' }),
        'torn-write',
      ].join('\n') + '\n',
    );

    const rt = createRuntime({
      config: { stateDir, trafficLog: path, researchMonthlyUsd: 60 },
      log: new Logger('error'),
    });
    const cadence = refreshCadence(rt, Date.parse(`${day}T12:00:00Z`));

    expect(cadence.tier).toBe('daily');
    expect(cadence.interval_hours).toBe(24);
    expect(cadence.visitors_per_day).toBe(14);
    expect(cadence.days_measured).toBe(7);
    expect(cadence.next_research_at).toBe('2026-09-09T06:00:00Z');
    expect(statSync(path).size).toBe(0); // ingested and truncated

    const run = rt.state.readRun();
    expect(run.researcher.cadence).toEqual(cadence);
    expect(run.traffic.open?.date).toBe(day);
    expect(run.traffic.open?.hashes).toHaveLength(2); // the bot did not count

    // What the site is allowed to see: the summary, and nothing that is about a person.
    const published = StateStore.toWorkerState(run);
    expect(published).not.toHaveProperty('traffic');
    expect(published.researcher.cadence).toEqual(cadence);
    const json = JSON.stringify(published);
    expect(json).not.toContain('203.0.113.7');
    expect(json).not.toContain('198.51.100.4');
    // …and the state file on disk holds hashes, never addresses.
    const onDisk = readFileSync(join(stateDir, 'state.json'), 'utf8');
    expect(onDisk).not.toContain('203.0.113.7');
    expect(onDisk).not.toContain('198.51.100.4');
  });

  test('a worker with no traffic log runs unchanged: weekly, nothing measured', () => {
    const stateDir = mkdtempSync(join(tmp, 'state-'));
    const rt = createRuntime({
      config: { stateDir, trafficLog: join(stateDir, 'nope.log'), researchMonthlyUsd: 60 },
      log: new Logger('error'),
    });
    const cadence = refreshCadence(rt, Date.parse('2026-09-08T12:00:00Z'));
    expect(cadence.tier).toBe('weekly');
    expect(cadence.interval_hours).toBe(168);
    expect(cadence.days_measured).toBe(0);
    expect(cadence.capped).toBe(false);
    expect(cadence.next_research_at).toBeNull();
  });
});
