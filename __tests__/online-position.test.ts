/// <reference types="jest" />
//
// The debug overlay's live "on-line position": the rider's filtered GPS
// projected onto the followed tram's shape = the real tram's along-shape
// position (ground truth). projectOnlineFix is the pure projection;
// OnlineLocator is the retain-counted live wrapper over an (injected) location
// watcher + GpsFilter.

import type { LocationSample, LocationWatcher } from '@/lib/motionlog';
import {
  OnlineLocator,
  projectOnlineDistAt,
  projectOnlineFix,
  type OnlineFix,
} from '@/lib/motionlog';
import { makeGeometry, metersToCoord, ORIGIN } from './helpers';

/** Straight 3 km shape running due east from the test origin. */
const GEO = makeGeometry(
  [
    [0, 0],
    [3000, 0],
  ],
  [
    { atM: 0, arrivalMs: 0 },
    { atM: 3000, arrivalMs: 600_000, isTerminal: true },
  ],
);

function fixAt(x: number, y: number, extra: Partial<OnlineFix> = {}): OnlineFix {
  const [lng, lat] = metersToCoord(ORIGIN, x, y);
  return {
    t: 1_000,
    gpsLat: lat,
    gpsLng: lng,
    accuracyM: 5,
    speedMs: 8,
    fLat: lat,
    fLng: lng,
    fSpeedMs: 8,
    rej: null,
    ...extra,
  };
}

describe('projectOnlineFix', () => {
  it('projects a raw + filtered fix onto the shape (distance + offset)', () => {
    const proj = projectOnlineFix(fixAt(500, 5), GEO);
    expect(proj).not.toBeNull();
    expect(proj!.gpsDistM).toBeCloseTo(500, 0);
    expect(proj!.gpsOffM).toBeCloseTo(5, 0);
    expect(proj!.fDistM).toBeCloseTo(500, 0);
    expect(proj!.fOffM).toBeCloseTo(5, 0);
  });

  it('leaves filtered fields null when the filter has not anchored', () => {
    const proj = projectOnlineFix(fixAt(800, 0, { fLat: null, fLng: null }), GEO);
    expect(proj!.gpsDistM).toBeCloseTo(800, 0);
    expect(proj!.fDistM).toBeNull();
    expect(proj!.fOffM).toBeNull();
  });

  it('returns null for unusable geometry', () => {
    expect(projectOnlineFix(fixAt(100, 0), undefined)).toBeNull();
    const oneVertex = { ...GEO, coordinates: [GEO.coordinates[0]], cumDistM: [0] };
    expect(projectOnlineFix(fixAt(100, 0), oneVertex)).toBeNull();
  });
});

describe('projectOnlineDistAt', () => {
  const baseFix = fixAt(500, 0, { t: 1_000, fSpeedMs: 8, speedMs: 6 });

  it('extrapolates forward at the filtered speed over elapsed time', () => {
    // 2 s after the fix at 8 m/s → +16 m.
    expect(projectOnlineDistAt(500, baseFix, 3_000)).toBeCloseTo(516, 3);
  });

  it('prefers the filtered speed but falls back to the raw device speed', () => {
    const noFilt = fixAt(500, 0, { t: 1_000, fSpeedMs: null, speedMs: 6 });
    expect(projectOnlineDistAt(500, noFilt, 2_000)).toBeCloseTo(506, 3); // 1 s · 6 m/s
  });

  it('never runs backward and clamps a stale fix to the horizon', () => {
    // now BEFORE the fix time → no negative advance.
    expect(projectOnlineDistAt(500, baseFix, 500)).toBeCloseTo(500, 3);
    // 60 s stale but clamped to the 3 s default horizon → +24 m, not +480.
    expect(projectOnlineDistAt(500, baseFix, 61_000)).toBeCloseTo(524, 3);
  });

  it('returns the base unchanged when there is no usable speed', () => {
    const noSpeed = fixAt(500, 0, { fSpeedMs: null, speedMs: null });
    expect(projectOnlineDistAt(500, noSpeed, 9_000)).toBe(500);
  });

  it('returns null when the base distance or fix is missing', () => {
    expect(projectOnlineDistAt(null, baseFix, 3_000)).toBeNull();
    expect(projectOnlineDistAt(500, null, 3_000)).toBeNull();
  });
});

/** Controllable fake LocationWatcher. */
function makeFakeWatcher() {
  let sink: ((s: LocationSample) => void) | null = null;
  let stops = 0;
  const watcher: LocationWatcher = {
    async start(onSample) {
      sink = onSample;
      return () => {
        stops += 1;
        sink = null;
      };
    },
  };
  return {
    watcher,
    emit: (s: LocationSample) => sink?.(s),
    started: () => sink !== null,
    stops: () => stops,
  };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('OnlineLocator', () => {
  it('starts on first retain, filters fixes, and stops on last release', async () => {
    const fake = makeFakeWatcher();
    const loc = new OnlineLocator({ location: fake.watcher, now: () => 0 });

    expect(loc.active()).toBe(false);
    loc.retain();
    await flush();
    expect(fake.started()).toBe(true);
    expect(loc.active()).toBe(true);

    const [lng, lat] = metersToCoord(ORIGIN, 250, 0);
    fake.emit({ t: 1_000, lat, lng, speed: 7, accuracy: 6 });
    const fix = loc.latest();
    expect(fix).not.toBeNull();
    expect(fix!.gpsLat).toBeCloseTo(lat, 6);
    // First accepted fix anchors the filter → filtered position == raw.
    expect(fix!.fLat).toBeCloseTo(lat, 6);
    expect(fix!.rej).toBeNull();

    loc.release();
    expect(loc.active()).toBe(false);
    expect(loc.latest()).toBeNull();
    expect(fake.stops()).toBe(1);
  });

  it('marks a low-accuracy fix as a filter reject (raw still recorded)', async () => {
    const fake = makeFakeWatcher();
    const loc = new OnlineLocator({ location: fake.watcher, now: () => 0 });
    loc.retain();
    await flush();

    const [lng, lat] = metersToCoord(ORIGIN, 100, 0);
    // Accuracy above the filter's gate (45 m default) → rejected 'acc'.
    fake.emit({ t: 1_000, lat, lng, speed: null, accuracy: 200 });
    const fix = loc.latest();
    expect(fix!.rej).toBe('acc');
    expect(fix!.gpsLat).toBeCloseTo(lat, 6); // raw preserved verbatim
    loc.release();
  });

  it('records a start error when the watcher rejects', async () => {
    const watcher: LocationWatcher = {
      async start() {
        throw new Error('Location permission denied');
      },
    };
    const loc = new OnlineLocator({ location: watcher, now: () => 0 });
    loc.retain();
    await flush();
    expect(loc.active()).toBe(false);
    expect(loc.error()).toMatch(/permission/i);
    loc.release();
  });
});
