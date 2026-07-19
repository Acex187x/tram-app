// Unit tests for the Golemio client: the rate-limit scheduler's promotion +
// aging behavior, queued-waiter abort (no wasted quota), per-attempt timeout,
// and the retry policy (backoff + jitter, Retry-After, 401 never retried).
// We stub global.fetch with a controllable, deferred implementation so
// requests stay "in flight" until we choose to settle them, letting us observe
// which queued waiter the scheduler dispatches next.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  __resetGolemioScheduler,
  demoteTag,
  golemioFetch,
  GolemioHttpError,
  GolemioAbortError,
  GolemioTimeoutError,
  promoteTag,
  REQUEST_TIMEOUT_MS,
} from '@/lib/golemio/client';

interface PendingFetch {
  url: string;
  settle: (status?: number, headers?: Record<string, string>) => void;
}

let pending: PendingFetch[] = [];
let fetchMock: jest.Mock<(url: unknown, init?: { signal?: AbortSignal }) => Promise<Response>>;

/** Let all pending microtasks (promise continuations) run to completion. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Fire a request; swallow the eventual result/rejection (we only watch fetch). */
function issue(path: string, priority: 0 | 1 | 2, tag?: string): void {
  void golemioFetch(path, { priority, tag }).catch(() => {});
}

/** Settle the first in-flight fetch whose URL matches (default 200/{}). */
function settleFetch(match: string, status = 200, headers: Record<string, string> = {}): void {
  const idx = pending.findIndex((p) => p.url.includes(match));
  if (idx < 0) throw new Error(`no in-flight fetch matching "${match}"`);
  const [p] = pending.splice(idx, 1);
  p.settle(status, headers);
}

/** URLs the scheduler has actually dispatched to fetch, in call order. */
function fetchedUrls(): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  __resetGolemioScheduler();
  pending = [];
  fetchMock = jest.fn((url: unknown, init?: { signal?: AbortSignal }) => {
    return new Promise<Response>((resolve, reject) => {
      // Behave like real fetch: reject with an AbortError when the request's
      // signal fires (the client's per-attempt timeout/abort plumbing).
      init?.signal?.addEventListener('abort', () =>
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
      );
      pending.push({
        url: String(url),
        settle: (status = 200, headers = {}) =>
          resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
            json: async () => ({}),
            text: async () => '',
          } as unknown as Response),
      });
    });
  });
  // @ts-expect-error test override of the global fetch
  global.fetch = fetchMock;
});

afterEach(() => {
  // Settle leftovers so their per-attempt timeout timers are cleared and jest
  // can exit promptly.
  for (const p of pending.splice(0)) p.settle();
  __resetGolemioScheduler();
  jest.useRealTimers();
});

describe('promoteTag', () => {
  it('dispatches a promoted queued waiter ahead of an equal/older one', async () => {
    // Saturate concurrency (MAX_CONCURRENT = 4) so later requests must queue.
    for (let i = 0; i < 4; i++) issue(`/v2/block/${i}`, 1);
    await flush();
    expect(pending).toHaveLength(4);

    // Two background trip-geometry requests queue behind the blockers.
    issue('/v2/gtfs/trips/AAA', 2);
    issue('/v2/gtfs/trips/BBB', 2);
    await flush();
    // Still only the 4 blockers are actually in flight.
    expect(pending).toHaveLength(4);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // User taps the tram for trip BBB → promote it to urgent.
    expect(promoteTag('BBB', 0)).toBe(true);

    // Free one slot: the scheduler must pick BBB (promoted) over AAA.
    settleFetch('/v2/block/0');
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const last = fetchedUrls()[4];
    expect(last).toContain('BBB');
    expect(last).not.toContain('AAA');
  });

  it('returns false when no queued waiter matches the tag', async () => {
    for (let i = 0; i < 4; i++) issue(`/v2/block/${i}`, 1);
    issue('/v2/gtfs/trips/AAA', 2);
    await flush();

    expect(promoteTag('ZZZ', 0)).toBe(false);
  });

  it('matches an explicit request tag as well as the URL path', async () => {
    for (let i = 0; i < 4; i++) issue(`/v2/block/${i}`, 1);
    issue('/v2/gtfs/trips/opaque-id', 2, 'trip-42');
    await flush();

    // Path does not contain "trip-42", but the explicit tag does.
    expect(promoteTag('trip-42', 0)).toBe(true);
  });

  it('a trip id that is a PREFIX of a queued trip never matches its waiter', async () => {
    for (let i = 0; i < 4; i++) issue(`/v2/block/${i}`, 1);
    // Only 991_1040 is queued; a tap on 991_104 must NOT "match" it — the old
    // substring match returned true here, so promoteGeometry skipped issuing
    // the urgent fetch for the actually-tapped tram (it stayed a roundel until
    // the next poll re-requested it).
    issue('/v2/gtfs/trips/991_1040_250101', 2);
    await flush();

    expect(promoteTag('991_104', 0)).toBe(false);
    expect(promoteTag('991_1040_250101', 0)).toBe(true);
    expect(demoteTag('991_104', 2)).toBe(false);
  });
});

describe('starvation aging', () => {
  it('ages a long-queued background waiter ahead of newer normal work', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    __resetGolemioScheduler();

    // Occupy all 4 concurrency slots.
    for (let i = 0; i < 4; i++) issue(`/v2/block/${i}`, 1);
    await flush();
    expect(pending).toHaveLength(4);

    // An OLD background (priority 2) request enqueues at t=0.
    issue('/v2/gtfs/trips/OLD', 2);
    await flush();

    // A NEWER normal (priority 1) request enqueues shortly after.
    jest.setSystemTime(100);
    issue('/v2/gtfs/trips/NEW', 1);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(4); // both still queued

    // Advance past the aging threshold. OLD (age 30s) should be bumped 2→1 on
    // the next pump; being older than NEW at the same priority, it wins the tie.
    jest.setSystemTime(30_000);
    settleFetch('/v2/block/0');
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchedUrls()[4]).toContain('OLD');
  });

  it('aging never lifts a waiter into the URGENT lane — a cold-start backlog cannot starve the poll', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    __resetGolemioScheduler();

    // Occupy all 4 concurrency slots.
    for (let i = 0; i < 4; i++) issue(`/v2/block/${i}`, 1);
    await flush();
    expect(pending).toHaveLength(4);

    // A background geometry waiter enqueues at t=0 (cold-start backlog member).
    issue('/v2/gtfs/trips/OLD', 2);
    await flush();

    // Two full aging windows elapse, with pumps in between (in production the
    // drain pumps continuously). Pumps are triggered here by new enqueues so
    // no slot frees up. The old unbounded aging marched OLD 2→1→0 across these
    // two pumps; the floor stops it at 1.
    jest.setSystemTime(30_001);
    issue('/v2/filler/one', 2);
    await flush();
    jest.setSystemTime(60_002);
    issue('/v2/filler/two', 2);
    await flush();

    // The live poll (urgent, newest seq) arrives — it must dispatch FIRST.
    // Under the old aging, OLD sat at priority 0 with an older seq and won.
    issue('/v2/vehiclepositions', 0);
    await flush();
    settleFetch('/v2/block/0');
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchedUrls()[4]).toContain('vehiclepositions');

    // The aged (capped at 1) backlog member still goes next — aging works.
    settleFetch('/v2/block/1');
    await flush();
    expect(fetchedUrls()[5]).toContain('OLD');
  });
});

describe('demoteTag', () => {
  it('a demoted queued waiter yields to newer raised-priority work', async () => {
    for (let i = 0; i < 4; i++) issue(`/v2/block/${i}`, 1);
    await flush();

    // Enqueued FIRST at raised priority (classified visible under an earlier
    // whole-city bbox)…
    issue('/v2/gtfs/trips/STALE', 1);
    await flush();
    // …then the camera moved away: the next poll demotes it…
    expect(demoteTag('STALE', 2)).toBe(true);
    // …and a tram actually on screen NOW enqueues at raised priority.
    issue('/v2/gtfs/trips/FRESH', 1);
    await flush();

    settleFetch('/v2/block/0');
    await flush();
    expect(fetchedUrls()[4]).toContain('FRESH');

    settleFetch('/v2/block/1');
    await flush();
    expect(fetchedUrls()[5]).toContain('STALE');
  });

  it('never demotes an urgent (tapped-tram) waiter', async () => {
    for (let i = 0; i < 4; i++) issue(`/v2/block/${i}`, 1);
    await flush();

    issue('/v2/gtfs/trips/TAPPED', 0);
    issue('/v2/gtfs/trips/OTHER', 1);
    await flush();

    // Matched, but the urgent priority is untouched.
    expect(demoteTag('TAPPED', 2)).toBe(true);

    settleFetch('/v2/block/0');
    await flush();
    expect(fetchedUrls()[4]).toContain('TAPPED');
  });

  it('returns false when no queued waiter matches', async () => {
    for (let i = 0; i < 4; i++) issue(`/v2/block/${i}`, 1);
    await flush();
    expect(demoteTag('NOPE', 2)).toBe(false);
  });
});

describe('queued-waiter abort', () => {
  it('an aborted queued waiter leaves the queue immediately and is never dispatched', async () => {
    // Saturate concurrency so the 5th request must queue.
    for (let i = 0; i < 4; i++) issue(`/v2/block/${i}`, 1);
    await flush();
    expect(pending).toHaveLength(4);

    const ctl = new AbortController();
    const queued = golemioFetch('/v2/gtfs/trips/QUEUED', { priority: 2, signal: ctl.signal });
    const rejection = expect(queued).rejects.toBeInstanceOf(GolemioAbortError);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(4); // still queued

    ctl.abort();
    await rejection; // rejected while queued — before any slot was granted

    // Freeing a slot must NOT dispatch the aborted waiter.
    settleFetch('/v2/block/0');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchedUrls().some((u) => u.includes('QUEUED'))).toBe(false);
  });

  it('aborted waiters do not consume rolling-window start slots', async () => {
    // 4 blockers use 4 of the 16 window starts.
    for (let i = 0; i < 4; i++) issue(`/v2/block/${i}`, 1);
    await flush();

    // Queue 12 waiters and abort them all while still queued.
    const ctl = new AbortController();
    const aborted = Array.from({ length: 12 }, (_, i) =>
      golemioFetch(`/v2/gtfs/trips/DEAD${i}`, { priority: 2, signal: ctl.signal }).catch(
        (e) => e,
      ),
    );
    await flush();
    ctl.abort();
    await Promise.all(aborted);

    // Settle the blockers; 12 fresh requests must all start without waiting
    // for the 8 s window to roll — possible only if the aborted waiters spent
    // zero window slots (4 + 12 = 16 = MAX_PER_WINDOW). Settle each as it
    // dispatches so the 4-deep concurrency limit never interferes.
    for (let i = 0; i < 4; i++) settleFetch(`/v2/block/${i}`);
    for (let i = 0; i < 12; i++) issue(`/v2/live/${i}`, 1);
    for (let i = 0; i < 12; i++) {
      await flush();
      settleFetch(`/v2/live/${i}`);
    }
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(16);
  });
});

describe('timeout + retry policy', () => {
  it('a hung request times out with GolemioTimeoutError (retries: 0)', async () => {
    jest.useFakeTimers();
    const p = golemioFetch('/v2/slow', { retries: 0 });
    const rejection = expect(p).rejects.toBeInstanceOf(GolemioTimeoutError);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    await rejection;
  });

  it('retries transient 5xx with backoff and eventually succeeds', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const p = golemioFetch('/v2/flaky', { retries: 2 });
    const settled = expect(p).resolves.toEqual({});
    await flush();
    settleFetch('/v2/flaky', 500);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1); // backing off, not instant

    await jest.advanceTimersByTimeAsync(1_000); // attempt 1 backoff ≤ 1 s
    expect(fetchMock).toHaveBeenCalledTimes(2);
    settleFetch('/v2/flaky', 503);
    await flush();

    await jest.advanceTimersByTimeAsync(2_000); // attempt 2 backoff ≤ 2 s
    expect(fetchMock).toHaveBeenCalledTimes(3);
    settleFetch('/v2/flaky', 200);
    await settled;
    (Math.random as unknown as jest.Mock).mockRestore();
  });

  it('honors Retry-After on 429 (no earlier retry)', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const p = golemioFetch('/v2/limited', { retries: 1 });
    const settled = expect(p).resolves.toEqual({});
    await flush();
    settleFetch('/v2/limited', 429, { 'retry-after': '3' });
    await flush();

    await jest.advanceTimersByTimeAsync(1_500); // computed backoff would fire here…
    expect(fetchMock).toHaveBeenCalledTimes(1); // …but Retry-After holds it back

    await jest.advanceTimersByTimeAsync(1_600); // past the 3 s server floor
    expect(fetchMock).toHaveBeenCalledTimes(2);
    settleFetch('/v2/limited', 200);
    await settled;
    (Math.random as unknown as jest.Mock).mockRestore();
  });

  it('401 is NOT retried (auth policy lives in the feed) and carries its status', async () => {
    const p = golemioFetch('/v2/secure'); // default retries = 2 — must not matter
    const rejection = p.catch((e) => e);
    await flush();
    settleFetch('/v2/secure', 401);
    const err = (await rejection) as GolemioHttpError;
    expect(err).toBeInstanceOf(GolemioHttpError);
    expect(err.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an abort during the retry backoff wait rejects immediately', async () => {
    jest.useFakeTimers();
    const ctl = new AbortController();
    const p = golemioFetch('/v2/flaky', { retries: 2, signal: ctl.signal });
    const rejection = expect(p).rejects.toBeInstanceOf(GolemioAbortError);
    await flush();
    settleFetch('/v2/flaky', 500);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1); // sleeping before retry

    ctl.abort();
    await rejection; // no timer advance needed — abort cut the sleep short
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
