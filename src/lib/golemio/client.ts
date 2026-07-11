// Tiny typed fetch wrapper for the Golemio API with a global rate-limit queue.
//
// The API key is a rate-limited resource shared by every caller in the app, so
// all requests funnel through one process-wide scheduler:
//   • at most MAX_CONCURRENT (4) requests in flight at once
//   • at most MAX_PER_WINDOW (16) request *starts* per rolling WINDOW_MS (8s)
//     — comfortably under Golemio's documented 20-req/8s key limit
//   • excess requests wait in a FIFO queue ordered by priority
//     (0 = urgent, 1 = normal, 2 = background); within a priority, oldest first.

const DEFAULT_BASE = 'https://api.golemio.cz';

/** Request priority: lower runs first. */
export type GolemioPriority = 0 | 1 | 2;

export interface GolemioRequestOptions {
  priority?: GolemioPriority;
  signal?: AbortSignal;
  /** Appended as query string; undefined values are dropped. */
  searchParams?: Record<string, string | number | boolean | undefined>;
}

/** Non-2xx HTTP response from Golemio. */
export class GolemioHttpError extends Error {
  readonly status: number;
  readonly body: string | undefined;
  constructor(status: number, body?: string) {
    super(`Golemio HTTP ${status}`);
    this.name = 'GolemioHttpError';
    this.status = status;
    this.body = body;
  }
}

/** Network-level failure (DNS, offline, TLS, malformed JSON, …). */
export class GolemioNetworkError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'GolemioNetworkError';
    this.cause = cause;
  }
}

/** Request was aborted via its AbortSignal. */
export class GolemioAbortError extends Error {
  constructor() {
    super('Golemio request aborted');
    this.name = 'GolemioAbortError';
  }
}

// ── Rate-limit scheduler ─────────────────────────────────────────────────────

const MAX_CONCURRENT = 4;
const MAX_PER_WINDOW = 16;
const WINDOW_MS = 8000;

interface Waiter {
  priority: number;
  seq: number;
  resolve: () => void;
}

let inFlight = 0;
let seqCounter = 0;
/** Timestamps (ms) of request starts within the rolling window. */
let recentStarts: number[] = [];
const waiters: Waiter[] = [];
let pumpTimer: ReturnType<typeof setTimeout> | null = null;

function pruneWindow(now: number): void {
  let i = 0;
  while (i < recentStarts.length && now - recentStarts[i] >= WINDOW_MS) i++;
  if (i > 0) recentStarts = recentStarts.slice(i);
}

function pump(): void {
  if (pumpTimer) {
    clearTimeout(pumpTimer);
    pumpTimer = null;
  }
  const now = Date.now();
  pruneWindow(now);

  while (
    waiters.length > 0 &&
    inFlight < MAX_CONCURRENT &&
    recentStarts.length < MAX_PER_WINDOW
  ) {
    // Highest priority (lowest number) first; ties broken by insertion order.
    let bestIdx = 0;
    for (let i = 1; i < waiters.length; i++) {
      const a = waiters[i];
      const b = waiters[bestIdx];
      if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) {
        bestIdx = i;
      }
    }
    const [w] = waiters.splice(bestIdx, 1);
    inFlight++;
    recentStarts.push(Date.now());
    w.resolve();
  }

  // Blocked only by the rolling window: wake up when the oldest start expires.
  if (
    waiters.length > 0 &&
    inFlight < MAX_CONCURRENT &&
    recentStarts.length >= MAX_PER_WINDOW
  ) {
    const wait = WINDOW_MS - (now - recentStarts[0]) + 1;
    pumpTimer = setTimeout(pump, Math.max(wait, 1));
  }
}

function acquireSlot(priority: number): Promise<void> {
  return new Promise<void>((resolve) => {
    waiters.push({ priority, seq: seqCounter++, resolve });
    pump();
  });
}

function releaseSlot(): void {
  inFlight--;
  pump();
}

// ── URL + headers ────────────────────────────────────────────────────────────

function baseUrl(): string {
  const raw = process.env.EXPO_PUBLIC_GOLEMIO_ENDPOINT ?? DEFAULT_BASE;
  return raw.replace(/\/+$/, '');
}

function buildUrl(
  path: string,
  searchParams?: GolemioRequestOptions['searchParams'],
): string {
  const url = `${baseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
  if (!searchParams) return url;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (value === undefined) continue;
    qs.append(key, String(value));
  }
  const query = qs.toString();
  return query ? `${url}?${query}` : url;
}

function authHeaders(): Record<string, string> {
  const token = process.env.EXPO_PUBLIC_GOLEMIO_KEY ?? '';
  return {
    'X-Access-Token': token,
    Accept: 'application/json',
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Perform a rate-limited GET against Golemio and parse the JSON body.
 * @throws GolemioHttpError on non-2xx, GolemioNetworkError on transport/parse
 *   failure, GolemioAbortError if the signal aborts.
 */
export async function golemioFetch<T>(
  path: string,
  options?: GolemioRequestOptions,
): Promise<T> {
  const priority = options?.priority ?? 1;
  const signal = options?.signal;

  if (signal?.aborted) throw new GolemioAbortError();

  await acquireSlot(priority);
  try {
    if (signal?.aborted) throw new GolemioAbortError();

    const url = buildUrl(path, options?.searchParams);

    let response: Response;
    try {
      response = await fetch(url, { headers: authHeaders(), signal });
    } catch (err) {
      if (signal?.aborted || (err as { name?: string })?.name === 'AbortError') {
        throw new GolemioAbortError();
      }
      throw new GolemioNetworkError(`Golemio request failed: ${String(err)}`, err);
    }

    if (!response.ok) {
      let body: string | undefined;
      try {
        body = await response.text();
      } catch {
        body = undefined;
      }
      throw new GolemioHttpError(response.status, body);
    }

    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new GolemioNetworkError('Golemio response was not valid JSON', err);
    }
  } finally {
    releaseSlot();
  }
}

/** Test-only: reset the scheduler between runs. Not used in production paths. */
export function __resetGolemioScheduler(): void {
  inFlight = 0;
  seqCounter = 0;
  recentStarts = [];
  waiters.length = 0;
  if (pumpTimer) {
    clearTimeout(pumpTimer);
    pumpTimer = null;
  }
}
