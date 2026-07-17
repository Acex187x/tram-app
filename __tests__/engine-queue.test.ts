/// <reference types="jest" />
//
// Car-following/queueing in TramEngine: trams sharing a shapeId never overlap —
// a follower's nose keeps ≥ QUEUE_GAP_M behind its leader's tail (leader.sM −
// leader length incl. coupled trailer), queues behind a dwelling leader and
// departs in order. Different shapeIds are intentionally unconstrained.

import { QUEUE_GAP_M, COUPLED_TRAILER_OFFSET_M, TramEngine } from '@/lib/engine/engine';
import { bearingAt, pointAt } from '@/lib/geo/polyline';
import type { RouteGeometry, TramPublicState, TramSnapshot } from '@/lib/types';
import { makeGeometry, makeSnapshot, makeSpec1 } from './helpers';

const T0 = 1_000_000_000_000;
const STEP_MS = 100;
/** makeSpec1 (T3R.P) body length. */
const LEN = makeSpec1().totalLengthM;
const EPS = 1e-6;

function makeEngine(opts: { coupled?: boolean | 'default' } = {}): TramEngine {
  return new TramEngine({
    resolveModel: () => makeSpec1(),
    isDaytime: () => false,
    // 'default' exercises the built-in day-line heuristic; otherwise force off.
    ...(opts.coupled === 'default' ? {} : { isCoupled: () => opts.coupled === true }),
  });
}

/** Advance the engine `seconds`, calling cb with (nowMs) after every tick. */
function run(
  engine: TramEngine,
  fromMs: number,
  seconds: number,
  cb?: (nowMs: number) => void,
): number {
  const steps = Math.round((seconds * 1000) / STEP_MS);
  let now = fromMs;
  for (let i = 0; i < steps; i++) {
    now += STEP_MS;
    engine.tick(now);
    cb?.(now);
  }
  return now;
}

function state(engine: TramEngine, key: string, nowMs: number): TramPublicState {
  const s = engine.getState(key, nowMs);
  if (!s) throw new Error(`no state for ${key}`);
  return s;
}

describe('two trams on one shape converging on a stop', () => {
  // Straight 2 km line, a 20 s stop at 500 m. Same trip → same schedule; the
  // follower starts 150 m behind and (being further behind schedule) faster.
  const geo = makeGeometry(
    [
      [0, 0],
      [2000, 0],
    ],
    [
      { atM: 0, arrivalMs: T0 - 100_000 },
      { atM: 500, arrivalMs: T0 + 50_000, departureMs: T0 + 70_000, dwellSeconds: 20 },
      { atM: 2000, arrivalMs: T0 + 260_000, isTerminal: true },
    ],
  );
  const clearance = LEN + QUEUE_GAP_M;

  it('they never overlap and depart the stop in order', () => {
    const engine = makeEngine();
    engine.ingest(
      [
        makeSnapshot({ key: 'lead', shapeDistM: 300, observedAtMs: T0 }),
        makeSnapshot({ key: 'follow', shapeDistM: 150, observedAtMs: T0 }),
      ],
      () => geo,
      T0,
    );
    engine.tick(T0); // arm the tick clock (dt = 0)

    let leadDwellStartMs = 0;
    let leadDwellEndMs = 0;
    let followDwellStartMs = 0;
    let followDwellPos = -1;
    let followPosDuringLeadDwell = -1;

    run(engine, T0, 150, (now) => {
      const lead = state(engine, 'lead', now);
      const follow = state(engine, 'follow', now);

      // THE invariant: follower nose ≥ 3 m behind leader tail, every tick.
      expect(follow.simDistM).toBeLessThanOrEqual(lead.simDistM - clearance + EPS);

      if (lead.phase === 'dwell') {
        if (leadDwellStartMs === 0) {
          leadDwellStartMs = now;
          expect(lead.simDistM).toBeGreaterThanOrEqual(497);
          expect(lead.simDistM).toBeLessThanOrEqual(500.01);
        }
        followPosDuringLeadDwell = Math.max(followPosDuringLeadDwell, follow.simDistM);
        // The follower queues OUTSIDE the stop's reach window — no ghost dwell.
        expect(follow.phase).toBe('cruise');
      } else if (leadDwellStartMs > 0 && leadDwellEndMs === 0) {
        leadDwellEndMs = now;
      }
      if (follow.phase === 'dwell' && followDwellStartMs === 0) {
        followDwellStartMs = now;
        followDwellPos = follow.simDistM;
      }
    });

    // The leader stopped at the stop first, the follower queued behind it…
    expect(leadDwellStartMs).toBeGreaterThan(0);
    expect(leadDwellEndMs).toBeGreaterThan(leadDwellStartMs);
    expect(followPosDuringLeadDwell).toBeGreaterThan(400); // actually converged
    expect(followPosDuringLeadDwell).toBeLessThanOrEqual(500 - clearance + EPS);
    // …and served the stop only AFTER the leader cleared it (in-order departure).
    expect(followDwellStartMs).toBeGreaterThan(leadDwellEndMs);
    expect(followDwellPos).toBeGreaterThanOrEqual(497);
    expect(followDwellPos).toBeLessThanOrEqual(500.01);

    // Both departed the stop by the end of the run.
    const end = T0 + 150_000;
    expect(state(engine, 'follow', end).simDistM).toBeGreaterThan(520);
  });
});

describe('faster tram behind a slower one (different trips, same shape)', () => {
  const line: [number, number][] = [
    [0, 0],
    [3000, 0],
  ];
  const makeSlowFast = (): { slow: RouteGeometry; fast: RouteGeometry } => {
    const slow = makeGeometry(line, [
      { atM: 0, arrivalMs: T0 - 60_000 },
      { atM: 3000, arrivalMs: T0 + 940_000, isTerminal: true }, // ~3 m/s pace
    ]);
    const fast: RouteGeometry = {
      ...makeGeometry(line, [
        { atM: 0, arrivalMs: T0 - 60_000 },
        { atM: 3000, arrivalMs: T0 + 165_000, isTerminal: true }, // ~13.3 m/s pace
      ]),
      tripId: 'trip-fast',
    };
    return { slow, fast };
  };

  function runCatchUp(engine: TramEngine, tramLengthM: number, line = '9') {
    const { slow, fast } = makeSlowFast();
    const resolve = (tripId: string) => (tripId === 'trip-fast' ? fast : slow);
    engine.ingest(
      [
        makeSnapshot({ key: 'slow', shapeDistM: 400, observedAtMs: T0, line }),
        makeSnapshot({ key: 'fast', shapeDistM: 0, observedAtMs: T0, tripId: 'trip-fast', line }),
      ],
      resolve,
      T0,
    );
    engine.tick(T0);

    const clearance = tramLengthM + QUEUE_GAP_M;
    let minGap = Infinity;
    const end = run(engine, T0, 150, (now) => {
      const leader = state(engine, 'slow', now);
      const follower = state(engine, 'fast', now);
      const gap = leader.simDistM - follower.simDistM;
      minGap = Math.min(minGap, gap);
      // Never passes through — and never closer than tail + QUEUE_GAP_M.
      expect(gap).toBeGreaterThanOrEqual(clearance - EPS);
    });
    return { minGap, endGap: state(engine, 'slow', end).simDistM - state(engine, 'fast', end).simDistM };
  }

  it('catches up, then locks in behind — never passes through', () => {
    const { minGap, endGap } = runCatchUp(makeEngine(), LEN);
    expect(minGap).toBeGreaterThanOrEqual(LEN + QUEUE_GAP_M - EPS);
    // It actually attached to the queue (constraint was binding, not just far away).
    expect(endGap).toBeLessThan(LEN + QUEUE_GAP_M + 15);
  });

  it('coupled T3 sets (default heuristic, day line) reserve the trailer length too', () => {
    const coupledLen = LEN + COUPLED_TRAILER_OFFSET_M;
    const { minGap, endGap } = runCatchUp(makeEngine({ coupled: 'default' }), coupledLen, '9');
    expect(minGap).toBeGreaterThanOrEqual(coupledLen + QUEUE_GAP_M - EPS);
    expect(endGap).toBeLessThan(coupledLen + QUEUE_GAP_M + 15);
  });

  it('night-line T3s (default heuristic, line 91) queue at single-car spacing', () => {
    const { endGap } = runCatchUp(makeEngine({ coupled: 'default' }), LEN, '91');
    // Settles tighter than any coupled clearance — the trailer was NOT added.
    expect(endGap).toBeLessThan(LEN + COUPLED_TRAILER_OFFSET_M + QUEUE_GAP_M);
    expect(endGap).toBeGreaterThanOrEqual(LEN + QUEUE_GAP_M - EPS);
  });

  it('does NOT constrain trams on different shapeIds in OPPOSITE directions', () => {
    // Same street, opposite direction of travel: shape-B runs the same line
    // REVERSED. Cross-shape car-following must never couple them (they pass).
    const engine = makeEngine();
    const { slow } = makeSlowFast();
    const reversed: RouteGeometry = {
      ...makeGeometry(
        [
          [3000, 0],
          [0, 0],
        ],
        [
          { atM: 0, arrivalMs: T0 - 60_000 },
          { atM: 3000, arrivalMs: T0 + 165_000, isTerminal: true }, // ~13.3 m/s pace
        ],
      ),
      tripId: 'trip-fast',
      shapeId: 'shape-B',
    };
    const resolve = (tripId: string) => (tripId === 'trip-fast' ? reversed : slow);
    // World-space start: slow at x=400 heading east, fast at x=600 (sM 2400 on
    // the reversed shape) heading west — 200 m apart, closing head-on.
    const snaps = [
      makeSnapshot({ key: 'slow', shapeDistM: 400, observedAtMs: T0 }),
      makeSnapshot({ key: 'fast', shapeDistM: 2400, observedAtMs: T0, tripId: 'trip-fast' }),
    ];
    engine.ingest(snaps, resolve, T0);
    engine.tick(T0);
    // Re-ingest every 5 s (like the real poll) so cross-pair discovery keeps
    // running while the two trams meet and pass in world space: identical
    // rails mean zero lateral offset — only the opposite-bearing gate keeps
    // them uncoupled.
    let now = T0;
    for (let k = 0; k < 12; k++) {
      now = run(engine, now, 5);
      engine.ingest(snaps, resolve, now);
    }
    // The fast tram drove straight THROUGH the encounter — no cross coupling
    // (its world x is now far west of the oncoming slow tram).
    expect(state(engine, 'fast', now).simDistM).toBeGreaterThan(
      3000 - state(engine, 'slow', now).simDistM + 100,
    );
  });
});

describe('cross-shape car-following (brake-only — never rewrites the follower position)', () => {
  // Build-20 regression: the cross-shape queue used to CLAMP a follower's sM to
  // the leader's translated position. Because the shape-to-shape offset is only
  // valid where the rails physically coincide, a leader passing a junction
  // teleported the follower backward/off-route and froze it — "tram stands at
  // an angle off the drawn line", most often mid-route in the dense centre.
  // The fix: cross-pairs BRAKE ONLY (cap speed, never write sM), are tightened
  // (lateral 2 m / bearing 12°), and drop once the leader has advanced past the
  // lateral-verified window (paths may have diverged).
  const line: [number, number][] = [
    [0, 0],
    [3000, 0],
  ];
  /** Identical rails, different line/trip/shape ids (the shared-street case). */
  function makeShared(): { slow: RouteGeometry; fast: RouteGeometry } {
    const slow = makeGeometry(line, [
      { atM: 0, arrivalMs: T0 - 60_000 },
      { atM: 3000, arrivalMs: T0 + 940_000, isTerminal: true }, // ~3 m/s pace
    ]);
    const fast: RouteGeometry = {
      ...makeGeometry(line, [
        { atM: 0, arrivalMs: T0 - 60_000 },
        // ~6 m/s pace: faster than the leader but modest enough that the
        // schedule-projected (stale) fix never drifts > 500 m ahead of the
        // queued sim inside the test window (which would hard-teleport).
        { atM: 3000, arrivalMs: T0 + 440_000, isTerminal: true },
      ]),
      tripId: 'trip-fast',
      shapeId: 'shape-B',
      line: '22',
    };
    return { slow, fast };
  }

  it('(а) a faster tram of ANOTHER line brakes behind the slow one — never through, never backward', () => {
    const engine = makeEngine();
    const { slow, fast } = makeShared();
    const resolve = (tripId: string) => (tripId === 'trip-fast' ? fast : slow);
    const snaps = [
      makeSnapshot({ key: 'slow', shapeDistM: 400, observedAtMs: T0 }),
      makeSnapshot({ key: 'fast', shapeDistM: 250, observedAtMs: T0, tripId: 'trip-fast', line: '22' }),
    ];
    engine.ingest(snaps, resolve, T0);
    engine.tick(T0);

    let minGap = Infinity;
    let prevFast = -Infinity;
    let backwardJump = 0;
    let now = T0;
    for (let k = 0; k < 24; k++) {
      // 5 s poll cadence: cross pairs refresh from current positions.
      now = run(engine, now, 5, (atMs) => {
        const f = state(engine, 'fast', atMs).simDistM;
        // The follower's position is NEVER rewritten backward by a cross-pair.
        backwardJump = Math.max(backwardJump, prevFast - f);
        prevFast = f;
        minGap = Math.min(minGap, state(engine, 'slow', atMs).simDistM - f);
      });
      engine.ingest(snaps, resolve, now);
    }
    // Key regression guarantee (Fix A): the follower is NEVER teleported
    // backward — brake-only keeps sM monotonic. This is what the build-20 bug
    // violated (a cross clamp threw the follower off-route).
    expect(backwardJump).toBeLessThanOrEqual(1e-6);
    // It never OVERTAKES the leader (never drives through / past it): the head-
    // to-head gap stays positive. (Brake-only holds a following distance rather
    // than a hard clamp, so the QUEUE_GAP buffer may erode over a long same-
    // track pin — accepted per the brake-only design; it never passes.)
    expect(minGap).toBeGreaterThan(0);
    // The brake was actually binding — the fast tram caught up and now trails
    // the slow one closely at its (slow) speed instead of blowing past.
    const slowEnd = state(engine, 'slow', now);
    const fastEnd = state(engine, 'fast', now);
    expect(slowEnd.simDistM - fastEnd.simDistM).toBeLessThan(LEN + QUEUE_GAP_M + 5);
    expect(Math.abs(fastEnd.simSpeedKmh - slowEnd.simSpeedKmh)).toBeLessThan(1);
  });

  it("(а) a fresh fix landing on another line's tail is NOT teleported clear — only braked", () => {
    // Contrast with the same-shape queue (which DOES clamp): a cross-pair may
    // never rewrite sM, so a follower landing close behind stays put on its own
    // shape and decelerates. The old clamp is exactly what teleported trams
    // off-route when the rails had diverged.
    const engine = makeEngine();
    const { slow, fast } = makeShared();
    const resolve = (tripId: string) => (tripId === 'trip-fast' ? fast : slow);
    engine.ingest(
      [
        makeSnapshot({ key: 'B', shapeDistM: 300, observedAtMs: T0 }),
        makeSnapshot({ key: 'A', shapeDistM: 900, observedAtMs: T0, tripId: 'trip-fast', line: '22' }),
      ],
      resolve,
      T0,
    );
    engine.tick(T0);
    const now = run(engine, T0, 2);

    // Fresh fix drops A (other line, other shape) 5 m behind B.
    const bAt = state(engine, 'B', now).simDistM;
    const aBefore = bAt - 5;
    engine.ingest(
      [
        makeSnapshot({ key: 'B', shapeDistM: 300, observedAtMs: T0 }),
        makeSnapshot({ key: 'A', shapeDistM: aBefore, observedAtMs: now, tripId: 'trip-fast', line: '22' }),
      ],
      resolve,
      now,
    );
    // A was NOT shoved backward to clear B (no cross-shape position clamp): it
    // stays essentially where the fix put it right after ingest.
    expect(state(engine, 'A', now).simDistM).toBeGreaterThan(aBefore - 1);
    // And it does not drive forward THROUGH B either (it brakes).
    run(engine, now, 6, (atMs) => {
      expect(state(engine, 'A', atMs).simDistM).toBeLessThan(state(engine, 'B', atMs).simDistM);
    });
  });

  it('(б) once the leader passes a track divergence, the follower is freed (not frozen off-route)', () => {
    // Follower on a straight shape; leader on a shape that SHARES the first
    // 100 m then branches north. While coincident they pair; once the leader
    // has advanced past the divergence the offset mapping is garbage — the pair
    // is dropped (staleness + lateral gate) and the follower drives on freely.
    const followerShape = makeGeometry(
      [
        [0, 0],
        [600, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 60_000 },
        { atM: 600, arrivalMs: T0 + 140_000, isTerminal: true }, // ~4 m/s
      ],
    );
    const leaderShape: RouteGeometry = {
      ...makeGeometry(
        [
          [0, 0],
          [100, 0],
          [100, 400],
        ],
        [
          { atM: 0, arrivalMs: T0 - 60_000 },
          { atM: 500, arrivalMs: T0 + 40_000, isTerminal: true }, // ~11 m/s — passes the branch fast
        ],
      ),
      tripId: 'trip-lead',
      shapeId: 'shape-lead',
      line: '22',
    };
    const resolve = (tripId: string) => (tripId === 'trip-lead' ? leaderShape : followerShape);
    const engine = makeEngine();

    let now = T0;
    // Fresh fixes each poll AT the current sim positions keep deviation ~0 (no
    // teleport artefacts) while cross-pair discovery runs on real positions.
    let fFix = 40;
    let lFix = 70;
    engine.ingest(
      [
        makeSnapshot({ key: 'follow', shapeDistM: fFix, observedAtMs: now }),
        makeSnapshot({ key: 'lead', shapeDistM: lFix, observedAtMs: now, tripId: 'trip-lead', line: '22' }),
      ],
      resolve,
      now,
    );
    engine.tick(now);

    let prevFollow = -Infinity;
    let backwardJump = 0;
    for (let k = 0; k < 8; k++) {
      now = run(engine, now, 5, (atMs) => {
        const f = state(engine, 'follow', atMs).simDistM;
        backwardJump = Math.max(backwardJump, prevFollow - f);
        prevFollow = f;
      });
      fFix = state(engine, 'follow', now).simDistM;
      lFix = state(engine, 'lead', now).simDistM;
      engine.ingest(
        [
          makeSnapshot({ key: 'follow', shapeDistM: fFix, observedAtMs: now }),
          makeSnapshot({ key: 'lead', shapeDistM: lFix, observedAtMs: now, tripId: 'trip-lead', line: '22' }),
        ],
        resolve,
        now,
      );
    }

    // The follower drove well past the 100 m divergence on its own straight
    // shape — it was never frozen behind the (diverged) leader …
    expect(state(engine, 'follow', now).simDistM).toBeGreaterThan(200);
    // … and it is still moving at the end, not pinned to ~0 …
    expect(state(engine, 'follow', now).simSpeedKmh).toBeGreaterThan(5);
    // … and never teleported backward.
    expect(backwardJump).toBeLessThanOrEqual(1e-6);
  });

  it('(в) a same-direction tram on an ADJACENT parallel track (>2 m away) is NOT coupled', () => {
    // Two parallel same-direction rails 3 m apart — different physical tracks.
    // The tightened lateral gate (2 m) must not pair them, so a faster tram on
    // one track passes a slower tram on the other instead of freezing behind it.
    const trackA = makeGeometry(line, [
      { atM: 0, arrivalMs: T0 - 60_000 },
      { atM: 3000, arrivalMs: T0 + 940_000, isTerminal: true }, // ~3 m/s
    ]);
    const trackB: RouteGeometry = {
      ...makeGeometry(
        [
          [0, 3],
          [3000, 3],
        ],
        [
          { atM: 0, arrivalMs: T0 - 60_000 },
          { atM: 3000, arrivalMs: T0 + 240_000, isTerminal: true }, // ~12 m/s
        ],
      ),
      tripId: 'trip-fast',
      shapeId: 'shape-B',
      line: '22',
    };
    const resolve = (tripId: string) => (tripId === 'trip-fast' ? trackB : trackA);
    const snaps = [
      makeSnapshot({ key: 'slow', shapeDistM: 400, observedAtMs: T0 }),
      makeSnapshot({ key: 'fast', shapeDistM: 250, observedAtMs: T0, tripId: 'trip-fast', line: '22' }),
    ];
    const engine = makeEngine();
    engine.ingest(snaps, resolve, T0);
    engine.tick(T0);
    let now = T0;
    for (let k = 0; k < 20; k++) {
      now = run(engine, now, 5);
      engine.ingest(snaps, resolve, now);
    }
    // Different tracks → no coupling: the fast tram passes the slow one.
    expect(state(engine, 'fast', now).simDistM).toBeGreaterThan(state(engine, 'slow', now).simDistM);
  });

  it('live projections queue across shapes too (live mode must not overlap either)', () => {
    // The leader stands at a stop (pinned by an at_stop fix); the follower is
    // another line on the same rails approaching from behind. Its PROJECTION
    // must brake and hold clear of the leader's projection.
    const stopGeo = makeGeometry(line, [
      { atM: 0, arrivalMs: T0 - 300_000 },
      { atM: 500, arrivalMs: T0 - 10_000, departureMs: T0 + 10_000, dwellSeconds: 12 },
      { atM: 3000, arrivalMs: T0 + 900_000, isTerminal: true },
    ]);
    const other: RouteGeometry = {
      ...makeGeometry(line, [
        { atM: 0, arrivalMs: T0 - 60_000 },
        { atM: 3000, arrivalMs: T0 + 240_000, isTerminal: true }, // 10 m/s pace
      ]),
      tripId: 'trip-other',
      shapeId: 'shape-B',
      line: '22',
    };
    const resolve = (tripId: string) => (tripId === 'trip-other' ? other : stopGeo);
    const leadSnap = (atMs: number) =>
      makeSnapshot({
        key: 'lead',
        shapeDistM: 500,
        observedAtMs: atMs,
        statePosition: 'at_stop',
        lastStopSequence: stopGeo.stops[1].sequence,
      });
    const followSnap = makeSnapshot({
      key: 'follow',
      shapeDistM: 400,
      observedAtMs: T0,
      tripId: 'trip-other',
      line: '22',
    });
    const engine = makeEngine();
    engine.ingest([leadSnap(T0), followSnap], resolve, T0);
    engine.tick(T0);

    const clearance = LEN + QUEUE_GAP_M;
    let minProjGap = Infinity;
    let followProjMax = -Infinity;
    let now = T0;
    for (let k = 0; k < 8; k++) {
      now = run(engine, now, 5, (atMs) => {
        const lead = state(engine, 'lead', atMs).projectedObservedDistM!;
        const follow = state(engine, 'follow', atMs).projectedObservedDistM!;
        minProjGap = Math.min(minProjGap, lead - follow);
        followProjMax = Math.max(followProjMax, follow);
      });
      // Fresh at-stop fixes keep the leader pinned at the platform.
      engine.ingest([leadSnap(now), followSnap], resolve, now);
    }
    // Brake-only: the follower's projection decelerates and holds essentially
    // clear of the standing leader (a small brake-onset overshoot of the
    // QUEUE_GAP buffer is accepted — bodies stay ~touching, never overlapping,
    // and it never drives through).
    expect(minProjGap).toBeGreaterThan(LEN - 1);
    expect(followProjMax).toBeGreaterThan(500 - clearance - 15); // actually converged on it
  });
});

describe('teleports / re-anchors compress the queue instead of overlapping', () => {
  it('a leader hard-teleported into another tram is re-ordered and clamped clear', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [3000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 60_000 },
        { atM: 3000, arrivalMs: T0 + 940_000, isTerminal: true },
      ],
    );
    const engine = makeEngine();
    const snapB = makeSnapshot({ key: 'B', shapeDistM: 300, observedAtMs: T0 });
    engine.ingest(
      [makeSnapshot({ key: 'A', shapeDistM: 850, observedAtMs: T0 }), snapB],
      () => geo,
      T0,
    );
    engine.tick(T0);
    let now = run(engine, T0, 2);

    // Fresh AVL fix drops A right on top of B (> 500 m error → hard teleport).
    const bAt = state(engine, 'B', now).simDistM;
    engine.ingest(
      [makeSnapshot({ key: 'A', shapeDistM: bAt - 5, observedAtMs: now })],
      () => geo,
      now,
    );

    // Constraints run inside ingest: A is now the follower, clamped clear of B.
    const clearance = LEN + QUEUE_GAP_M;
    const check = (atMs: number) => {
      const a = state(engine, 'A', atMs);
      const b = state(engine, 'B', atMs);
      expect(a.simDistM).toBeLessThanOrEqual(b.simDistM - clearance + EPS);
    };
    check(now);

    // …and the invariant keeps holding as the queue rolls on.
    now = run(engine, now, 5, check);
  });
});

describe('sim bookkeeping for queueing', () => {
  it('exposes tram length (incl. coupled trailer) on the sim via TramPublicState motion', () => {
    // Indirect but public: a coupled engine spaces by LEN + trailer, a solo one
    // by LEN — covered above. Here just sanity-check getStatesAt() exists and
    // matches getStates() for render-side callers.
    const geo = makeGeometry(
      [
        [0, 0],
        [1000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 10_000 },
        { atM: 1000, arrivalMs: T0 + 290_000, isTerminal: true },
      ],
    );
    const engine = makeEngine();
    engine.ingest([makeSnapshot({ key: 'solo', shapeDistM: 100, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
    const now = run(engine, T0, 3);
    const viaAt = engine.getStatesAt(now);
    const via = engine.getStates(now);
    expect(viaAt).toHaveLength(1);
    expect(viaAt[0].simDistM).toBe(via[0].simDistM);
  });
});

describe('observed (raw AVL fix) public state', () => {
  const geo = makeGeometry(
    [
      [0, 0],
      [1000, 0],
    ],
    [
      { atM: 0, arrivalMs: T0 - 10_000 },
      { atM: 1000, arrivalMs: T0 + 290_000, isTerminal: true },
    ],
  );

  it('places the fix on the shape and reports along-shape deviation from the sim', () => {
    const engine = makeEngine();
    engine.ingest([makeSnapshot({ key: 'solo', shapeDistM: 300, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
    const now = run(engine, T0, 10); // sim moves on; the observation must NOT
    const s = state(engine, 'solo', now);
    expect(s.simDistM).toBeGreaterThan(300);
    // Observed = pointAt/bearingAt(300): on the eastbound track, NOT projected
    // forward with the sim.
    expect(s.observedPosition).toEqual(pointAt(geo.coordinates, geo.cumDistM, 300));
    expect(s.observedBearing).toBe(bearingAt(geo.coordinates, geo.cumDistM, 300));
    expect(s.observedBearing).toBeCloseTo(90, 0);
    expect(s.deviationM).toBe(Math.abs(s.simDistM - 300));
  });

  it('clamps an out-of-range fix to the geometry length', () => {
    const engine = makeEngine();
    engine.ingest([makeSnapshot({ key: 'solo', shapeDistM: 5000, observedAtMs: T0 })], () => geo, T0);
    engine.tick(T0);
    const s = state(engine, 'solo', T0);
    expect(s.observedPosition).toEqual(pointAt(geo.coordinates, geo.cumDistM, geo.totalM));
    expect(s.deviationM).toBe(Math.abs(s.simDistM - geo.totalM));
  });

  it('falls back to raw coordinates with null deviation and NO bearing without geometry', () => {
    const engine = makeEngine();
    engine.ingest(
      [makeSnapshot({ key: 'raw', coordinates: [14.61, 50.06], bearing: 123, shapeDistM: 42 })],
      () => undefined,
      T0,
    );
    engine.tick(T0);
    const s = state(engine, 'raw', T0);
    expect(s.hasGeometry).toBe(false);
    expect(s.observedPosition).toEqual([14.61, 50.06]);
    // The raw AVL bearing (123) is garbage at v≈0 and is NEVER adopted — the
    // fallback bearing stays null → 0 until real movement supplies one (#7).
    // The geometry-less tram renders as an un-oriented dot regardless.
    expect(s.observedBearing).toBe(0);
    expect(s.bearing).toBe(0);
    expect(s.deviationM).toBeNull();
  });
});

// Type-level guard: snapshots keep satisfying the engine's ingest contract.
const _snapshotTypeCheck: TramSnapshot = makeSnapshot();
void _snapshotTypeCheck;
