// Unit tests for src/lib/tramStatus.ts — the one-line live status the home
// sheet's favourite rows show. The load-bearing case is DWELL: `nextStopName`
// is already the stop AFTER the platform the tram is standing at, so "At X" can
// only come from the trip geometry.

import { tramStatusLine } from '@/lib/tramStatus';
import type { RouteGeometry, TramPublicState } from '@/lib/types';
import { makeGeometry, makeSnapshot, makeSpec3 } from './helpers';

const BASE = 1_700_000_000_000;
const S = 1_000;

/** Alpha(0 m) → Beta(500 m) → Gamma(1000 m), trip 'trip-a', line 22. */
function geoA(): RouteGeometry {
  return {
    ...makeGeometry(
      [
        [0, 0],
        [1000, 0],
      ],
      [
        { atM: 0, name: 'Alpha', arrivalMs: BASE, departureMs: BASE },
        { atM: 500, name: 'Beta', arrivalMs: BASE + 120 * S, departureMs: BASE + 130 * S },
        { atM: 1000, name: 'Gamma', arrivalMs: BASE + 240 * S },
      ],
    ),
    tripId: 'trip-a',
    line: '22',
    headsign: 'Gamma',
  };
}

function makeState(over: Partial<TramPublicState> = {}): TramPublicState {
  return {
    key: '9201',
    snapshot: makeSnapshot({ key: '9201', tripId: 'trip-a', line: '22', headsign: 'Gamma' }),
    model: makeSpec3(),
    simDistM: 200,
    simSpeedKmh: 20,
    position: [14.6, 50.05],
    bearing: 90,
    phase: 'cruise',
    observedPosition: [14.6, 50.05],
    observedBearing: 90,
    deviationM: 0,
    fixedDistM: 200,
    pastHorizon: false,
    nextStopName: null,
    nextStopEtaS: null,
    hasGeometry: true,
    ...over,
  };
}

describe('tramStatusLine', () => {
  it('reports a car that is not in the feed as out of service', () => {
    expect(tramStatusLine(undefined, [geoA()])).toBe('Not in service');
  });

  it('says it is still placing a tram whose shape has not landed yet', () => {
    expect(tramStatusLine(makeState({ hasGeometry: false }), [geoA()])).toBe(
      'Locating on route…',
    );
  });

  it('says the same when the tram has geometry the UI has not loaded', () => {
    // hasGeometry is the ENGINE's view; the sheet only has what streamed in.
    expect(tramStatusLine(makeState(), [])).toBe('Locating on route…');
  });

  it('names the platform a dwelling tram is standing at, not the stop ahead', () => {
    const state = makeState({
      simDistM: 499,
      phase: 'dwell',
      // What the engine reports while dwelling AT Beta: the stop AFTER it.
      nextStopName: 'Gamma',
      nextStopEtaS: 110,
    });
    expect(tramStatusLine(state, [geoA()])).toBe('At Beta');
  });

  it('tolerates the 2 m dwell slack on either side of the platform', () => {
    const at = (simDistM: number) =>
      tramStatusLine(makeState({ simDistM, phase: 'dwell' }), [geoA()]);
    expect(at(498.5)).toBe('At Beta'); // just short — inside the slack
    expect(at(500)).toBe('At Beta'); // exactly on it
  });

  it('marks a terminal tram as at its terminus', () => {
    const state = makeState({ simDistM: 1000, phase: 'terminal' });
    expect(tramStatusLine(state, [geoA()])).toBe('At Gamma · terminus');
  });

  it('counts down to the next stop while cruising', () => {
    const state = makeState({ nextStopName: 'Beta', nextStopEtaS: 95 });
    expect(tramStatusLine(state, [geoA()])).toBe('Next Beta · 2 min');
  });

  it('drops the countdown when the engine has no ETA', () => {
    const state = makeState({ nextStopName: 'Beta', nextStopEtaS: null });
    expect(tramStatusLine(state, [geoA()])).toBe('Next Beta');
  });

  it('falls back to the headsign when no next stop is known', () => {
    expect(tramStatusLine(makeState(), [geoA()])).toBe('→ Gamma');
  });
});
