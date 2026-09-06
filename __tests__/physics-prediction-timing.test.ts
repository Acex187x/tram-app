import { predictionTimingEligibility } from '@/lib/physics/predictionTiming';
import { parseRideFile } from '@/lib/motionlog/rideFile';
import { TramFleet } from '@/lib/physics/fleet';
import { TrajectoryStore } from '@/lib/physics/trajectoryStore';
import { getModelSpec } from '@/lib/fleet/registry';
import { rideRecord } from '@/lib/motionlog/core';
import { toCalibrationRecord } from '@/lib/feed/calibration';
import { T0, snapshot, straightGeometry, wireBundle, wireVehicle } from './physicsFixtures';

it('does not trust a recorded eligibility flag over mismatching or unknown timestamps', () => {
  const rows = [
    { t: 100, lagM: -10, predictionEvaluatedAtMs: 100, predictionInputsAvailableAtMs: 90 },
    { t: 100, lagM: 1000, predictionEvaluatedAtMs: 110, predictionInputsAvailableAtMs: 90, predictionAccuracyEligible: true },
    { t: 100, lagM: 2000, predictionEvaluatedAtMs: 100, predictionInputsAvailableAtMs: 1010 },
    { t: 100, lagM: 3000 },
    { t: 100, lagM: 4000, predictionEvaluatedAtMs: 100, predictionInputsAvailableAtMs: 90, rej: 'jump' },
  ];
  const parsed = parseRideFile(rows.map(r => JSON.stringify(r)).join('\n'));
  expect(parsed.predictionTimingCounts).toEqual({ eligible: 2, 'timestamp-mismatch': 1, 'future-input': 1, 'unknown-availability': 1 });
  expect(parsed.timingEligibleLagPoints).toBe(1);
  expect(parsed.timingEligibleMaeM).toBe(10);
  expect(parsed.meanLagM).toBe(1998); // historical descriptive field preserved
});

it('excludes a late GPS callback evaluated with a subsequently received revision', () => {
  const store = new TrajectoryStore();
  const fleet = new TramFleet({ trajectories: store, resolveModel: () => getModelSpec('15t') });
  const geometry = straightGeometry();
  fleet.ingest([snapshot()], () => geometry, T0);
  store.ingest(wireBundle(), T0);
  const first = fleet.getPredictionState('9201', T0 + 5000)!;
  expect(predictionTimingEligibility(first, T0 + 5000)).toBe('eligible');
  store.ingest(wireBundle({ serverNowMs: T0 + 10000, vehicles: [wireVehicle({ emittedAtMs: T0 + 10000 })] }), T0 + 10000);
  const late = fleet.getPredictionState('9201', T0 + 5000)!;
  const record = JSON.parse(rideRecord({ t: T0 + 5000, lat: 50, lng: 14, accuracy: 4, speed: 5 }, late));
  expect(record.predictionEvaluatedAtMs).toBe(T0 + 5000);
  expect(record.predictionAccuracyEligible).toBe(false);
  expect(record.predictionTimingReason).toBe('future-input');
  expect(toCalibrationRecord(late, T0 + 20000).predictionTimingReason).toBe('timestamp-mismatch');
  expect(fleet.hasPresentationTransitions()).toBe(false);
});

it('counts a later clock correction as future information even with an unchanged curve', () => {
  const store = new TrajectoryStore();
  const fleet = new TramFleet({ trajectories: store, resolveModel: () => getModelSpec('15t') });
  const geometry = straightGeometry();
  fleet.ingest([snapshot()], () => geometry, T0);
  store.ingest(wireBundle(), T0);
  store.noteConvexClock(T0 + 10005, T0 + 10000, T0 + 10010);
  expect(predictionTimingEligibility(fleet.getPredictionState('9201', T0 + 5000), T0 + 5000)).toBe('future-input');
});
