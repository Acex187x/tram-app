/// <reference types="jest" />
//
// The Convex push transport's store side: seeding, folding diff batches,
// removals, and the meta heartbeat. The wire objects here are exactly what
// convex/trajectories.ts serves (`fullSet` / `batchesSince` / `meta`), so this
// file is the client half of that contract — change them together.

import { TrajectoryStore } from '@/lib/physics/trajectoryStore';
import { T0, wireVehicle } from './physicsFixtures';

const META = {
  atMs: T0,
  horizonS: 120,
  generator: 'drive-v3',
  lastSeq: 41,
  publishedAtMs: T0,
  serverNowMs: T0 + 500,
};

function seededStore(): TrajectoryStore {
  const store = new TrajectoryStore();
  store.seedConvex([wireVehicle({ key: '9201' }), wireVehicle({ key: '9202' })], META, T0 + 700);
  return store;
}

describe('TrajectoryStore as the Convex sink', () => {
  it('seeds a full bundle from rows + meta (clock, generator, staleness datum)', () => {
    const store = seededStore();
    expect(store.bundle?.vehicles.size).toBe(2);
    expect(store.bundle?.atMs).toBe(T0);
    expect(store.bundle?.generator).toBe('drive-v3');
    expect(store.getVehicle('9201')?.tripId).toBeDefined();
    expect(store.health(T0 + 700).clockSynced).toBe(true);
  });

  it('folds changed rows, applies removals, and advances the bundle clock', () => {
    const store = seededStore();
    const updated = wireVehicle({ key: '9201', emittedAtMs: T0 + 2_000 });
    store.foldConvex(
      { seq: 42, atMs: T0 + 2_000, changed: [updated], removed: ['9202'] },
      T0 + 2_500,
      T0 + 2_700,
    );
    expect(store.bundle?.vehicles.size).toBe(1);
    expect(store.getVehicle('9202')).toBeUndefined();
    expect(store.getVehicle('9201')?.emittedAtMs).toBe(T0 + 2_000);
    expect(store.bundle?.atMs).toBe(T0 + 2_000);
  });

  it('ignores a fold that arrives before any seed (protocol: seed first)', () => {
    const store = new TrajectoryStore();
    store.foldConvex({ seq: 1, atMs: T0, changed: [wireVehicle({})], removed: undefined }, T0, T0);
    expect(store.bundle).toBeNull();
  });

  it('meta heartbeat advances bundle age without touching vehicles or failures', () => {
    const store = seededStore();
    store.noteConvexFailure('seed blip');
    const before = store.health(T0 + 700).consecutiveFailures;
    store.noteConvexMeta({ ...META, atMs: T0 + 10_000, serverNowMs: T0 + 10_500 }, T0 + 10_600);
    expect(store.bundle?.vehicles.size).toBe(2);
    expect(store.bundle?.atMs).toBe(T0 + 10_000);
    // A heartbeat proves the publisher is alive, not that the seed recovered.
    expect(store.health(T0 + 10_600).consecutiveFailures).toBe(before);
  });

  it('counts a discontinuity once per new emission across folds', () => {
    const store = seededStore();
    const flagged = wireVehicle({ key: '9201', emittedAtMs: T0 + 4_000, discontinuity: true });
    store.foldConvex({ seq: 42, atMs: T0 + 4_000, changed: [flagged], removed: undefined }, T0 + 4_100, T0 + 4_200);
    store.foldConvex({ seq: 43, atMs: T0 + 4_300, changed: [flagged], removed: undefined }, T0 + 4_400, T0 + 4_500);
    expect(store.health(T0 + 5_000).discontinuities).toBe(1);
  });
});
