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

  it('does NOT constrain trams on different shapeIds (opposite direction/variant)', () => {
    const engine = makeEngine();
    const { slow, fast } = makeSlowFast();
    const fastOtherShape: RouteGeometry = { ...fast, shapeId: 'shape-B' };
    const resolve = (tripId: string) => (tripId === 'trip-fast' ? fastOtherShape : slow);
    engine.ingest(
      [
        makeSnapshot({ key: 'slow', shapeDistM: 400, observedAtMs: T0 }),
        makeSnapshot({ key: 'fast', shapeDistM: 0, observedAtMs: T0, tripId: 'trip-fast' }),
      ],
      resolve,
      T0,
    );
    engine.tick(T0);
    const end = run(engine, T0, 150);
    // The fast tram sailed straight past — no queue across shapes.
    expect(state(engine, 'fast', end).simDistM).toBeGreaterThan(
      state(engine, 'slow', end).simDistM + 100,
    );
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

  it('falls back to raw coordinates/bearing with null deviation without geometry', () => {
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
    expect(s.observedBearing).toBe(123);
    expect(s.deviationM).toBeNull();
  });
});

// Type-level guard: snapshots keep satisfying the engine's ingest contract.
const _snapshotTypeCheck: TramSnapshot = makeSnapshot();
void _snapshotTypeCheck;
