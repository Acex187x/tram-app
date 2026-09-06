/// <reference types="jest" />
//
// Zoom-adaptive frame cadence (iteration-4 smoothness regression fix): the
// frame loop must run at 30 Hz everywhere the points FC is pushed at the fast
// cadence — pushing 15 Hz points over 10 Hz motion aliased badge movement into
// visible stutter in the 14.0–14.6 window. Band changes are hysteretic so
// camera drift at the boundary can't thrash the timer.
//
// Physics v3 note: the loop no longer ticks a simulation (there isn't one —
// positions are evaluated from the server's curves at push time), but the
// cadence ALIGNMENT invariant is unchanged and still load-bearing.

import {
  DETAIL_ENTER_ZOOM,
  DETAIL_EXIT_ZOOM,
  TICK_MS,
  detailModeForZoom,
  pointsPushIntervalMs,
  pointsPushWanted,
} from '@/hooks/tramData';

describe('detailModeForZoom hysteresis', () => {
  it('enters 30 Hz at zoom ≥ 14.0 regardless of previous state', () => {
    expect(detailModeForZoom(14.0, false)).toBe(true);
    expect(detailModeForZoom(14.0, true)).toBe(true);
    expect(detailModeForZoom(16.8, false)).toBe(true);
  });

  it('drops to 10 Hz only below 13.7', () => {
    expect(detailModeForZoom(13.69, true)).toBe(false);
    expect(detailModeForZoom(12.0, true)).toBe(false);
    expect(detailModeForZoom(13.7, true)).toBe(true); // hold inside the band
    expect(detailModeForZoom(13.9, true)).toBe(true);
  });

  it('stays idle below the enter threshold when already idle', () => {
    expect(detailModeForZoom(13.9, false)).toBe(false);
    expect(detailModeForZoom(13.7, false)).toBe(false);
    expect(detailModeForZoom(12.0, false)).toBe(false);
  });

  it('band constants are ordered and aligned with the fast points cadence', () => {
    expect(DETAIL_EXIT_ZOOM).toBeLessThan(DETAIL_ENTER_ZOOM);
    // Everywhere the points FC pushes at ~15 Hz the frame loop must run at
    // 30 Hz — perf invariant #4: the two thresholds are one constant.
    expect(TICK_MS).toBe(33);
    expect(pointsPushIntervalMs(DETAIL_ENTER_ZOOM)).toBe(TICK_MS * 2);
    expect(pointsPushIntervalMs(DETAIL_ENTER_ZOOM - 0.01)).toBe(200);
  });
});

// Points-push gate. Physics v3 deleted the raw-mode dirty-flag special case:
// BOTH published curves move continuously between bundles, so every frame
// genuinely differs and the zoom-banded interval is the whole rule. Forced
// pushes still bypass it (render-mode switch, selection/follow change), which
// also applies during presentation transitions.
describe('pointsPushWanted', () => {
  const fastZoom = DETAIL_ENTER_ZOOM; // interval 66 ms
  const due = pointsPushIntervalMs(fastZoom);

  it('pushes exactly when the zoom-banded interval has elapsed', () => {
    expect(pointsPushWanted(due, fastZoom, false)).toBe(true);
    expect(pointsPushWanted(due + 5, fastZoom, false)).toBe(true);
    expect(pointsPushWanted(due - 1, fastZoom, false)).toBe(false);
  });

  it('uses whole idle ticks for city and badge movement at their exact boundary', () => {
    for (const [zoom, interval] of [[9,400], [12.499,400], [12.5,200], [13.99,200]]) {
      expect(pointsPushWanted(interval - 1, zoom, false)).toBe(false);
      expect(pointsPushWanted(interval, zoom, false)).toBe(true);
      expect(pointsPushIntervalMs(zoom)).toBe(interval);
      expect(interval % 100).toBe(0);
    }
  });
  it('keeps selected/followed coarse targets at10 Hz without changing detail', () => {
    for (const zoom of [9, 12.5, 13.99]) {
      expect(pointsPushWanted(99, zoom, false, true)).toBe(false);
      expect(pointsPushWanted(100, zoom, false, true)).toBe(true);
    }
    expect(pointsPushIntervalMs(14, true)).toBe(66);
  });

  it('a forced push bypasses the interval at every zoom', () => {
    expect(pointsPushWanted(0, 11, true)).toBe(true);
    expect(pointsPushWanted(0, fastZoom, true)).toBe(true);
  });
});
