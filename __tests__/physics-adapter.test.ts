/// <reference types="jest" />
//
// The UI-compatibility adapter: curves → TramPublicState. Everything the sheets,
// lists, timelines, planner and feature builder read is derived here, purely,
// so this suite is where "the app still means what it says" is enforced.

import { adaptTram, nearestStopIndex, nextStopIndex, DWELL_NEAR_STOP_M } from '@/lib/physics/adapter';
import { parseBundle, type ParsedVehicle } from '@/lib/physics/bundle';
import { SMOOTH_CATCHUP_V_MS } from '@/lib/physics/fixForward';
import { pointAt } from '@/lib/geo/polyline';
import { getModelSpec } from '@/lib/fleet/registry';
import type { RouteGeometry } from '@/lib/types';
import { T0, snapshot, straightGeometry, wireBundle, wireTrack, wireVehicle } from './physicsFixtures';

const MODEL = getModelSpec('15t');

function vehicleFrom(over: Parameters<typeof wireVehicle>[0] = {}): ParsedVehicle {
  const parsed = parseBundle(wireBundle({ vehicles: [wireVehicle(over)] }), T0)!;
  return parsed.vehicles.get(over.key ?? '9201')!;
}

function adapt(
  vehicle: ParsedVehicle | undefined,
  serverNowMs: number,
  geometry: RouteGeometry = straightGeometry(),
  mode: 'smooth' | 'fixed' = 'smooth',
  snap = snapshot(),
) {
  return adaptTram({ snapshot: snap, model: MODEL, geometry, vehicle, serverNowMs, mode });
}

/** Same, but with NO trip geometry (the shape is still streaming in). */
function adaptNoGeo(vehicle: ParsedVehicle | undefined, serverNowMs: number) {
  return adaptTram({
    snapshot: snapshot(),
    model: MODEL,
    geometry: undefined,
    vehicle,
    serverNowMs,
    mode: 'smooth',
  });
}

describe('stop index helpers', () => {
  const stops = [{ distM: 0 }, { distM: 500 }, { distM: 1_200 }, { distM: 3_000 }];
  const geo = straightGeometry(stops);

  it('nextStopIndex finds the first stop strictly ahead', () => {
    expect(nextStopIndex(geo.stops, -10)).toBe(0);
    expect(nextStopIndex(geo.stops, 0)).toBe(1); // standing AT stop 0 → next is 1
    expect(nextStopIndex(geo.stops, 499)).toBe(1);
    expect(nextStopIndex(geo.stops, 500)).toBe(2);
    expect(nextStopIndex(geo.stops, 2_999)).toBe(3);
    expect(nextStopIndex(geo.stops, 3_000)).toBe(-1); // past the last one
  });

  it('nearestStopIndex picks the closest either side', () => {
    expect(nearestStopIndex(geo.stops, 0)).toBe(0);
    expect(nearestStopIndex(geo.stops, 240)).toBe(0);
    expect(nearestStopIndex(geo.stops, 260)).toBe(1);
    expect(nearestStopIndex(geo.stops, 99_999)).toBe(3);
    expect(nearestStopIndex([], 10)).toBe(-1);
  });
});

describe('rendered position + speed', () => {
  it('renders the SMOOTH curve in smooth mode and the OPINION curve in fixed mode', () => {
    const v = vehicleFrom();
    expect(adapt(v, T0, straightGeometry(), 'smooth').simDistM).toBe(990);
    expect(adapt(v, T0, straightGeometry(), 'fixed').simDistM).toBe(1_000);
  });

  it('places the head on the polyline at that distance', () => {
    const geo = straightGeometry();
    const state = adapt(vehicleFrom(), T0, geo);
    expect(state.position).toEqual(pointAt(geo.coordinates, geo.cumDistM, 990));
    expect(state.hasGeometry).toBe(true);
  });

  it('derives speed from the curve itself (±0.5 s finite difference)', () => {
    // Both fixture curves advance at 10 m/s → 36 km/h.
    const state = adapt(vehicleFrom(), T0 + 30_000);
    expect(state.simSpeedKmh).toBeCloseTo(36, 6);
  });

  it('reports zero speed while the curve holds at a stop', () => {
    const held = [
      { t: T0, s: 500 },
      { t: T0 + 40_000, s: 500 },
      { t: T0 + 60_000, s: 700 },
    ];
    const v = vehicleFrom({ smooth: held, opinion: held });
    expect(adapt(v, T0 + 20_000).simSpeedKmh).toBe(0);
  });

  it('clamps the head into the geometry (a curve running past the shape end)', () => {
    const geo = straightGeometry();
    const runaway = wireTrack(T0, geo.totalM - 10, 500, 5);
    const state = adapt(vehicleFrom({ smooth: runaway, opinion: runaway }), T0 + 40_000, geo);
    expect(state.simDistM).toBe(geo.totalM);
  });

  it('without geometry it falls back to the raw AVL coordinate and bearing', () => {
    const state = adaptNoGeo(vehicleFrom(), T0);
    expect(state.hasGeometry).toBe(false);
    expect(state.position).toEqual([14.4, 50.08]);
    expect(state.bearing).toBe(90);
  });
});

describe('the smooth↔fixed comparison metric', () => {
  it('deviationM is |smooth − fixed| at the evaluated instant', () => {
    const state = adapt(vehicleFrom(), T0);
    expect(state.deviationM).toBeCloseTo(10, 6); // 1000 vs 990 at emission
    expect(state.fixedDistM).toBe(1_000);
  });

  it('is IDENTICAL in both render modes — it measures the curves, not the choice', () => {
    const v = vehicleFrom();
    const smooth = adapt(v, T0 + 20_000, straightGeometry(), 'smooth');
    const fixed = adapt(v, T0 + 20_000, straightGeometry(), 'fixed');
    expect(smooth.deviationM).toBeCloseTo(fixed.deviationM!, 9);
  });

  it('is null when the vehicle has only one curve', () => {
    expect(adapt(vehicleFrom({ smooth: [] }), T0).deviationM).toBeNull();
  });
});

describe('pastHorizon — never animate beyond the data', () => {
  it('is false inside the published horizon', () => {
    expect(adapt(vehicleFrom(), T0 + 60_000).pastHorizon).toBe(false);
  });

  it('coasts to a halt past the horizon, then freezes with zero speed', () => {
    // The curve ends at T0+120 s doing 10 m/s. Stopping dead at the last
    // keyframe is the one thing a tram cannot do, so the marker decelerates
    // over COAST_DECAY_MS (20 s) — 100 m, half the constant-speed distance —
    // and holds there forever after. `pastHorizon` stays true throughout, so
    // it renders dimmed the whole time: coasting is not a prediction.
    const v = vehicleFrom();
    const atEnd = adapt(v, T0 + 120_000);
    const midCoast = adapt(v, T0 + 130_000);
    const beyond = adapt(v, T0 + 10 * 60_000);
    expect(atEnd.pastHorizon).toBe(false);
    expect(midCoast.pastHorizon).toBe(true);
    expect(beyond.pastHorizon).toBe(true);
    expect(midCoast.simDistM).toBeGreaterThan(atEnd.simDistM);
    expect(midCoast.simSpeedKmh).toBeCloseTo(18, 6); // 5 m/s, half of 10
    expect(beyond.simDistM).toBeCloseTo(atEnd.simDistM + 100, 6);
    expect(beyond.simSpeedKmh).toBe(0);
    // …and it never runs on: 10 min and 1 h past the horizon are the same spot.
    expect(adapt(v, T0 + 60 * 60_000).simDistM).toBe(beyond.simDistM);
  });

  it('a vehicle with NO curves stands on its raw fix, marked frozen', () => {
    const state = adapt(undefined, T0);
    expect(state.pastHorizon).toBe(true);
    expect(state.simDistM).toBe(1_000); // snapshot.shapeDistM
    expect(state.simSpeedKmh).toBe(0);
    expect(state.deviationM).toBeNull();
    expect(state.fixedDistM).toBeNull();
  });

  it('a trajectory computed for a DIFFERENT trip is ignored (endpoint turn)', () => {
    const stale = vehicleFrom({ tripId: 'trip-previous' });
    const state = adapt(stale, T0);
    expect(state.pastHorizon).toBe(true);
    expect(state.simDistM).toBe(1_000); // the fix, not the stale curve
  });
});

describe('phase', () => {
  const stops = [{ distM: 0 }, { distM: 1_000 }, { distM: 3_000, isTerminal: true }];
  const geo = straightGeometry(stops);
  const heldAt = (s: number) => {
    const held = [
      { t: T0, s },
      { t: T0 + 60_000, s },
    ];
    return vehicleFrom({ smooth: held, opinion: held });
  };

  it("is 'dwell' when standing within 30 m of a stop", () => {
    expect(adapt(heldAt(1_000), T0 + 20_000, geo).phase).toBe('dwell');
    expect(adapt(heldAt(1_000 + DWELL_NEAR_STOP_M - 1), T0 + 20_000, geo).phase).toBe('dwell');
  });

  it("is 'cruise' when standing far from any stop (a jam, not a boarding)", () => {
    expect(adapt(heldAt(2_000), T0 + 20_000, geo).phase).toBe('cruise');
  });

  it("is 'cruise' while moving, even right next to a stop", () => {
    const moving = vehicleFrom({
      smooth: wireTrack(T0, 995, 10, 5),
      opinion: wireTrack(T0, 995, 10, 5),
    });
    expect(adapt(moving, T0, geo).phase).toBe('cruise');
  });

  it("is 'terminal' when standing at the last stop", () => {
    expect(adapt(heldAt(3_000), T0 + 20_000, geo).phase).toBe('terminal');
  });

  it("is 'unknown' without geometry or without curves", () => {
    expect(adaptNoGeo(vehicleFrom(), T0).phase).toBe('unknown');
    expect(adapt(undefined, T0, geo).phase).toBe('unknown');
  });
});

describe('next stop + ETA', () => {
  const stops = [{ distM: 0, name: 'A' }, { distM: 1_200, name: 'B' }, { distM: 2_000, name: 'C' }];
  const geo = straightGeometry(stops);

  it('names the first stop ahead of the RENDERED position', () => {
    // Smooth curve is at 990 m at T0 → next stop is B (1200 m).
    expect(adapt(vehicleFrom(), T0, geo).nextStopName).toBe('B');
  });

  it('ETA is the SMOOTH curve crossing that distance', () => {
    // Smooth: 990 m at T0, +10 m/s → 1200 m at T0 + 21 s.
    const state = adapt(vehicleFrom(), T0, geo);
    expect(state.nextStopEtaS).toBeCloseTo(21, 3);
  });

  it('uses the smooth ETA even while rendering the fixed curve', () => {
    // "When" is a property of the prediction, not of which curve you watch.
    const smooth = adapt(vehicleFrom(), T0, geo, 'smooth');
    const fixed = adapt(vehicleFrom(), T0, geo, 'fixed');
    expect(fixed.nextStopName).toBe(smooth.nextStopName);
    expect(fixed.nextStopEtaS).toBeCloseTo(smooth.nextStopEtaS!, 6);
  });

  it('ETA is NULL for a stop beyond the published horizon', () => {
    // Stop at 4 km is far past the 13-knot / 120 s curve.
    const far = straightGeometry([{ distM: 4_000, name: 'Far' }]);
    const state = adapt(vehicleFrom(), T0, far);
    expect(state.nextStopName).toBe('Far');
    expect(state.nextStopEtaS).toBeNull();
  });

  it('ETA never goes negative', () => {
    const state = adapt(vehicleFrom(), T0 + 25_000, geo);
    expect(state.nextStopEtaS === null || state.nextStopEtaS >= 0).toBe(true);
  });

  it('past the last stop there is no next stop', () => {
    const state = adapt(vehicleFrom(), T0 + 115_000, straightGeometry([{ distM: 100 }]));
    expect(state.nextStopName).toBeNull();
    expect(state.nextStopEtaS).toBeNull();
  });

  it('without curves the next stop is still knowable but the ETA is not', () => {
    const state = adapt(undefined, T0, geo);
    expect(state.nextStopName).toBe('B'); // fix at 1000 m
    expect(state.nextStopEtaS).toBeNull();
  });
});

describe('fix-forward — the newest fix moves the curve, it does not pin it', () => {
  // The bundle trails RemoteFeed by ~7–11 s (5 s poll + 2 s server cache + the
  // ML round trip the emission waits on): the phone holds a NEWER fix than the
  // curves' anchor, and the curve — or a modal hold standing at the OLD anchor
  // — renders behind the dot the user is looking at. Build 16 clamped the
  // render at the fix, which stopped the tram dead mid-segment. The curve is
  // now TRANSLATED through the fix, so it keeps moving on the server's own
  // velocity profile.
  const geo = straightGeometry();
  /** Curves anchored ~fix N; the phone's snapshot has moved on to fix N+1. */
  const newerFix = (shapeDistM: number, atMs = T0 + 20_000) =>
    snapshot({ shapeDistM, observedAtMs: atMs });

  it('puts the FIXED render on the newest same-trip fix', () => {
    // Opinion is at 1000 + 10·20 = 1200 m at T0+20 s; the newest fix says 1300.
    const state = adapt(vehicleFrom(), T0 + 20_000, geo, 'fixed', newerFix(1_300));
    expect(state.simDistM).toBe(1_300);
  });

  it('leaves fixedDistM RAW — the calibration loop scores the model, not us', () => {
    // fixedDistM is written as `projDist` into every calibration/ride record
    // and scored against the next fix as the MODEL's error. If the client's
    // own correction leaked into it, the physics-tuning loop would grade the
    // server on the client's homework (build 16 floored it, and did).
    const state = adapt(vehicleFrom(), T0 + 20_000, geo, 'fixed', newerFix(1_300));
    expect(state.fixedDistM).toBe(1_200); // the served opinion, untouched
    expect(state.simDistM).toBe(1_300); // …while the marker rides the fix
  });

  it('KEEPS MOVING afterwards instead of standing at the fix (the build-16 bug)', () => {
    // The whole point. Under the old max() clamp the marker sat at 1300 m for
    // the 10 s it took the curve to climb past it — a tram standing still on
    // open track. Translated, it does the curve's own 10 m/s from the fix.
    const v = vehicleFrom();
    const fix = newerFix(1_300);
    const at20 = adapt(v, T0 + 20_000, geo, 'fixed', fix);
    const at25 = adapt(v, T0 + 25_000, geo, 'fixed', fix);
    const at30 = adapt(v, T0 + 30_000, geo, 'fixed', fix);
    expect(at25.simDistM).toBeCloseTo(1_350, 6);
    expect(at30.simDistM).toBeCloseTo(1_400, 6);
    expect(at20.simSpeedKmh).toBeCloseTo(36, 6); // never reports a stall
    expect(at25.simSpeedKmh).toBeCloseTo(36, 6);
  });

  it('a stop the tram has provably left is not rendered as a dwell', () => {
    // The curve holds at the 1000 m platform until T0+60 s; the fix proves the
    // tram was 180 m past it at T0+20 s. Winding the curve forward in TIME
    // skips the stale hold. (Translating it in SPACE instead would carry the
    // hold to 1180 m and park the tram in mid-block — the artefact being
    // fixed, relocated — which is why the shim is a time shift.)
    const held = [
      { t: T0, s: 1_000 },
      { t: T0 + 60_000, s: 1_000 },
      { t: T0 + 120_000, s: 1_600 },
    ];
    const stops = [{ distM: 1_000, name: 'B' }, { distM: 1_600, name: 'C' }];
    const v = vehicleFrom({ smooth: held, opinion: held });
    const fix = newerFix(1_180);
    const at20 = adapt(v, T0 + 20_000, straightGeometry(stops), 'fixed', fix);
    const at30 = adapt(v, T0 + 30_000, straightGeometry(stops), 'fixed', fix);
    expect(at20.simDistM).toBeCloseTo(1_180, 6); // on the fix
    expect(at30.simDistM).toBeGreaterThan(1_270); // and rolling, not held
    expect(at20.simSpeedKmh).toBeGreaterThan(30);
    expect(at20.phase).toBe('cruise');
    expect(at20.nextStopName).toBe('C');
  });

  it('but a hold the fix CONFIRMS is still a hold', () => {
    const held = [
      { t: T0, s: 1_000 },
      { t: T0 + 60_000, s: 1_000 },
      { t: T0 + 120_000, s: 1_600 },
    ];
    const v = vehicleFrom({ smooth: held, opinion: held });
    const stops = [{ distM: 1_000, name: 'B' }];
    const st = adapt(v, T0 + 20_000, straightGeometry(stops), 'fixed', newerFix(1_000));
    expect(st.simDistM).toBe(1_000);
    expect(st.simSpeedKmh).toBe(0);
    expect(st.phase).toBe('dwell');
  });

  it('is a no-op when the curve is already at/ahead of the fix', () => {
    const state = adapt(vehicleFrom(), T0 + 20_000, geo, 'fixed', newerFix(1_100));
    expect(state.simDistM).toBe(1_200); // the curve, not the older fix
  });

  it('never fires on a fix the curve was already built from', () => {
    // The default snapshot IS the curves' anchor fix (1000 m), and the smooth
    // track legitimately starts 10 m behind it — that is continuity, not
    // staleness. Dragging it forward would re-teleport what smooth removes.
    expect(adapt(vehicleFrom(), T0, geo, 'smooth').simDistM).toBe(990);
    expect(adapt(vehicleFrom(), T0, geo, 'fixed').simDistM).toBe(1_000);
  });

  it('closes the gap gradually in SMOOTH mode, never in one step', () => {
    // Fix observed at T0+20 s, 110 m ahead of the smooth curve (1190 m). The
    // smooth track may not teleport, so it walks to the wound-forward curve at
    // SMOOTH_CATCHUP_V_MS on top of its own motion. The allowance accrues from
    // THE FIX OBSERVATION (hunt1 post-mortem: a curve-start datum pre-accrues
    // a 100+ m bank that is spent in one frame — 66 % of field teleports), so
    // at the fix instant it is exactly zero.
    const v = vehicleFrom();
    const fix = newerFix(1_300);
    const at20 = adapt(v, T0 + 20_000, geo, 'smooth', fix);
    const at25 = adapt(v, T0 + 25_000, geo, 'smooth', fix);
    expect(at20.simDistM).toBeCloseTo(1_190, 6); // raw curve + 0 allowance yet
    expect(at25.simDistM).toBeCloseTo(1_250, 6); // 1240 + 2 m/s × 5 s
    expect(at25.simSpeedKmh).toBeCloseTo(43.2, 6); // 12 m/s: 10 curve + 2 catch-up
    // …it never overshoots the wound-forward curve (τ = 11 s ⇒ shifted is
    // smooth(t+11 s)); at 60 s the allowance (80 m) is still short of the
    // 110 m offset, at 80 s the catch-up has completed.
    const at60 = adapt(v, T0 + 60_000, geo, 'smooth', fix);
    expect(at60.simDistM).toBeCloseTo(1_670, 6); // 1590 + 2 m/s × 40 s, capped
    expect(at60.simSpeedKmh).toBeCloseTo(43.2, 6);
    const at80 = adapt(v, T0 + 80_000, geo, 'smooth', fix);
    expect(at80.simDistM).toBeCloseTo(1_900, 6); // = smooth(80+11 s), caught up
    expect(at80.simSpeedKmh).toBeCloseTo(36, 6);
  });

  it('the ETA never says «arriving now» for a stop the marker is short of', () => {
    // The ETA basis is the smooth track at the smooth catch-up rate — the same
    // motion the smooth marker rides. Without that pairing (ETA taking the
    // whole gap while the marker takes the rate-limited part) a stop 60 m
    // ahead of the marker reads 0 s in the sheet, the timeline, the status
    // line and the fleet filter.
    const stopped = straightGeometry([{ distM: 1_250, name: 'B' }]);
    const fix = newerFix(1_300);
    const state = adapt(vehicleFrom(), T0 + 20_000, stopped, 'smooth', fix);
    expect(state.simDistM).toBeCloseTo(1_190, 6); // 60 m short of the stop
    expect(state.nextStopName).toBe('B');
    expect(state.nextStopEtaS).toBeGreaterThan(1);
    // Walk forward: by the instant the ETA named, the marker HAS reached the
    // stop. It gets there a metre or two early — the offset keeps closing
    // while the tram travels, and the ETA is computed from the offset now —
    // which is the safe direction for a countdown.
    const etaS = state.nextStopEtaS!;
    const arrival = adapt(vehicleFrom(), T0 + 20_000 + etaS * 1_000, stopped, 'smooth', fix);
    expect(arrival.simDistM).toBeGreaterThanOrEqual(1_250);
    expect(arrival.simDistM).toBeLessThan(1_250 + SMOOTH_CATCHUP_V_MS * etaS + 1);
  });

  it('the FIXED marker errs late against the ETA, never early', () => {
    // The fixed track runs ahead of the smooth ETA basis by design ("fixed
    // exists to be visibly beaten by smooth"), so its ETA is conservative.
    const stopped = straightGeometry([{ distM: 2_000, name: 'C' }]);
    const fix = newerFix(1_300);
    const st = adapt(vehicleFrom(), T0 + 20_000, stopped, 'fixed', fix);
    const remainingS = (2_000 - st.simDistM) / 10; // the marker's own 10 m/s
    expect(st.nextStopEtaS).toBeGreaterThanOrEqual(remainingS);
  });

  it('does nothing when rendering falls back to the raw fix anyway', () => {
    // No curves at all → no velocity profile to translate; the fix fallback
    // already stands the tram on the last real observation.
    const state = adapt(undefined, T0 + 20_000, geo, 'fixed', newerFix(1_300));
    expect(state.simDistM).toBe(1_300);
    expect(state.fixedDistM).toBeNull();
  });
});

describe('observed (raw fix) fields survive for the fix overlay', () => {
  it('projects the AVL fix onto the shape when geometry is known', () => {
    const geo = straightGeometry();
    const state = adapt(vehicleFrom(), T0, geo);
    expect(state.observedPosition).toEqual(pointAt(geo.coordinates, geo.cumDistM, 1_000));
    expect(state.observedBearing).toBeCloseTo(90, 0);
  });

  it('falls back to the raw AVL coordinate without geometry', () => {
    const state = adaptNoGeo(vehicleFrom(), T0);
    expect(state.observedPosition).toEqual([14.4, 50.08]);
    expect(state.observedBearing).toBe(90);
  });
});
