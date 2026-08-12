/// <reference types="jest" />
//
// Experimental 'ml' position mode: the research lab publishes absolute-time
// keyframes (t, s-along-shape) per vehicle and the app dumb-lerps between
// them — no smoothing, no physics, no fades. What must hold is exactly the
// read: linear between bracketing keyframes, clamped at both ends, and a hard
// null (→ raw-fix fallback in the renderer) for an unknown key or a trip that
// changed since the trajectory was computed.

import { MlTrajectoryStore } from '@/lib/feed/mlTrajectories';

const T0 = 1_800_000_000_000;

/** One vehicle, 3 keyframes 10 s apart: 100 m → 200 m → 260 m. */
function payload() {
  return {
    atMs: T0,
    stepS: 10,
    horizonS: 20,
    vehicles: [
      {
        key: '9251',
        tripId: 'trip-a',
        line: '22',
        anchorMs: T0 - 5_000,
        points: [
          { t: T0, s: 100 },
          { t: T0 + 10_000, s: 200 },
          { t: T0 + 20_000, s: 260 },
        ],
      },
    ],
  };
}

function loaded(): MlTrajectoryStore {
  const store = new MlTrajectoryStore();
  store.ingest(payload());
  return store;
}

describe('MlTrajectoryStore.evalDistM', () => {
  it('returns the keyframe value exactly at a keyframe', () => {
    const store = loaded();
    expect(store.evalDistM('9251', 'trip-a', T0)).toBe(100);
    expect(store.evalDistM('9251', 'trip-a', T0 + 10_000)).toBe(200);
    expect(store.evalDistM('9251', 'trip-a', T0 + 20_000)).toBe(260);
  });

  it('interpolates linearly between bracketing keyframes', () => {
    const store = loaded();
    // Halfway through the first 10 s span: 100 → 200 m.
    expect(store.evalDistM('9251', 'trip-a', T0 + 5_000)).toBeCloseTo(150, 6);
    // A quarter into the SECOND span, whose slope differs (200 → 260 m):
    // proof the read is piecewise, not one straight line end-to-end.
    expect(store.evalDistM('9251', 'trip-a', T0 + 12_500)).toBeCloseTo(215, 6);
  });

  it('clamps to the first/last point outside the published range', () => {
    const store = loaded();
    expect(store.evalDistM('9251', 'trip-a', T0 - 60_000)).toBe(100);
    expect(store.evalDistM('9251', 'trip-a', T0 + 600_000)).toBe(260);
  });

  it('returns null for an unknown key or a changed trip (raw-fix fallback)', () => {
    const store = loaded();
    expect(store.evalDistM('9999', 'trip-a', T0 + 5_000)).toBeNull();
    // The vehicle turned at a terminal: keyframes computed for the old trip
    // must never be replayed onto the new shape.
    expect(store.evalDistM('9251', 'trip-b', T0 + 5_000)).toBeNull();
  });

  it('ingest replaces the set; a malformed payload leaves it untouched', () => {
    const store = loaded();
    expect(store.size).toBe(1);

    store.ingest({ vehicles: 'nope' });
    expect(store.evalDistM('9251', 'trip-a', T0)).toBe(100);

    // Vehicles missing a key/tripId, or with no usable points, are dropped —
    // never rendered as a tram sitting at distance 0.
    store.ingest({
      vehicles: [
        { key: '9251', points: [{ t: T0, s: 10 }] },
        { key: '9301', tripId: 'trip-c', points: [{ t: T0, s: 'x' }] },
        { key: '9302', tripId: 'trip-d', points: [{ t: T0, s: 42 }] },
      ],
    });
    expect(store.size).toBe(1);
    expect(store.evalDistM('9251', 'trip-a', T0)).toBeNull();
    expect(store.evalDistM('9301', 'trip-c', T0)).toBeNull();
    expect(store.evalDistM('9302', 'trip-d', T0)).toBe(42);
  });
});
