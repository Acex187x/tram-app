/// <reference types="jest" />
//
// Car-following/queueing in TramEngine v2: trams sharing a shapeId never
// overlap — a follower's nose keeps ≥ QUEUE_GAP_M behind its leader's tail —
// and the constraint runs on BOTH fleets (predictor AND smoother,
// engine-v2.md §2.3). Different shapeIds are cross-pair territory: brake-only,
// never a position rewrite. v2 has no schedule pace, so speed differentials
// in these fixtures come from observation-pinned leaders (stuck-holds /
// at-stop pins) instead of slow timetables.

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
    ...(opts.coupled === 'default' ? {} : { isCoupled: () => opts.coupled === true }),
  });
}

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
  // Straight 2 km line, a 20 s stop at 500 m. Same trip → both cruise at the
  // fresh-sim prior pace; the leader reaches the stop first and dwells.
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

  it('they never overlap and serve the stop in order', () => {
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
    // …and served the stop only AFTER the leader cleared it.
    expect(followDwellStartMs).toBeGreaterThan(leadDwellEndMs);
    expect(followDwellPos).toBeGreaterThanOrEqual(497);
    expect(followDwellPos).toBeLessThanOrEqual(500.01);

    // Both departed the stop by the end of the run.
    const end = T0 + 150_000;
    expect(state(engine, 'follow', end).simDistM).toBeGreaterThan(520);
  });
});

describe('a cruising tram catching a STANDING leader (same shape)', () => {
  const line: [number, number][] = [
    [0, 0],
    [3000, 0],
  ];
  const geo = makeGeometry(line, [
    { atM: 0, arrivalMs: T0 - 60_000 },
    { atM: 3000, arrivalMs: T0 + 500_000, isTerminal: true },
  ]);

  /** Arm a mid-segment stuck-hold on `key` at `atM` (two same-position fixes). */
  function armStuck(engine: TramEngine, key: string, atM: number, line = '9'): void {
    engine.ingest(
      [makeSnapshot({ key, shapeDistM: atM, observedAtMs: T0 - 10_000, line })],
      () => geo,
      T0 - 10_000,
    );
    engine.ingest(
      [makeSnapshot({ key, shapeDistM: atM, observedAtMs: T0, line })],
      () => geo,
      T0,
    );
  }

  /**
   * Drive the follower into the standing leader and report where it settles.
   * The queue-binding surface is per fleet: the follower attaches to the
   * leader PREDICTOR's tail (anchored at the stuck fix, 900); the leader's
   * rendered smoother itself stands up to its braking-overshoot ahead of the
   * anchor (v2 has no backward rewind), so "attached" is asserted against
   * the deterministic anchor, not the leader's rendered position.
   */
  function runCatchUp(engine: TramEngine, tramLengthM: number, line = '9') {
    armStuck(engine, 'slow', 900, line);
    engine.ingest(
      [
        makeSnapshot({ key: 'slow', shapeDistM: 900, observedAtMs: T0, line }),
        makeSnapshot({ key: 'fast', shapeDistM: 100, observedAtMs: T0, line }),
      ],
      () => geo,
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
    return { minGap, followerEnd: state(engine, 'fast', end).simDistM };
  }

  it('catches up, then locks in behind — never passes through', () => {
    const clearance = LEN + QUEUE_GAP_M;
    const { minGap, followerEnd } = runCatchUp(makeEngine(), LEN);
    expect(minGap).toBeGreaterThanOrEqual(clearance - EPS);
    // It actually attached to the queue limit behind the stuck anchor.
    expect(followerEnd).toBeGreaterThanOrEqual(900 - clearance - 5);
    expect(followerEnd).toBeLessThanOrEqual(900 - clearance + EPS);
  });

  it('coupled T3 sets (default heuristic, day line) reserve the trailer length too', () => {
    const coupledLen = LEN + COUPLED_TRAILER_OFFSET_M;
    const clearance = coupledLen + QUEUE_GAP_M;
    const { minGap, followerEnd } = runCatchUp(makeEngine({ coupled: 'default' }), coupledLen, '9');
    expect(minGap).toBeGreaterThanOrEqual(clearance - EPS);
    expect(followerEnd).toBeGreaterThanOrEqual(900 - clearance - 5);
    expect(followerEnd).toBeLessThanOrEqual(900 - clearance + EPS);
  });

  it('night-line T3s (default heuristic, line 91) queue at single-car spacing', () => {
    const { followerEnd } = runCatchUp(makeEngine({ coupled: 'default' }), LEN, '91');
    // Settles a full trailer length CLOSER than the coupled clearance would
    // allow — the trailer was NOT added on the night line.
    expect(followerEnd).toBeGreaterThan(900 - (LEN + COUPLED_TRAILER_OFFSET_M + QUEUE_GAP_M));
    expect(followerEnd).toBeLessThanOrEqual(900 - (LEN + QUEUE_GAP_M) + EPS);
  });

  it('does NOT constrain trams on different shapeIds in OPPOSITE directions', () => {
    // Same street, opposite direction of travel: shape-B runs the same line
    // REVERSED. Cross-shape car-following must never couple them (they pass).
    const engine = makeEngine();
    const reversed: RouteGeometry = {
      ...makeGeometry(
        [
          [3000, 0],
          [0, 0],
        ],
        [
          { atM: 0, arrivalMs: T0 - 60_000 },
          { atM: 3000, arrivalMs: T0 + 500_000, isTerminal: true },
        ],
      ),
      tripId: 'trip-B',
      shapeId: 'shape-B',
    };
    const resolve = (tripId: string) => (tripId === 'trip-B' ? reversed : geo);
    // World-space: 'east' at x=400 heading east; 'west' at x=600 (sM 2400 on
    // the reversed shape) heading west — 200 m apart, closing head-on.
    const snaps = [
      makeSnapshot({ key: 'east', shapeDistM: 400, observedAtMs: T0 }),
      makeSnapshot({ key: 'west', shapeDistM: 2400, observedAtMs: T0, tripId: 'trip-B' }),
    ];
    engine.ingest(snaps, resolve, T0);
    engine.tick(T0);
    // Re-ingest every 5 s (like the real poll) so cross-pair discovery keeps
    // running while the two trams meet and pass in world space.
    let now = T0;
    for (let k = 0; k < 12; k++) {
      now = run(engine, now, 5);
      engine.ingest(snaps, resolve, now);
    }
    // The westbound tram drove straight THROUGH the encounter — no coupling.
    expect(state(engine, 'west', now).simDistM).toBeGreaterThan(
      3000 - state(engine, 'east', now).simDistM + 100,
    );
  });
});

describe('cross-shape car-following (brake-only — never rewrites the follower position)', () => {
  const line: [number, number][] = [
    [0, 0],
    [3000, 0],
  ];
  /** Identical rails, different line/trip/shape ids (the shared-street case). */
  function makeShared(): { a: RouteGeometry; b: RouteGeometry } {
    const a = makeGeometry(line, [
      { atM: 0, arrivalMs: T0 - 60_000 },
      { atM: 3000, arrivalMs: T0 + 500_000, isTerminal: true },
    ]);
    const b: RouteGeometry = {
      ...makeGeometry(line, [
        { atM: 0, arrivalMs: T0 - 60_000 },
        { atM: 3000, arrivalMs: T0 + 500_000, isTerminal: true },
      ]),
      tripId: 'trip-fast',
      shapeId: 'shape-B',
      line: '22',
    };
    return { a, b };
  }

  it('(а) a tram of ANOTHER line brakes behind a standing one — never through, never backward', () => {
    const engine = makeEngine();
    const { a, b } = makeShared();
    const resolve = (tripId: string) => (tripId === 'trip-fast' ? b : a);
    // Leader on shape A stuck mid-segment at 700 (repeated fixes, jam).
    engine.ingest(
      [makeSnapshot({ key: 'slow', shapeDistM: 700, observedAtMs: T0 - 10_000 })],
      resolve,
      T0 - 10_000,
    );
    const snaps = [
      makeSnapshot({ key: 'slow', shapeDistM: 700, observedAtMs: T0 }),
      makeSnapshot({ key: 'fast', shapeDistM: 250, observedAtMs: T0, tripId: 'trip-fast', line: '22' }),
    ];
    engine.ingest(snaps, resolve, T0);
    engine.tick(T0);

    let minGap = Infinity;
    let prevFast = -Infinity;
    let backwardJump = 0;
    let now = T0;
    for (let k = 0; k < 24; k++) {
      now = run(engine, now, 5, (atMs) => {
        const f = state(engine, 'fast', atMs).simDistM;
        // The follower's position is NEVER rewritten backward by a cross-pair.
        backwardJump = Math.max(backwardJump, prevFast - f);
        prevFast = f;
        minGap = Math.min(minGap, state(engine, 'slow', atMs).simDistM - f);
      });
      engine.ingest(snaps, resolve, now); // 5 s poll cadence — pairs refresh
    }
    expect(backwardJump).toBeLessThanOrEqual(EPS);
    // It never OVERTAKES the standing leader (never drives through it).
    expect(minGap).toBeGreaterThan(0);
    // The brake was binding — the fast tram settled just behind the jam
    // anchor's tail clearance (700 − LEN − GAP) on ITS OWN shape, standing.
    const fastEnd = state(engine, 'fast', now);
    expect(fastEnd.simDistM).toBeGreaterThanOrEqual(700 - LEN - QUEUE_GAP_M - 6);
    expect(fastEnd.simDistM).toBeLessThan(700 - LEN - QUEUE_GAP_M + 2);
    expect(fastEnd.simSpeedKmh).toBeLessThan(2);
  });

  it('(б) once the leader passes a track divergence, the follower is freed (not frozen off-route)', () => {
    // Follower on a straight shape; leader on a shape that SHARES the first
    // 100 m then branches north. While coincident they pair; once the leader
    // has advanced past the divergence the pair is dropped (staleness +
    // lateral gate) and the follower drives on freely.
    const followerShape = makeGeometry(
      [
        [0, 0],
        [600, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 60_000 },
        { atM: 600, arrivalMs: T0 + 140_000, isTerminal: true },
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
          { atM: 500, arrivalMs: T0 + 40_000, isTerminal: true },
        ],
      ),
      tripId: 'trip-lead',
      shapeId: 'shape-lead',
      line: '22',
    };
    const resolve = (tripId: string) => (tripId === 'trip-lead' ? leaderShape : followerShape);
    const engine = makeEngine();

    let now = T0;
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
    // shape — it was never frozen behind the (diverged) leader…
    expect(state(engine, 'follow', now).simDistM).toBeGreaterThan(200);
    // …is still moving at the end…
    expect(state(engine, 'follow', now).simSpeedKmh).toBeGreaterThan(5);
    // …and never teleported backward.
    expect(backwardJump).toBeLessThanOrEqual(EPS);
  });

  it('(в) a same-direction tram on an ADJACENT parallel track (>2 m away) is NOT coupled', () => {
    // Standing tram on track A; a mover on a parallel track 3 m away must
    // PASS it — the tightened 2 m lateral gate rejects different physical
    // tracks (build-20 regression).
    const trackA = makeGeometry(line, [
      { atM: 0, arrivalMs: T0 - 60_000 },
      { atM: 3000, arrivalMs: T0 + 500_000, isTerminal: true },
    ]);
    const trackB: RouteGeometry = {
      ...makeGeometry(
        [
          [0, 3],
          [3000, 3],
        ],
        [
          { atM: 0, arrivalMs: T0 - 60_000 },
          { atM: 3000, arrivalMs: T0 + 500_000, isTerminal: true },
        ],
      ),
      tripId: 'trip-fast',
      shapeId: 'shape-B',
      line: '22',
    };
    const resolve = (tripId: string) => (tripId === 'trip-fast' ? trackB : trackA);
    const engine = makeEngine();
    // Stand the track-A tram via a stuck-hold at 500.
    engine.ingest(
      [makeSnapshot({ key: 'stand', shapeDistM: 500, observedAtMs: T0 - 10_000 })],
      resolve,
      T0 - 10_000,
    );
    const snaps = [
      makeSnapshot({ key: 'stand', shapeDistM: 500, observedAtMs: T0 }),
      makeSnapshot({ key: 'mover', shapeDistM: 250, observedAtMs: T0, tripId: 'trip-fast', line: '22' }),
    ];
    engine.ingest(snaps, resolve, T0);
    engine.tick(T0);
    let now = T0;
    for (let k = 0; k < 20; k++) {
      now = run(engine, now, 5);
      engine.ingest(snaps, resolve, now);
    }
    // Different tracks → no coupling: the mover passed the standing tram.
    expect(state(engine, 'mover', now).simDistM).toBeGreaterThan(
      state(engine, 'stand', now).simDistM + 100,
    );
  });

  it('the predictor fleet queues across shapes too (live mode must not overlap either)', () => {
    // The leader stands at a stop (pinned by an at_stop fix); the follower is
    // another line on the same rails approaching from behind. Its PREDICTOR
    // must brake and hold clear of the leader's predictor.
    const stopGeo = makeGeometry(line, [
      { atM: 0, arrivalMs: T0 - 300_000 },
      { atM: 500, arrivalMs: T0 - 10_000, departureMs: T0 + 10_000, dwellSeconds: 12 },
      { atM: 3000, arrivalMs: T0 + 900_000, isTerminal: true },
    ]);
    const other: RouteGeometry = {
      ...makeGeometry(line, [
        { atM: 0, arrivalMs: T0 - 60_000 },
        { atM: 3000, arrivalMs: T0 + 240_000, isTerminal: true },
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
      // 385 → seeded ≈ 421 after the latency advance (same approach run the
      // fixture exercised before FEED_LATENCY_S grew to 5).
      key: 'follow',
      shapeDistM: 385,
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
      engine.ingest([leadSnap(now), followSnap], resolve, now);
    }
    // Brake-only: the follower's predictor decelerates and holds essentially
    // clear of the standing leader (bodies never overlapping, never through).
    expect(minProjGap).toBeGreaterThan(LEN - 1);
    expect(followProjMax).toBeGreaterThan(500 - clearance - 15); // converged on it
  });
});

describe('teleports / re-anchors compress the queue instead of overlapping', () => {
  it('a leader hard-teleported onto another tram is re-ordered and clamped clear', () => {
    const geo = makeGeometry(
      [
        [0, 0],
        [3000, 0],
      ],
      [
        { atM: 0, arrivalMs: T0 - 60_000 },
        { atM: 3000, arrivalMs: T0 + 500_000, isTerminal: true },
      ],
    );
    const engine = makeEngine();
    const snapB = makeSnapshot({ key: 'B', shapeDistM: 300, observedAtMs: T0 });
    engine.ingest(
      // 1300: the later backward re-anchor must clear the GAP-AWARE teleport
      // floor (~658 m at the clamped minimum gap), or it converges smoothly.
      [makeSnapshot({ key: 'A', shapeDistM: 1300, observedAtMs: T0 }), snapB],
      () => geo,
      T0,
    );
    engine.tick(T0);
    let now = run(engine, T0, 2);

    // Fresh AVL fix drops A well behind B's tail (error > threshold → hard
    // teleport; the latency advance keeps the landing short of B).
    const bAt = state(engine, 'B', now).simDistM;
    engine.ingest(
      [makeSnapshot({ key: 'A', shapeDistM: Math.max(0, bAt - 60), observedAtMs: now })],
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
    now = run(engine, now, 5, check);
  });
});

describe('sim bookkeeping for queueing', () => {
  it('getStatesAt() matches getStates() for render-side callers', () => {
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
    // The raw AVL bearing (123) is garbage at v≈0 and is NEVER adopted (#7).
    expect(s.observedBearing).toBe(0);
    expect(s.bearing).toBe(0);
    expect(s.deviationM).toBeNull();
  });
});

// Type-level guard: snapshots keep satisfying the engine's ingest contract.
const _snapshotTypeCheck: TramSnapshot = makeSnapshot();
void _snapshotTypeCheck;
