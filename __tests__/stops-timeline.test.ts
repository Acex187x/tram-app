/// <reference types="jest" />

// Regression tests for the timetable clock formatting used by StopsTimeline:
// epochs are Prague wall-clock instants and must render in Europe/Prague
// regardless of the device timezone (codex-review-1 finding #12 / UI-2).

import { formatPragueClock as fmtClock } from '@/lib/format/pragueTime';

describe('formatPragueClock — Europe/Prague wall time', () => {
  it('renders summer instants in CEST (UTC+2)', () => {
    // 2026-07-11 12:00Z → 14:00 Prague.
    expect(fmtClock(Date.UTC(2026, 6, 11, 12, 0))).toBe('14:00');
  });

  it('renders winter instants in CET (UTC+1)', () => {
    // 2026-01-15 12:00Z → 13:00 Prague.
    expect(fmtClock(Date.UTC(2026, 0, 15, 12, 0))).toBe('13:00');
  });

  it('rolls past midnight into the next Prague day', () => {
    // 2026-07-11 22:30Z → 00:30 Prague (next calendar day).
    expect(fmtClock(Date.UTC(2026, 6, 11, 22, 30))).toBe('00:30');
  });

  it('does NOT use the device-local hours (would be 12:00 on a UTC device)', () => {
    // Guards against the previous Date#getHours() implementation.
    const out = fmtClock(Date.UTC(2026, 6, 11, 12, 0));
    expect(out).not.toBe('12:00');
  });
});
