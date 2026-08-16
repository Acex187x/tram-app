// The whole client physics engine, part 2: one-time decode of a v2 bundle.
//
// Everything expensive about a fetch happens HERE, once per bundle — JSON
// walking, validation, typed-array packing — so the frame path only ever does
// arithmetic over Float64Arrays (perf invariants #1/#8). Nothing in this file
// may be called per frame.
//
// Wire format: docs/research/physics-v3-protocol.md (FROZEN). Malformed
// vehicles are dropped individually; a bundle without a usable `serverNowMs`
// is rejected wholesale (the previous bundle keeps rendering, and the
// connection state ages into `degraded`/`offline` honestly rather than the
// fleet snapping to garbage).

export const PROTOCOL_VERSION = 2;

/** Hard cap per track, mirroring the protocol's "≤ 24 points per track". */
export const MAX_KNOTS = 24;

/** One vehicle's decoded trajectories + the metadata the client renders from. */
export interface ParsedVehicle {
  key: string;
  /** Trip the curves were computed against — a trip change invalidates them. */
  tripId: string;
  line: string;
  /** observedAtMs of the AVL fix underneath these curves. */
  anchorMs: number;
  /** Birth of THIS trajectory (the server's blend anchor). */
  emittedAtMs: number;
  /** Server flagged a sanctioned break in continuity (trip change / model break). */
  discontinuity: boolean;
  /** Raw model opinion, interleaved [t,s,…] — the «fixed» render mode. */
  opinion: Float64Array;
  /** Continuity-blended curve, interleaved [t,s,…] — the «smooth» render mode. */
  smooth: Float64Array;
}

/** A decoded bundle: the complete fleet physics for the next ~120 seconds. */
export interface ParsedBundle {
  protocolVersion: number;
  /** Server wall clock at send — the clock-sync datum. */
  serverNowMs: number;
  /** Bundle build time; staleness = serverNowMs − atMs. */
  atMs: number;
  horizonS: number;
  vehicles: Map<string, ParsedVehicle>;
  /** Local Date.now() when the response was decoded (clock-offset partner). */
  receivedAtMs: number;
}

/** Shared empty track — an absent/unusable curve allocates nothing. */
export const EMPTY_TRACK = new Float64Array(0);

/** Read a finite number from an unknown field, or NaN. */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
}

/**
 * Pack `[{t,s},…]` into an interleaved Float64Array.
 *
 * Drops non-finite entries and any knot whose `t` does not strictly advance —
 * the evaluator's binary search assumes strictly increasing time, and a
 * duplicate stamp from a server bug must degrade to "one fewer knot", never to
 * a wrong interpolation. `s` is taken verbatim: the protocol makes the server
 * responsible for monotonicity, and silently repairing it here would hide
 * exactly the regressions the smooth↔fixed delta exists to expose.
 */
export function packTrack(points: unknown): Float64Array {
  if (!Array.isArray(points) || points.length === 0) return EMPTY_TRACK;
  const limit = Math.min(points.length, MAX_KNOTS);
  const buf = new Float64Array(limit * 2);
  let n = 0;
  let lastT = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < limit; i++) {
    const p = points[i] as { t?: unknown; s?: unknown } | null;
    if (p == null) continue;
    const t = num(p.t);
    const s = num(p.s);
    if (Number.isNaN(t) || Number.isNaN(s) || t <= lastT) continue;
    buf[n << 1] = t;
    buf[(n << 1) + 1] = s;
    lastT = t;
    n += 1;
  }
  if (n === 0) return EMPTY_TRACK;
  return n * 2 === buf.length ? buf : buf.subarray(0, n * 2);
}

/**
 * Decode one `GET /api/trajectories/v2` body. Returns null when the payload is
 * not a usable bundle (wrong shape, no server clock) — callers keep the
 * previous bundle and let the connection state tell the truth about its age.
 */
export function parseBundle(payload: unknown, receivedAtMs: number): ParsedBundle | null {
  const body = payload as {
    protocolVersion?: unknown;
    serverNowMs?: unknown;
    atMs?: unknown;
    horizonS?: unknown;
    vehicles?: unknown;
  } | null;
  if (body == null || typeof body !== 'object') return null;
  const serverNowMs = num(body.serverNowMs);
  if (Number.isNaN(serverNowMs)) return null; // no clock datum ⇒ no honest eval
  if (!Array.isArray(body.vehicles)) return null;

  const atMsRaw = num(body.atMs);
  const vehicles = new Map<string, ParsedVehicle>();
  for (const raw of body.vehicles) {
    const v = raw as {
      key?: unknown;
      tripId?: unknown;
      line?: unknown;
      anchorMs?: unknown;
      emittedAtMs?: unknown;
      discontinuity?: unknown;
      opinion?: unknown;
      smooth?: unknown;
    } | null;
    if (v == null || typeof v.key !== 'string' || v.key.length === 0) continue;
    if (typeof v.tripId !== 'string') continue;
    const opinion = packTrack(v.opinion);
    const smooth = packTrack(v.smooth);
    // A vehicle with neither curve carries no physics — drop it and let the
    // renderer fall back to its raw fix (visibly frozen), which is the truth.
    if (opinion.length === 0 && smooth.length === 0) continue;
    vehicles.set(v.key, {
      key: v.key,
      tripId: v.tripId,
      line: typeof v.line === 'string' ? v.line : '',
      anchorMs: num(v.anchorMs),
      emittedAtMs: num(v.emittedAtMs),
      discontinuity: v.discontinuity === true,
      opinion,
      smooth,
    });
  }

  return {
    protocolVersion: Number.isNaN(num(body.protocolVersion))
      ? PROTOCOL_VERSION
      : (body.protocolVersion as number),
    serverNowMs,
    atMs: Number.isNaN(atMsRaw) ? serverNowMs : atMsRaw,
    horizonS: Number.isNaN(num(body.horizonS)) ? 0 : (body.horizonS as number),
    vehicles,
    receivedAtMs,
  };
}
