/// <reference types="jest" />
//
// Zoom-adaptive tick cadence (iteration-4 smoothness regression fix): the
// engine must tick at 60 Hz everywhere the points FC is pushed at the fast
// cadence — pushing 15 Hz points over 10 Hz motion aliased badge movement into
// visible stutter in the 14.0–14.6 window. Band changes are hysteretic so
// camera drift at the boundary can't thrash the tick timer.

import {
  DETAIL_ENTER_ZOOM,
  DETAIL_EXIT_ZOOM,
  detailModeForZoom,
  pointsPushIntervalMs,
} from '@/hooks/tramData';

describe('detailModeForZoom hysteresis', () => {
  it('enters 60 Hz at zoom ≥ 14.0 regardless of previous state', () => {
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
    // Everywhere the points FC pushes at ~15 Hz the engine must be at 60 Hz —
    // this alignment IS the fix for the 14.0–14.6 aliasing window.
    expect(pointsPushIntervalMs(DETAIL_ENTER_ZOOM)).toBeLessThanOrEqual(66);
    expect(pointsPushIntervalMs(DETAIL_ENTER_ZOOM - 0.01)).toBeGreaterThanOrEqual(1000);
  });
});
