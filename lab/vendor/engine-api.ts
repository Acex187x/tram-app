// The slice of build 12's TramEngine the lab actually consumes.
//
// Why the lab declares this instead of importing the app's types: the engine
// under ./engine is FROZEN at the shipped build, while src/lib/types.ts keeps
// evolving with the app (physics-v3 already removed `projectedObservedDistM`
// and `SimDebugInfo` from TramPublicState). Borrowing a moving type to
// describe a frozen artifact makes the lab fail to build for reasons that have
// nothing to do with the lab. This interface is that contract, written down.
//
// TramSnapshot / RouteGeometry stay imported from the app on purpose: they are
// the FEED contract, shared with the backend, and the lab must track them.

import type { RouteGeometry, TramSnapshot } from '@/lib/types';

/** Fleet model spec — whatever the app's registry currently returns. */
type ModelSpec = ReturnType<typeof import('@/lib/fleet/registry').getModelSpec>;

export interface FrozenTramState {
  key: string;
  snapshot: TramSnapshot;
  /** Cinematic smoother position (the `engine-smooth` variant). */
  simDistM: number;
  position: [number, number];
  /** Raw AVL fix, snapped on-shape when geometry is known. */
  observedPosition: [number, number];
  /** Fix dead-reckoned to `now` by the physics engine (`engine-live`). */
  projectedObservedDistM: number | null;
  hasGeometry: boolean;
}

export interface FrozenTramEngine {
  ingest(
    snapshots: TramSnapshot[],
    resolveGeometry: (tripId: string) => RouteGeometry | undefined,
    nowMs: number,
  ): void;
  tick(nowMs: number): void;
  setProjectionCadence(cadence: 'full' | 'coarse'): void;
  getState(key: string, nowMs?: number): FrozenTramState | undefined;
  getStates(nowMs?: number): FrozenTramState[];
}

export interface FrozenTramEngineCtor {
  new (opts: { resolveModel: (snapshot: TramSnapshot) => ModelSpec }): FrozenTramEngine;
}
