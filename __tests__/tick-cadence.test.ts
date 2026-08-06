/// <reference types="jest" />
//
// Zoom-adaptive tick cadence (iteration-4 smoothness regression fix): the
// engine must tick at 30 Hz everywhere the points FC is pushed at the fast
// cadence — pushing 15 Hz points over 10 Hz motion aliased badge movement into
// visible stutter in the 14.0–14.6 window. Band changes are hysteretic so
// camera drift at the boundary can't thrash the tick timer.

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
    // Everywhere the points FC pushes at ~15 Hz the engine must be at 30 Hz:
    // two fresh physics steps per source push, without 60 whole-fleet passes.
    expect(TICK_MS).toBe(33);
    expect(pointsPushIntervalMs(DETAIL_ENTER_ZOOM)).toBe(TICK_MS * 2);
    expect(pointsPushIntervalMs(DETAIL_ENTER_ZOOM - 0.01)).toBeGreaterThanOrEqual(1000);
  });
});

// Raw-mode push gate (engine-v2.md §2.7): raw frames change only when a fix
// changes, so raw pushes ride the SAME due-check plus the runtime's ingest-set
// dirty flag — no new timer, no new cadence row semantics. Smooth/live keep
// today's interval-only behavior.
describe('pointsPushWanted (raw-mode points-push gate)', () => {
  const fastZoom = DETAIL_ENTER_ZOOM; // interval 66 ms
  const due = pointsPushIntervalMs(fastZoom);

  it('smooth/live push on the zoom-banded interval alone (dirty flag irrelevant)', () => {
    expect(pointsPushWanted('smooth', due, fastZoom, false, false)).toBe(true);
    expect(pointsPushWanted('live', due, fastZoom, false, false)).toBe(true);
    expect(pointsPushWanted('smooth', due - 1, fastZoom, true, false)).toBe(false);
    expect(pointsPushWanted('live', due - 1, fastZoom, true, false)).toBe(false);
  });

  it('raw pushes only when due AND an ingest landed since the last push', () => {
    expect(pointsPushWanted('raw', due, fastZoom, true, false)).toBe(true);
    // Identical raw frame: due but nothing changed → stay silent at 15 Hz.
    expect(pointsPushWanted('raw', due, fastZoom, false, false)).toBe(false);
    // Fresh fix but the interval hasn't elapsed → the due-check still bounds
    // the rate (the dirty flag must not be consumed on such frames).
    expect(pointsPushWanted('raw', due - 1, fastZoom, true, false)).toBe(false);
  });

  it('a position-mode switch pushes immediately in every mode (even at the 5 s city cadence)', () => {
    expect(pointsPushWanted('raw', 0, 11, false, true)).toBe(true);
    expect(pointsPushWanted('smooth', 0, 11, false, true)).toBe(true);
    expect(pointsPushWanted('live', 0, 11, false, true)).toBe(true);
  });
});
