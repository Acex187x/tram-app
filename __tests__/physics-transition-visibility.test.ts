import { TramFleet } from '@/lib/physics/fleet';
import { TrajectoryStore } from '@/lib/physics/trajectoryStore';
import { getModelSpec } from '@/lib/fleet/registry';
import { T0, snapshot, straightGeometry, wireBundle, wireVehicle } from './physicsFixtures';

it('a dormant offscreen transition does not force other visible vehicles to high cadence', () => {
  const store = new TrajectoryStore();
  const fleet = new TramFleet({ trajectories: store, resolveModel: () => getModelSpec('15t') });
  fleet.ingest([snapshot()], () => straightGeometry());
  store.ingest(wireBundle({ vehicles: [wireVehicle()] }), T0);
  fleet.getStates(T0, 'smooth', true);
  const shown = fleet.getStates(T0 + 10_000, 'smooth', true)[0];
  expect(shown.presentationTransitionReason).toBe('resume-gap');
  expect(fleet.hasPresentationTransitions()).toBe(true);
  expect(fleet.hasPresentationTransitions(new Set(['other-visible']))).toBe(false);
  expect(fleet.hasPresentationTransitions([])).toBe(false);
  expect(fleet.hasPresentationTransitions(new Set(['9201']))).toBe(true);
  // Cadence inspection never acknowledges or consumes a hidden frame.
  const zero = fleet.getStates(T0 + 10_300, 'smooth', true)[0];
  expect(zero.presentationOpacity).toBe(0);
  for (let i = 0; i < 20; i++) fleet.hasPresentationTransitions(['9201']);
  const held = fleet.getStates(T0 + 10_400, 'smooth', true)[0];
  expect(held.presentationOpacity).toBe(0);
  expect(held.presentationHiddenFrameId).toBe(zero.presentationHiddenFrameId);
});
