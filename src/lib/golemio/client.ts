// Tiny typed fetch wrapper for the Golemio API with a global rate-limit queue.
//
// The API key is a rate-limited resource shared by every caller in the app, so
// all requests funnel through one process-wide scheduler:
//   • at most MAX_CONCURRENT (4) requests in flight at once
//   • at most MAX_PER_WINDOW (16) request *starts* per rolling WINDOW_MS (8s)
//     — comfortably under Golemio's documented 20-req/8s key limit
//   • excess requests wait in a FIFO queue ordered by priority
//     (0 = urgent, 1 = normal, 2 = background); within a priority, oldest first.
//   • an aborted waiter leaves the queue IMMEDIATELY and never consumes a
//     window slot (lifecycle abort must not waste future quota).
//
// Transport hardening (2026-07 review):
//   • every attempt runs under a hard timeout (REQUEST_TIMEOUT_MS) via its own
//     AbortController, linked to the caller's signal;
//   • transient failures (timeout, network, 429/408/5xx) retry with
//     exponential backoff + jitter, honoring Retry-After when the server sends
//     one; other 4xx (incl. 401) never retry — auth policy lives in the feed;
//   • abort, timeout and HTTP failures throw distinct error classes so
//     diagnostics can tell lifecycle cancellation from server trouble.

const DEFAULT_BASE = 'https://api.golemio.cz';

/** Hard per-attempt timeout. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** Default number of retries after the first attempt (transient errors only). */
export const DEFAULT_RETRIES = 2;
/** First backoff step; doubles each retry. */
export const RETRY_BASE_MS = 1_000;
/** Ceiling for a single computed backoff delay. */
export const RETRY_CAP_MS = 30_000;
/** Ceiling applied to a server-sent Retry-After. */
export const RETRY_AFTER_CAP_MS = 60_000;

/** Request priority: lower runs first. */
export type GolemioPriority = 0 | 1 | 2;

export interface GolemioRequestOptions {
  priority?: GolemioPriority;
  signal?: AbortSignal;
  /** Appended as query string; undefined values are dropped. */
  searchParams?: Record<string, string | number | boolean | undefined>;
  /**
   * Opaque label used to find & promote this request while it is still queued
   * (see {@link promoteTag}). When omitted, a queued request can still be
   * promoted by matching its URL path (e.g. a trip id embedded in the path).
   */
  tag?: string;
  /** Retries after the first attempt for transient failures (default 2).
   * Callers that are themselves a retry loop (the 5 s poll) pass 0. */
  retries?: number;
  /** Per-attempt timeout override (default REQUEST_TIMEOUT_MS). */
  timeoutMs?: number;
}

/** Non-2xx HTTP response from Golemio. */
export class GolemioHttpError extends Error {
  readonly status: number;
  readonly body: string | undefined;
  /** Parsed Retry-After header in ms (capped), or null when absent/invalid. */
  readonly retryAfterMs: number | null;
  constructor(status: number, body?: string, retryAfterMs: number | null = null) {
    super(`Golemio HTTP ${status}`);
    this.name = 'GolemioHttpError';
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

/** A single attempt exceeded its hard timeout (distinct from caller aborts). */
export class GolemioTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Golemio request timed out after ${timeoutMs} ms`);
    this.name = 'GolemioTimeoutError';
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
/** A priority-2 (background) waiter older than this is aged up one level so a
 * sustained higher-priority stream cannot starve it forever. */
const AGING_MS = 30_000;
/**
 * Aging FLOOR: anti-starvation aging never lifts a waiter above (numerically
 * below) this priority. The urgent lane (0) is reserved for the 5 s poll and
 * tapped-tram promotions. Without the floor, a cold-start geometry backlog
 * (hundreds of background waiters) aged 2→1→0 within two windows; their older
 * seq numbers then outranked every fresh poll, tap and visible-lane request —
 * the fleet froze and visible trams sat as loading dots for minutes (the
 * red-dot recurrence, 2026-07-18).
 */
const AGING_FLOOR: GolemioPriority = 1;

interface Waiter {
  priority: number;
  seq: number;
  /** Wall-clock ms the waiter was enqueued (for starvation aging). */
  enqueuedAt: number;
  /** Request URL path — used to promote a queued waiter by path predicate. */
  path: string;
  /** Optional caller-supplied promotion label. */
  tag?: string;
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

  // Starvation aging: bump long-waiting background requests up one level so a
  // sustained stream of higher-priority work cannot keep them queued forever —
  // but never into the urgent lane (AGING_FLOOR).
  let nextAgingDueInMs = Number.POSITIVE_INFINITY;
  for (const w of waiters) {
    if (w.priority <= AGING_FLOOR) continue;
    const age = now - w.enqueuedAt;
    if (age >= AGING_MS) {
      w.priority = (w.priority - 1) as GolemioPriority;
      // Reset the aging clock so it can climb another level after another window.
      w.enqueuedAt = now;
      nextAgingDueInMs = Math.min(nextAgingDueInMs, AGING_MS);
    } else {
      nextAgingDueInMs = Math.min(nextAgingDueInMs, AGING_MS - age);
    }
  }

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

  if (waiters.length === 0) return;

  // Compute the soonest moment we must wake to make progress:
  //  • when the rolling window frees a start slot (if window-blocked), and
  //  • when the next background waiter becomes eligible for aging.
  let wakeInMs = Number.POSITIVE_INFINITY;
  if (inFlight < MAX_CONCURRENT && recentStarts.length >= MAX_PER_WINDOW) {
    wakeInMs = Math.min(wakeInMs, WINDOW_MS - (now - recentStarts[0]) + 1);
  }
  if (Number.isFinite(nextAgingDueInMs)) {
    wakeInMs = Math.min(wakeInMs, nextAgingDueInMs);
  }
  if (Number.isFinite(wakeInMs)) {
    pumpTimer = setTimeout(pump, Math.max(wakeInMs, 1));
  }
}

/**
 * Wait for a scheduler slot. When `signal` aborts while still queued, the
 * waiter is removed from the queue IMMEDIATELY and the promise rejects with
 * GolemioAbortError — it never consumes a rolling-window start slot, so a
 * backgrounded session cannot waste future quota.
 */
function acquireSlot(
  priority: GolemioPriority,
  path: string,
  tag?: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GolemioAbortError());
      return;
    }
    const w: Waiter = {
      priority,
      seq: seqCounter++,
      enqueuedAt: Date.now(),
      path,
      tag,
      resolve: () => {},
    };
    const onAbort = (): void => {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      reject(new GolemioAbortError());
    };
    w.resolve = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    waiters.push(w);
    pump();
  });
}

function releaseSlot(): void {
  inFlight--;
  pump();
}

/** True when a still-queued waiter matches the given promotion label. */
function waiterMatchesTag(w: Waiter, tag: string): boolean {
  if (w.tag !== undefined && w.tag === tag) return true;
  // Fall back to a URL-path match so callers can promote by an id embedded in
  // the request path (e.g. a trip id) without threading a tag through every
  // intermediate module.
  return w.path.includes(tag) || w.path.includes(encodeURIComponent(tag));
}

/**
 * Raise the priority of a request that is still waiting in the scheduler queue
 * (e.g. because the user selected the tram whose geometry was enqueued at
 * background priority). Matches by explicit {@link GolemioRequestOptions.tag}
 * or, failing that, by the request path containing `tag`.
 *
 * Returns true if at least one queued waiter matched — meaning the request is
 * already in flight or queued, so the caller need not re-issue it. Returns
 * false if nothing matched (the request has not been enqueued yet, or already
 * left the queue).
 */
export function promoteTag(tag: string, priority: GolemioPriority): boolean {
  let matched = false;
  for (const w of waiters) {
    if (!waiterMatchesTag(w, tag)) continue;
    matched = true;
    if (priority < w.priority) w.priority = priority;
  }
  if (matched) pump();
  return matched;
}

/**
 * Lower the priority of a request still waiting in the scheduler queue — the
 * mirror of {@link promoteTag}. Used by the per-poll geometry warm-up to
 * DEMOTE a queued shape whose tram is no longer on screen (the camera moved
 * away, or a whole-city bbox shrank on zoom-in). Together the pair re-asserts
 * queue priorities from the freshest poll + viewport every cycle, so a deep
 * cold-start backlog can never pin stale priorities for minutes: what the
 * user looks at NOW always outranks what was enqueued first.
 *
 * Urgent waiters (priority 0 — tapped/followed trams) are never demoted, and
 * a demotion restarts the waiter's anti-starvation aging clock (it just
 * changed lanes; its old age must not age it straight back up).
 */
export function demoteTag(tag: string, priority: GolemioPriority): boolean {
  let matched = false;
  const now = Date.now();
  for (const w of waiters) {
    if (!waiterMatchesTag(w, tag)) continue;
    matched = true;
    if (w.priority > 0 && priority > w.priority) {
      w.priority = priority;
      w.enqueuedAt = now;
    }
  }
  // Lowering a priority never unblocks dispatch — no pump needed.
  return matched;
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

// ── Retry helpers ────────────────────────────────────────────────────────────

/** Parse a Retry-After header (delta-seconds or HTTP-date) into ms, capped. */
function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) {
    return Math.min(secs * 1000, RETRY_AFTER_CAP_MS);
  }
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    const delta = date - Date.now();
    return delta > 0 ? Math.min(delta, RETRY_AFTER_CAP_MS) : 0;
  }
  return null;
}

/** Transient failures worth retrying: timeout, network, 429/408/5xx. */
function isRetryable(err: unknown): boolean {
  if (err instanceof GolemioTimeoutError) return true;
  if (err instanceof GolemioNetworkError) return true;
  if (err instanceof GolemioHttpError) {
    return err.status === 429 || err.status === 408 || err.status >= 500;
  }
  return false;
}

/**
 * Backoff before retry `attempt` (1-based): exponential with equal jitter
 * (half deterministic + half random, so delays neither collapse to ~0 nor
 * synchronize across clients), raised to the server's Retry-After if larger.
 */
function retryDelayMs(attempt: number, err: unknown): number {
  const base = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_CAP_MS);
  const jittered = base / 2 + Math.random() * (base / 2);
  const retryAfter =
    err instanceof GolemioHttpError && err.retryAfterMs != null ? err.retryAfterMs : 0;
  return Math.max(jittered, retryAfter);
}

/** Abortable sleep between retries; rejects with GolemioAbortError on abort. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GolemioAbortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new GolemioAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/** One rate-limited, timed-out attempt. The slot is held only while in flight. */
async function attemptFetch<T>(
  path: string,
  options: GolemioRequestOptions | undefined,
  priority: GolemioPriority,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  if (signal?.aborted) throw new GolemioAbortError();

  await acquireSlot(priority, path, options?.tag, signal);

  // Per-attempt controller: fires on hard timeout OR when the caller aborts.
  const attemptCtl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    attemptCtl.abort();
  }, timeoutMs);
  const onCallerAbort = (): void => attemptCtl.abort();
  signal?.addEventListener('abort', onCallerAbort, { once: true });

  try {
    if (signal?.aborted) throw new GolemioAbortError();

    const url = buildUrl(path, options?.searchParams);

    let response: Response;
    try {
      response = await fetch(url, { headers: authHeaders(), signal: attemptCtl.signal });
    } catch (err) {
      if (signal?.aborted) throw new GolemioAbortError();
      if (timedOut) throw new GolemioTimeoutError(timeoutMs);
      if ((err as { name?: string })?.name === 'AbortError') {
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
      const retryAfter = parseRetryAfter(response.headers?.get?.('retry-after'));
      throw new GolemioHttpError(response.status, body, retryAfter);
    }

    try {
      return (await response.json()) as T;
    } catch (err) {
      if (signal?.aborted) throw new GolemioAbortError();
      if (timedOut) throw new GolemioTimeoutError(timeoutMs);
      throw new GolemioNetworkError('Golemio response was not valid JSON', err);
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
    releaseSlot();
  }
}

/**
 * Perform a rate-limited GET against Golemio and parse the JSON body.
 * Each attempt has a hard timeout; transient failures (timeout, network,
 * 429/408/5xx) retry with exponential backoff + jitter, honoring Retry-After.
 * Non-transient HTTP errors (401/403/404/…) surface immediately.
 * @throws GolemioHttpError on non-2xx, GolemioNetworkError on transport/parse
 *   failure, GolemioTimeoutError when every attempt timed out,
 *   GolemioAbortError if the caller's signal aborts (queued, in flight, or
 *   while waiting to retry).
 */
export async function golemioFetch<T>(
  path: string,
  options?: GolemioRequestOptions,
): Promise<T> {
  const priority = options?.priority ?? 1;
  const signal = options?.signal;
  const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxAttempts = 1 + Math.max(0, options?.retries ?? DEFAULT_RETRIES);

  let attempt = 0;
  for (;;) {
    try {
      return await attemptFetch<T>(path, options, priority, signal, timeoutMs);
    } catch (err) {
      if (err instanceof GolemioAbortError) throw err;
      attempt += 1;
      if (attempt >= maxAttempts || !isRetryable(err)) throw err;
      await sleep(retryDelayMs(attempt, err), signal);
    }
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
