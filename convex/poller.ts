// The 24/7 Golemio poll loop (backend-convex.md §2).
//
// Shape of the thing: ONE action loops `fetch → normalize → applyPoll` every
// SERVER_POLL_MS for ~8 minutes, then re-schedules itself and exits (the
// default-runtime action ceiling is 30 minutes — 8 keeps a wide margin and
// bounds how much work any one action instance owns). A generation token in `pollerState` makes double
// loops impossible, and a 1-minute watchdog cron restarts the chain if a deploy
// or a crash ever breaks it. That combination — not the loop itself — is the
// liveness guarantee.
//
// Cadence rationale: the CDN serves `/v2/vehiclepositions` with `s-maxage=5`,
// so a 2 s poll reads each fresh object within ~2 s of it existing. One key at
// ~4 starts / 8 s sits far inside Golemio's 20-per-8-s budget.
//
// Failure policy is ported from LocalGolemioFeed, including the deliberate
// `retries: 0` inside a cycle: the loop IS the retry, and an inner retry would
// overlap the next tick and double-spend the rate quota.

import { v } from 'convex/values';
import { internalAction, internalMutation } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import {
  isVehiclePositionsPayload,
  normalizeVehiclePositions,
  type TramSnapshotBatch,
} from '../src/lib/golemio/normalize';

export const SERVER_POLL_MS = 2_000;

/** Self-reschedule well before the 30-minute default-runtime action ceiling. */
export const LOOP_BUDGET_MS = 8 * 60_000;

/** 401/403: stop polling, probe slowly, and say so in every client's status. */
export const AUTH_RETRY_MS = 60_000;

/** Exponential backoff ceiling for every other failure. */
export const FAILURE_BACKOFF_MAX_MS = 60_000;

/** Never spin faster than this, whatever the arithmetic says. */
export const MIN_SLEEP_MS = 250;

export const FETCH_TIMEOUT_MS = 15_000;

/** Heartbeat older than this and the watchdog restarts the loop. */
export const WATCHDOG_STALE_MS = 120_000;

const DEFAULT_ENDPOINT = 'https://api.golemio.cz';
const VEHICLE_POSITIONS_PATH = '/v2/vehiclepositions?limit=10000';

/** 401/403, or a missing key — halts polling and enters slow probing. */
class PollAuthError extends Error {}

/** Any other transport/HTTP/payload failure — exponential backoff. */
class PollTransportError extends Error {
  readonly retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null = null) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

function endpoint(): string {
  const raw = process.env.GOLEMIO_ENDPOINT ?? DEFAULT_ENDPOINT;
  return raw.replace(/\/+$/, '');
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/**
 * One citywide fetch. Errors are classified, never swallowed: a malformed body
 * is a DELIVERY FAILURE, not an empty city — treating it as "no trams in
 * Prague" would evaporate the fleet for every connected client at once.
 */
async function fetchTramSnapshots(): Promise<TramSnapshotBatch> {
  const key = process.env.GOLEMIO_KEY;
  if (!key) {
    throw new PollAuthError('GOLEMIO_KEY is not set on this deployment');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${endpoint()}${VEHICLE_POSITIONS_PATH}`, {
      headers: { 'X-Access-Token': key, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new PollAuthError(`Golemio auth rejected (${res.status})`);
    }
    if (!res.ok) {
      throw new PollTransportError(
        `Golemio HTTP ${res.status}`,
        parseRetryAfter(res.headers.get('retry-after')),
      );
    }
    const body: unknown = await res.json();
    if (!isVehiclePositionsPayload(body)) {
      throw new PollTransportError(
        'vehiclepositions payload malformed (missing features array)',
      );
    }
    return normalizeVehiclePositions(body);
  } catch (err) {
    if (err instanceof PollAuthError || err instanceof PollTransportError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new PollTransportError(message);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Jittered exponential backoff, floored by any server-supplied Retry-After —
 * but CAPPED at FAILURE_BACKOFF_MAX_MS regardless. An uncapped Retry-After
 * (say 300 s) would sleep past the action ceiling: the action gets killed
 * mid-sleep, the watchdog restarts it, and the restart re-polls immediately —
 * churning generations while honoring the header even less than a capped wait.
 */
export function backoffMs(consecutiveFailures: number, retryAfterMs: number | null): number {
  const raw = Math.min(
    FAILURE_BACKOFF_MAX_MS,
    SERVER_POLL_MS * Math.pow(2, Math.max(0, consecutiveFailures - 1)),
  );
  const jittered = raw * (0.85 + Math.random() * 0.3);
  return Math.min(Math.max(jittered, retryAfterMs ?? 0), FAILURE_BACKOFF_MAX_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readState(ctx: MutationCtx) {
  return await ctx.db
    .query('pollerState')
    .withIndex('by_singleton', (q) => q.eq('singleton', 'poller'))
    .first();
}

/**
 * The loop. Exits early (without rescheduling) the moment its generation token
 * stops matching `pollerState` — that is what makes a restart safe: the new
 * chain takes over and the old one dies at its next mutation.
 */
export const pollLoop = internalAction({
  args: { generation: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const deadline = Date.now() + LOOP_BUDGET_MS;

    while (Date.now() < deadline) {
      const cycleStart = Date.now();
      let waitMs = SERVER_POLL_MS;

      try {
        const batch = await fetchTramSnapshots();
        const res = await ctx.runMutation(internal.ingest.applyPoll, {
          generation: args.generation,
          atMs: Date.now(),
          snapshots: batch.snapshots,
          rejected: batch.rejected,
          rejectedTotal: batch.rejectedTotal,
        });
        if (res.stale) return null;
      } catch (err) {
        const auth = err instanceof PollAuthError;
        const retryAfterMs = err instanceof PollTransportError ? err.retryAfterMs : null;
        const message = err instanceof Error ? err.message : String(err);
        const res = await ctx.runMutation(internal.poller.recordFailure, {
          generation: args.generation,
          atMs: Date.now(),
          kind: auth ? 'auth' : 'error',
          message,
        });
        if (res.stale) return null;
        // While the deployment is auth-failed, EVERY failure probes slowly:
        // hammering a rejected key would only burn the shared rate quota.
        waitMs = res.authFailed
          ? AUTH_RETRY_MS
          : backoffMs(res.consecutiveFailures, retryAfterMs);
      }

      // Subtract the work already done so the PERIOD is SERVER_POLL_MS, not
      // SERVER_POLL_MS + fetch time (which would drift the cadence long).
      const elapsed = Date.now() - cycleStart;
      await sleep(Math.max(MIN_SLEEP_MS, waitMs - elapsed));
    }

    // Hand the same generation to the successor: this is one logical loop
    // continuing, not a restart.
    await ctx.scheduler.runAfter(0, internal.poller.pollLoop, {
      generation: args.generation,
    });
    return null;
  },
});

/** Record a failed cycle and return the loop's marching orders. */
export const recordFailure = internalMutation({
  args: {
    generation: v.number(),
    atMs: v.number(),
    kind: v.union(v.literal('auth'), v.literal('error')),
    message: v.string(),
  },
  returns: v.object({
    stale: v.boolean(),
    consecutiveFailures: v.number(),
    authFailed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const state = await readState(ctx);
    if (state == null || state.generation !== args.generation) {
      return { stale: true, consecutiveFailures: 0, authFailed: false };
    }
    const consecutiveFailures = state.consecutiveFailures + 1;
    // Auth failure is cleared only by a SUCCESSFUL poll (applyPoll), never by a
    // different kind of failure: an offline probe while the token is still bad
    // must not report the key as healthy again.
    const authFailed = args.kind === 'auth' ? true : state.authFailed;
    await ctx.db.patch(state._id, {
      // The heartbeat tracks CYCLES, not successes — a poller that is up but
      // failing must not be restarted by the watchdog every two minutes.
      lastPollAtMs: args.atMs,
      consecutiveFailures,
      authFailed,
      lastError: args.message,
    });
    return { stale: false, consecutiveFailures, authFailed };
  },
});

const INITIAL_STATE = {
  singleton: 'poller' as const,
  running: true,
  consecutiveFailures: 0,
  authFailed: false,
  lastError: null,
  pollIntervalMs: SERVER_POLL_MS,
  fleetSize: 0,
  rejectedTotal: 0,
  rejectedByReason: {},
  restarts: 0,
};

/**
 * Start (or restart) the poller — the one-shot operators run after deploy:
 *
 *     npx convex run poller:start
 *
 * Idempotent by construction: bumping the generation orphans whatever loop was
 * already running, so calling it twice leaves exactly one live loop.
 */
export const start = internalMutation({
  args: {},
  returns: v.object({ generation: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const state = await readState(ctx);
    const generation = (state?.generation ?? 0) + 1;
    if (state) {
      await ctx.db.patch(state._id, {
        generation,
        running: true,
        startedAtMs: now,
        lastPollAtMs: now,
        consecutiveFailures: 0,
        authFailed: false,
        lastError: null,
        pollIntervalMs: SERVER_POLL_MS,
      });
    } else {
      await ctx.db.insert('pollerState', {
        ...INITIAL_STATE,
        generation,
        startedAtMs: now,
        lastPollAtMs: now,
        lastOkAtMs: 0,
        lastSeq: 0,
      });
    }
    await ctx.scheduler.runAfter(0, internal.poller.pollLoop, { generation });
    return { generation };
  },
});

/**
 * Stop the poller: bump the generation (the live loop exits at its next
 * mutation) and mark it stopped so the watchdog leaves it alone.
 */
export const stop = internalMutation({
  args: {},
  returns: v.object({ stopped: v.boolean() }),
  handler: async (ctx) => {
    const state = await readState(ctx);
    if (state == null) return { stopped: false };
    await ctx.db.patch(state._id, {
      generation: state.generation + 1,
      running: false,
      pollIntervalMs: 0,
    });
    return { stopped: true };
  },
});

/**
 * Liveness watchdog (1-minute cron). A scheduled action executes AT MOST once
 * and is never retried, so an action killed mid-flight — deploy, crash,
 * infrastructure hiccup — would otherwise take the whole feed down silently.
 * This is the guarantee that it self-heals within a minute.
 *
 * Deliberately does nothing when no `pollerState` exists: an unstarted
 * deployment stays unstarted until an operator runs `poller:start`.
 */
export const watchdog = internalMutation({
  args: {},
  returns: v.object({ restarted: v.boolean() }),
  handler: async (ctx) => {
    const state = await readState(ctx);
    if (state == null || !state.running) return { restarted: false };
    const now = Date.now();
    if (now - state.lastPollAtMs <= WATCHDOG_STALE_MS) return { restarted: false };
    const generation = state.generation + 1;
    await ctx.db.patch(state._id, {
      generation,
      // Bumping the heartbeat here gives the new loop a full window to prove
      // itself instead of triggering a restart storm on the next tick.
      lastPollAtMs: now,
      restarts: state.restarts + 1,
    });
    await ctx.scheduler.runAfter(0, internal.poller.pollLoop, { generation });
    return { restarted: true };
  },
});
