import { describe, expect, test } from 'bun:test';
import {
  OpenRouterError,
  RETRY_BASE_DELAY_MS,
  RETRY_JITTER_FRACTION,
  RETRY_MAX_DELAY_MS,
  RETRYABLE_STATUSES,
  Semaphore,
  parseRetryAfter,
  retryDelayMs,
  withRetry,
} from '../src/llm';

const deterministic = () => 0.5; // jitter = 0 exactly

describe('retryDelayMs', () => {
  test('doubles from the base and caps at the max (no jitter)', () => {
    const expected = [2, 4, 8, 16, 32, 60].map((s) => s * 1000);
    expected.forEach((ms, attempt) => {
      expect(retryDelayMs(attempt, null, deterministic)).toBe(ms);
    });
    // Beyond the cap: stays at 60 s.
    expect(retryDelayMs(10, null, deterministic)).toBe(RETRY_MAX_DELAY_MS);
  });

  test('jitter stays within ±25% of the computed delay', () => {
    for (const r of [0, 0.25, 0.75, 1]) {
      const delay = retryDelayMs(2, null, () => r);
      const centre = RETRY_BASE_DELAY_MS * 4;
      const bound = centre * RETRY_JITTER_FRACTION;
      expect(delay).toBeGreaterThanOrEqual(Math.round((centre - bound) * 1000) / 1000 - 1);
      expect(delay).toBeLessThanOrEqual(centre + bound + 1);
    }
  });

  test('a larger Retry-After wins over the exponential delay', () => {
    expect(retryDelayMs(0, 30_000, deterministic)).toBe(30_000);
    expect(retryDelayMs(4, 90_000, deterministic)).toBe(90_000);
  });

  test('a smaller Retry-After loses to the exponential delay', () => {
    expect(retryDelayMs(3, 500, deterministic)).toBe(16_000);
  });

  test('is never negative even for weird inputs', () => {
    expect(retryDelayMs(-5, null, deterministic)).toBeGreaterThan(0);
    expect(retryDelayMs(0, -1000, deterministic)).toBeGreaterThan(0);
  });
});

describe('parseRetryAfter', () => {
  test('reads seconds', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  test('reads HTTP dates', () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(50_000);
    expect(ms).toBeLessThanOrEqual(60_000);
  });

  test('null for absent or unparseable headers', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });
});

describe('withRetry', () => {
  const retryable = (status: number) => new OpenRouterError(`boom ${status}`, status, '{}');

  test('retries retryable statuses and eventually succeeds', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw retryable(429);
        return 'ok';
      },
      { maxAttempts: 6, sleepImpl: async (ms) => void sleeps.push(ms), random: deterministic },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  test('rethrows the last error after maxAttempts', async () => {
    let attempts = 0;
    try {
      await withRetry(
        async () => {
          attempts++;
          throw retryable(503);
        },
        { maxAttempts: 3, sleepImpl: async () => {}, random: deterministic },
      );
      expect.unreachable();
    } catch (e) {
      expect((e as OpenRouterError).status).toBe(503);
    }
    expect(attempts).toBe(3);
  });

  test('network errors (no status) are retried too', async () => {
    let attempts = 0;
    const out = await withRetry(
      async () => {
        attempts++;
        if (attempts === 1) throw new TypeError('fetch failed');
        return 42;
      },
      { maxAttempts: 2, sleepImpl: async () => {}, random: deterministic },
    );
    expect(out).toBe(42);
    expect(attempts).toBe(2);
  });

  test('non-retryable logic errors still bubble (withRetry does not judge payloads)', async () => {
    // withRetry retries everything thrown by fn — the retryable-status filter lives in the
    // client's post() surface; here we pin the documented behaviour that the LAST error wins.
    let last = '';
    try {
      await withRetry(
        async () => {
          last = `attempt-${Math.random()}`;
          throw new Error(last);
        },
        { maxAttempts: 2, sleepImpl: async () => {} },
      );
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toBe(last);
    }
  });

  test('the retryable status set is exactly the rate-limit + transient-5xx set', () => {
    expect([...RETRYABLE_STATUSES].sort((a, b) => a - b)).toEqual([429, 500, 502, 503, 504]);
  });
});

describe('Semaphore', () => {
  test('limits in-flight work under a burst', async () => {
    const sem = new Semaphore(2);
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        sem.run(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  test('releases the slot when the task throws', async () => {
    const sem = new Semaphore(1);
    await sem.run(async () => {
      throw new Error('nope');
    }).catch(() => {});
    expect(sem.pending).toBe(0);
    // The next task still runs.
    const out = await sem.run(async () => 'ok');
    expect(out).toBe('ok');
  });

  test('queue order is FIFO', async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map((i) => sem.run(async () => {
        await new Promise((r) => setTimeout(r, 5 - i));
        order.push(i);
      })),
    );
    expect(order).toEqual([1, 2, 3, 4]);
  });

  test('rejects a nonsensical limit', () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
  });

  test('release() transfers the slot to a waiter — pending never exceeds the limit', async () => {
    // The old release() decremented before waking the next waiter, so an acquire() that
    // slipped in between could push `pending` past the limit (upstream race, review item 14).
    const sem = new Semaphore(1);
    let peak = 0;
    let inFlight = 0;
    const first = sem.run(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Give the second task time to enqueue as a waiter.
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
    });
    const second = sem.run(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      inFlight--;
    });
    await Promise.all([first, second]);
    expect(peak).toBe(1);
    expect(sem.pending).toBe(0);
    expect(sem.waiting).toBe(0);
  });
});
