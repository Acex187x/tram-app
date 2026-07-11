// Unit tests for the Golemio rate-limit scheduler's promotion + aging behavior
// (the pure-TS parts of src/lib/golemio/client.ts). We stub global.fetch with a
// controllable, deferred implementation so requests stay "in flight" until we
// choose to settle them, letting us observe which queued waiter the scheduler
// dispatches next.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  __resetGolemioScheduler,
  golemioFetch,
  promoteTag,
} from '@/lib/golemio/client';

interface PendingFetch {
  url: string;
  settle: () => void;
}

let pending: PendingFetch[] = [];
let fetchMock: jest.Mock;

/** Let all pending microtasks (promise continuations) run to completion. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Fire a request; swallow the eventual result/rejection (we only watch fetch). */
function issue(path: string, priority: 0 | 1 | 2, tag?: string): void {
  void golemioFetch(path, { priority, tag }).catch(() => {});
}

/** Settle (resolve 200/{}) the first in-flight fetch whose URL matches. */
function settleFetch(match: string): void {
  const idx = pending.findIndex((p) => p.url.includes(match));
  if (idx < 0) throw new Error(`no in-flight fetch matching "${match}"`);
  const [p] = pending.splice(idx, 1);
  p.settle();
}

/** URLs the scheduler has actually dispatched to fetch, in call order. */
function fetchedUrls(): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  __resetGolemioScheduler();
  pending = [];
  fetchMock = jest.fn((url: unknown) => {
    return new Promise<Response>((resolve) => {
      pending.push({
        url: String(url),
        settle: () =>
          resolve({
            ok: true,
            status: 200,
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
});
