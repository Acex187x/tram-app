// Unit tests for the walk-time math (src/lib/arrivals.ts) and the journey
// guidance state machine (src/lib/planner/guidance.ts) over synthetic fixtures.

import {
  computeItineraryTiming,
  computeLeaveByMs,
  itineraryAccessWalkS,
  itineraryEgressWalkS,
  LEAVE_BUFFER_MS,
  WALK_DETOUR_FACTOR,
  WALK_SPEED_MPS,
  walkSecondsBetween,
  walkSecondsForMeters,
} from '@/lib/arrivals';
import {
  activeStepIndex,
  BOARD_DEPART_SLACK_M,
  buildSteps,
  EXIT_ARRIVE_SLACK_M,
  initialProgress,
  legTramPosition,
  tickGuidance,
  type GuidanceProgress,
} from '@/lib/planner/guidance';
import type {
  PlannerItinerary,
  PlannerLeg,
  RouteGeometry,
  TramPublicState,
  TramSnapshot,
} from '@/lib/types';
import { makeGeometry, makeSnapshot, makeSpec3, metersToCoord, ORIGIN } from './helpers';

const BASE = 1_700_000_000_000;
const S = 1_000;

/** Line 22: Alpha(0m) → Beta(500m) → Gamma(1000m). */
function geoA(tripId = 'trip-a', shiftS = 0): RouteGeometry {
  return {
    ...makeGeometry(
      [
        [0, 0],
        [1000, 0],
      ],
      [
        { atM: 0, name: 'Alpha', arrivalMs: BASE + shiftS * S, departureMs: BASE + shiftS * S },
        {
          atM: 500,
          name: 'Beta',
          arrivalMs: BASE + (120 + shiftS) * S,
          departureMs: BASE + (130 + shiftS) * S,
        },
        { atM: 1000, name: 'Gamma', arrivalMs: BASE + (240 + shiftS) * S },
      ],
    ),
    tripId,
    line: '22',
    headsign: 'Gamma',
  };
}

/** Line 9 crossing at Beta: Beta(0m) → Delta(800m). */
function geoB(tripId: string, betaDepS: number): RouteGeometry {
  return {
    ...makeGeometry(
      [
        [0, 0],
        [0, 800],
      ],
      [
        {
          atM: 0,
          name: 'Beta',
          arrivalMs: BASE + (betaDepS - 10) * S,
          departureMs: BASE + betaDepS * S,
        },
        { atM: 800, name: 'Delta', arrivalMs: BASE + (betaDepS + 170) * S },
      ],
    ),
    tripId,
    line: '9',
    headsign: 'Delta',
  };
}

function makeState(opts: {
  key: string;
  tripId: string;
  line: string;
  simDistM: number;
  delaySeconds?: number;
  isCanceled?: boolean;
}): TramPublicState {
  const snapshot: TramSnapshot = makeSnapshot({
    key: opts.key,
    tripId: opts.tripId,
    line: opts.line,
    delaySeconds: opts.delaySeconds ?? 0,
    registrationNumber: Number(opts.key) || null,
    isCanceled: opts.isCanceled ?? false,
  });
  return {
    key: opts.key,
    snapshot,
    model: makeSpec3(),
    simDistM: opts.simDistM,
    simSpeedKmh: 20,
    position: [14.6, 50.05],
    bearing: 90,
    phase: 'cruise',
    observedPosition: [14.6, 50.05],
    observedBearing: 90,
    deviationM: 0,
    projectedObservedDistM: opts.simDistM,
    nextStopName: null,
    nextStopEtaS: null,
    hasGeometry: true,
  };
}

function leg(line: string, from: string, to: string, stopCount = 1): PlannerLeg {
  return {
    line,
    fromStopId: `${from}-id`,
    fromStopName: from,
    toStopId: `${to}-id`,
    toStopName: to,
    stopCount,
    coordinates: [],
  };
}

function itin(...legs: PlannerLeg[]): PlannerItinerary {
  return {
    legs,
    transferCount: legs.length - 1,
    totalStops: legs.reduce((sum, l) => sum + l.stopCount, 0),
  };
}

// ── Walk-time math ───────────────────────────────────────────────────────────

describe('walkSecondsForMeters', () => {
  it('applies the detour factor over the pedestrian speed', () => {
    expect(walkSecondsForMeters(1000)).toBeCloseTo((1000 * WALK_DETOUR_FACTOR) / WALK_SPEED_MPS, 6);
    expect(walkSecondsForMeters(1000)).toBeCloseTo(962.96, 1);
  });

  it('is 0 for zero, negative and non-finite distances', () => {
    expect(walkSecondsForMeters(0)).toBe(0);
    expect(walkSecondsForMeters(-5)).toBe(0);
    expect(walkSecondsForMeters(Number.NaN)).toBe(0);
  });
});

describe('walkSecondsBetween', () => {
  it('measures the great-circle distance between coordinates', () => {
    const a = metersToCoord(ORIGIN, 0, 0);
    const b = metersToCoord(ORIGIN, 300, 400); // 500 m apart
    expect(walkSecondsBetween(a, b)).toBeCloseTo(walkSecondsForMeters(500), 0);
  });
});

describe('computeLeaveByMs', () => {
  it('subtracts the walk plus the 1-minute buffer from the departure', () => {
    expect(computeLeaveByMs(BASE, 600)).toBe(BASE - 600 * S - LEAVE_BUFFER_MS);
    expect(LEAVE_BUFFER_MS).toBe(60_000);
  });
});

describe('itineraryAccessWalkS / itineraryEgressWalkS', () => {
  const boarding = metersToCoord(ORIGIN, 0, 0);
  const alighting = metersToCoord(ORIGIN, 1000, 0);
  const withShape: PlannerItinerary = itin({
    ...leg('22', 'Alpha', 'Gamma', 2),
    coordinates: [boarding, alighting],
  });

  it('walks from the user to the first leg boarding point', () => {
    const user = metersToCoord(ORIGIN, -300, -400); // 500 m from boarding
    expect(itineraryAccessWalkS(user, withShape)).toBeCloseTo(walkSecondsForMeters(500), 0);
  });

  it('walks from the alighting point to a non-stop destination', () => {
    const dest = metersToCoord(ORIGIN, 1300, 400); // 500 m from alighting
    expect(itineraryEgressWalkS(dest, withShape)).toBeCloseTo(walkSecondsForMeters(500), 0);
  });

  it('returns null when the leg has no shape coordinates yet', () => {
    const bare = itin(leg('22', 'Alpha', 'Gamma'));
    expect(itineraryAccessWalkS([14.6, 50.05], bare)).toBeNull();
    expect(itineraryEgressWalkS([14.6, 50.05], bare)).toBeNull();
  });
});

// ── Catchability floor (earliestDepartureMs) ─────────────────────────────────

describe('computeItineraryTiming earliestDepartureMs', () => {
  it('skips a tram the user cannot physically reach and picks the next one', () => {
    // Two line-22 runs: departs Alpha at BASE, and at BASE+600s.
    const geos = [geoA('trip-a', 0), geoA('trip-a2', 600)];
    const states = [
      makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 0 }),
      makeState({ key: '9202', tripId: 'trip-a2', line: '22', simDistM: 0 }),
    ];
    const legs = [leg('22', 'Alpha', 'Gamma', 2)];
    const now = BASE - 60 * S;

    // Without a walk floor the first tram wins.
    const unfloored = computeItineraryTiming(legs, states, geos, now);
    expect(unfloored.legs[0].tram?.key).toBe('9201');

    // A 5-minute walk makes the BASE departure uncatchable.
    const floored = computeItineraryTiming(legs, states, geos, now, {
      earliestDepartureMs: now + 300 * S,
    });
    expect(floored.legs[0].tram?.key).toBe('9202');
    expect(floored.legs[0].departureMs).toBe(BASE + 600 * S);
  });

  it('also excludes a dwelling tram whose departure would be floored to now', () => {
    const states = [makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 0 })];
    const now = BASE + 60 * S; // scheduled slot passed; tram still at Alpha
    const timing = computeItineraryTiming(
      [leg('22', 'Alpha', 'Gamma', 2)],
      states,
      [geoA()],
      now,
      { earliestDepartureMs: now + 120 * S },
    );
    expect(timing.legs[0].tram).toBeNull();
  });
});

// ── legTramPosition ──────────────────────────────────────────────────────────

describe('legTramPosition', () => {
  const geo = geoA();

  it('tracks stops remaining, departure and arrival along the leg', () => {
    // Waiting at Alpha, tram not yet departed.
    let pos = legTramPosition(geo, 0, 'alpha', 'gamma')!;
    expect(pos.stopsRemaining).toBe(2);
    expect(pos.departedFrom).toBe(false);
    expect(pos.arrivedAtExit).toBe(false);

    // Just past the boarding slack → departed.
    pos = legTramPosition(geo, BOARD_DEPART_SLACK_M + 1, 'alpha', 'gamma')!;
    expect(pos.departedFrom).toBe(true);
    expect(pos.stopsRemaining).toBe(2);

    // Past Beta → the next stop is the exit.
    pos = legTramPosition(geo, 600, 'alpha', 'gamma')!;
    expect(pos.stopsRemaining).toBe(1);
    expect(pos.nextIsExit).toBe(true);

    // Within the arrival slack of Gamma.
    pos = legTramPosition(geo, 1000 - EXIT_ARRIVE_SLACK_M, 'alpha', 'gamma')!;
    expect(pos.arrivedAtExit).toBe(true);
  });

  it('returns null when the geometry does not ride from → to in order', () => {
    expect(legTramPosition(geo, 0, 'gamma', 'alpha')).toBeNull();
    expect(legTramPosition(geo, 0, 'alpha', 'omega')).toBeNull();
  });
});

// ── tickGuidance ─────────────────────────────────────────────────────────────

describe('tickGuidance', () => {
  const direct = itin(leg('22', 'Alpha', 'Gamma', 2));
  const transfer = itin(leg('22', 'Alpha', 'Beta'), leg('9', 'Beta', 'Delta'));

  it('initialProgress starts in walk only when there is a walk', () => {
    expect(initialProgress(300).phase).toBe('walk');
    expect(initialProgress(0).phase).toBe('wait');
  });

  it('advances walk → wait when the walk time has elapsed', () => {
    const progress = initialProgress(300);
    const walkUntil = BASE + 300 * S;
    const before = tickGuidance(direct, progress, [], [geoA()], BASE + 100 * S, walkUntil);
    expect(before.progress.phase).toBe('walk');
    const after = tickGuidance(direct, progress, [], [geoA()], walkUntil, walkUntil);
    expect(after.progress.phase).toBe('wait');
  });

  it('binds the next catchable tram while waiting and reports its timing', () => {
    const states = [makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 0 })];
    const progress: GuidanceProgress = { legIndex: 0, phase: 'wait', tramKey: null };
    const tick = tickGuidance(direct, progress, states, [geoA()], BASE - 60 * S, 0);
    expect(tick.progress.tramKey).toBe('9201');
    expect(tick.wait?.departureMs).toBe(BASE);
  });

  it('assumes boarding when the bound tram pulls away from the stop', () => {
    const states = [
      makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: BOARD_DEPART_SLACK_M + 10 }),
    ];
    const progress: GuidanceProgress = { legIndex: 0, phase: 'wait', tramKey: '9201' };
    const tick = tickGuidance(direct, progress, states, [geoA()], BASE + 10 * S, 0);
    expect(tick.progress.phase).toBe('ride');
    expect(tick.progress.tramKey).toBe('9201');
    expect(tick.pos?.departedFrom).toBe(true);
    // Boarding freezes the pinned tram's exit arrival (Gamma @ BASE+240s, delay 0).
    expect(tick.progress.rideArrivalMs).toBe(BASE + 240 * S);
    expect(tick.arrivalMs).toBe(BASE + 240 * S);
  });

  it('keeps the bound tram through the departure dead-zone (no jump to the tram behind)', () => {
    // '9201' is 10 m past Alpha: excluded from the fresh candidate search (>2 m
    // past the stop) yet not "departed" (<30 m). The buggy code rebound to the
    // follower here; the fix keeps the binding so departedFrom can still fire.
    const geos = [geoA('trip-a'), geoA('trip-a2', 600)];
    const states = [
      makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 10 }),
      makeState({ key: '9202', tripId: 'trip-a2', line: '22', simDistM: 0 }),
    ];
    const progress: GuidanceProgress = { legIndex: 0, phase: 'wait', tramKey: '9201' };
    const tick = tickGuidance(direct, progress, states, geos, BASE + 5 * S, 0);
    expect(tick.progress.phase).toBe('wait');
    expect(tick.progress.tramKey).toBe('9201'); // NOT the follower '9202'
  });

  it('holds the pinned tram ETA in ride even as an earlier tram behind approaches', () => {
    const frozen = BASE + 240 * S;
    // '9202' is earlier AND closer to Gamma — it would win a nearest-tram search,
    // but ride must ignore it and hold the pinned tram's frozen arrival.
    const geos = [geoA('trip-a'), geoA('trip-a2', -30)];
    const states = [
      makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 300 }),
      makeState({ key: '9202', tripId: 'trip-a2', line: '22', simDistM: 400, delaySeconds: 120 }),
    ];
    const progress: GuidanceProgress = {
      legIndex: 0,
      phase: 'ride',
      tramKey: '9201',
      rideArrivalMs: frozen,
    };
    const tick = tickGuidance(direct, progress, states, geos, BASE + 150 * S, 0);
    expect(tick.progress).toBe(progress); // pinned, unchanged reference
    expect(tick.progress.tramKey).toBe('9201');
    expect(tick.arrivalMs).toBe(frozen); // not '9202'’s arrival
    expect(tick.pos?.simDistM).toBe(300); // position tracked from the pinned tram
  });

  it('holds the schedule (no re-bind) when the pinned tram leaves the feed mid-ride', () => {
    const frozen = BASE + 240 * S;
    // Only a DIFFERENT live tram remains; ride must not adopt it.
    const states = [makeState({ key: '9202', tripId: 'trip-a2', line: '22', simDistM: 100 })];
    const progress: GuidanceProgress = {
      legIndex: 0,
      phase: 'ride',
      tramKey: '9201',
      rideArrivalMs: frozen,
    };
    const tick = tickGuidance(
      direct,
      progress,
      states,
      [geoA('trip-a'), geoA('trip-a2', 600)],
      BASE + 150 * S,
      0,
    );
    expect(tick.progress).toBe(progress);
    expect(tick.progress.tramKey).toBe('9201'); // still pinned to the vanished tram
    expect(tick.pos).toBeNull();
    expect(tick.arrivalMs).toBe(frozen); // scheduled ETA held
  });

  it('does NOT board from the walk phase', () => {
    const states = [
      makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: BOARD_DEPART_SLACK_M + 10 }),
    ];
    const progress: GuidanceProgress = { legIndex: 0, phase: 'walk', tramKey: '9201' };
    const tick = tickGuidance(direct, progress, states, [geoA()], BASE, BASE + 600 * S);
    expect(tick.progress.phase).toBe('walk');
  });

  it('rides through intermediate stops and reports the exit-next flag', () => {
    const states = [makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 600 })];
    const progress: GuidanceProgress = { legIndex: 0, phase: 'ride', tramKey: '9201' };
    const tick = tickGuidance(direct, progress, states, [geoA()], BASE + 150 * S, 0);
    expect(tick.progress).toBe(progress); // unchanged reference
    expect(tick.pos?.stopsRemaining).toBe(1);
    expect(tick.pos?.nextIsExit).toBe(true);
  });

  it('advances to the transfer wait when the tram reaches the exit stop', () => {
    const states = [makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 490 })];
    const progress: GuidanceProgress = { legIndex: 0, phase: 'ride', tramKey: '9201' };
    const tick = tickGuidance(transfer, progress, states, [geoA()], BASE + 120 * S, 0);
    expect(tick.progress).toEqual({ legIndex: 1, phase: 'wait', tramKey: null });
  });

  it('arrives after the last leg', () => {
    const states = [makeState({ key: '9201', tripId: 'trip-a', line: '22', simDistM: 990 })];
    const progress: GuidanceProgress = { legIndex: 0, phase: 'ride', tramKey: '9201' };
    const tick = tickGuidance(direct, progress, states, [geoA()], BASE + 240 * S, 0);
    expect(tick.progress.phase).toBe('arrived');
    // Arrived is terminal.
    const again = tickGuidance(direct, tick.progress, states, [geoA()], BASE + 300 * S, 0);
    expect(again.progress).toBe(tick.progress);
  });

  it('keeps riding (without live position) when the tram drops off the feed', () => {
    const progress: GuidanceProgress = { legIndex: 0, phase: 'ride', tramKey: '9201' };
    const tick = tickGuidance(direct, progress, [], [geoA()], BASE + 150 * S, 0);
    expect(tick.progress).toBe(progress);
    expect(tick.pos).toBeNull();
  });

  it('matches the connecting line while waiting at the transfer stop', () => {
    const geos = [geoA(), geoB('trip-b', 300)];
    const states = [makeState({ key: '8001', tripId: 'trip-b', line: '9', simDistM: 0 })];
    const progress: GuidanceProgress = { legIndex: 1, phase: 'wait', tramKey: null };
    const tick = tickGuidance(transfer, progress, states, geos, BASE + 250 * S, 0);
    expect(tick.progress.tramKey).toBe('8001');
    expect(tick.wait?.departureMs).toBe(BASE + 300 * S);
  });
});

// ── Steps ────────────────────────────────────────────────────────────────────

describe('buildSteps / activeStepIndex', () => {
  const transfer = itin(leg('22', 'Alpha', 'Beta'), leg('9', 'Beta', 'Delta'));

  it('flattens walk + board/ride per leg + arrive', () => {
    const steps = buildSteps(transfer, true);
    expect(steps.map((s) => s.kind)).toEqual(['walk', 'board', 'ride', 'board', 'ride', 'arrive']);
    expect(steps[3]).toMatchObject({ kind: 'board', legIndex: 1, transfer: true });
    expect(steps[5]).toMatchObject({ kind: 'arrive', stopName: 'Delta' });
  });

  it('omits the walk step without an access walk', () => {
    expect(buildSteps(transfer, false).map((s) => s.kind)).toEqual([
      'board',
      'ride',
      'board',
      'ride',
      'arrive',
    ]);
  });

  it('maps progress phases onto step indices', () => {
    const steps = buildSteps(transfer, true);
    expect(activeStepIndex(steps, { legIndex: 0, phase: 'walk', tramKey: null })).toBe(0);
    expect(activeStepIndex(steps, { legIndex: 0, phase: 'wait', tramKey: null })).toBe(1);
    expect(activeStepIndex(steps, { legIndex: 0, phase: 'ride', tramKey: null })).toBe(2);
    expect(activeStepIndex(steps, { legIndex: 1, phase: 'wait', tramKey: null })).toBe(3);
    expect(activeStepIndex(steps, { legIndex: 1, phase: 'ride', tramKey: null })).toBe(4);
    expect(activeStepIndex(steps, { legIndex: 1, phase: 'arrived', tramKey: null })).toBe(5);
  });
});
