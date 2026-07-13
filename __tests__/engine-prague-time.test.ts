/// <reference types="jest" />
//
// Prague local-time resolution in the engine (audit 2026-07-13 P2): the
// Intl-free fallback used to hardcode UTC+2, which is an hour off through the
// entire CET winter — shifting every TOD bucket and the day/night boundary.
// The fallback now shares the deterministic EU DST rule with GTFS
// (src/lib/time/prague.ts), so engine and schedule resolution always agree on
// the Prague hour: winter (CET, UTC+1), summer (CEST, UTC+2) and both sides
// of both DST transitions.

import { pragueOffsetSeconds } from '@/lib/time/prague';
import {
  pragueHour,
  pragueHourFrac,
  pragueHourMinuteFallback,
} from '@/lib/engine/speedProfile';
import { pragueOffsetSeconds as gtfsPragueOffsetSeconds } from '@/lib/golemio/gtfs';

describe('pragueHourMinuteFallback (Intl-free path)', () => {
  it('winter is CET = UTC+1 (the old fallback said UTC+2 here)', () => {
    expect(pragueHourMinuteFallback(Date.UTC(2026, 0, 15, 6, 30))).toBe(7.5);
    expect(pragueHourMinuteFallback(Date.UTC(2026, 11, 24, 17, 0))).toBe(18);
    expect(pragueHourMinuteFallback(Date.UTC(2026, 0, 15, 23, 30))).toBe(0.5); // day wrap
  });

  it('summer is CEST = UTC+2', () => {
    expect(pragueHourMinuteFallback(Date.UTC(2026, 6, 11, 6, 30))).toBe(8.5);
    expect(pragueHourMinuteFallback(Date.UTC(2026, 6, 11, 22, 15))).toBe(0.25); // day wrap
  });

  it('handles both sides of the spring-forward transition (2026-03-29 01:00 UTC)', () => {
    expect(pragueHourMinuteFallback(Date.parse('2026-03-29T00:30:00Z'))).toBe(1.5); // CET
    expect(pragueHourMinuteFallback(Date.parse('2026-03-29T01:30:00Z'))).toBe(3.5); // CEST (02:xx skipped)
  });

  it('handles both sides of the fall-back transition (2026-10-25 01:00 UTC)', () => {
    expect(pragueHourMinuteFallback(Date.parse('2026-10-25T00:30:00Z'))).toBe(2.5); // CEST
    expect(pragueHourMinuteFallback(Date.parse('2026-10-25T01:30:00Z'))).toBe(2.5); // CET (02:xx repeats)
  });

  it('agrees with the Intl path (pragueHourFrac) across seasons and transitions', () => {
    const samples = [
      Date.UTC(2026, 0, 15, 6, 30), // deep winter
      Date.UTC(2026, 6, 11, 12, 0), // deep summer
      Date.parse('2026-03-29T00:30:00Z'),
      Date.parse('2026-03-29T01:30:00Z'),
      Date.parse('2026-10-25T00:30:00Z'),
      Date.parse('2026-10-25T01:30:00Z'),
      Date.UTC(2027, 1, 1, 0, 0),
    ];
    for (const ms of samples) {
      // pragueHourFrac adds sub-minute seconds on top of the minute value; on
      // exact minutes the two must match exactly (Node's Jest has full ICU).
      expect(pragueHourFrac(ms)).toBe(pragueHourMinuteFallback(ms));
    }
  });

  it('drives pragueHour (engine daytime rule) to the right winter hour', () => {
    // 06:30 UTC in January = 07:30 Prague — daytime under the 07–19 rule.
    // The old +2 fallback would have claimed 08:30 all winter (and 06:30 UTC
    // in late evening cases crossed the day boundary an hour early).
    expect(pragueHour(Date.UTC(2026, 0, 15, 6, 30))).toBe(7);
    expect(pragueHour(Date.UTC(2026, 0, 15, 18, 30))).toBe(19);
  });
});

describe('shared Prague offset module', () => {
  it('gtfs re-exports the exact same resolver the engine fallback uses', () => {
    expect(gtfsPragueOffsetSeconds).toBe(pragueOffsetSeconds);
  });

  it('offsets: CET 3600 s in winter, CEST 7200 s in summer, EU-rule boundaries', () => {
    expect(pragueOffsetSeconds(Date.UTC(2026, 0, 15, 12, 0))).toBe(3600);
    expect(pragueOffsetSeconds(Date.UTC(2026, 6, 11, 12, 0))).toBe(7200);
    expect(pragueOffsetSeconds(Date.parse('2026-03-29T00:59:59Z'))).toBe(3600);
    expect(pragueOffsetSeconds(Date.parse('2026-03-29T01:00:00Z'))).toBe(7200);
    expect(pragueOffsetSeconds(Date.parse('2026-10-25T00:59:59Z'))).toBe(7200);
    expect(pragueOffsetSeconds(Date.parse('2026-10-25T01:00:00Z'))).toBe(3600);
  });
});

describe('pragueHourFrac uses the corrected fallback when Intl is unavailable', () => {
  it('winter fallback through the real pragueHourFrac path (Intl mocked away)', () => {
    const original = Intl.DateTimeFormat;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Intl as any).DateTimeFormat = function () {
      throw new Error('no ICU');
    };
    try {
      jest.isolateModules(() => {
        // Fresh module registry: the formatter cache is re-evaluated lazily
        // and the constructor throw routes every call through the fallback.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const sp = require('@/lib/engine/speedProfile') as typeof import('@/lib/engine/speedProfile');
        expect(sp.pragueHourFrac(Date.UTC(2026, 0, 15, 6, 30))).toBe(7.5); // CET, not 8.5
        expect(sp.pragueHourFrac(Date.UTC(2026, 6, 11, 6, 30))).toBe(8.5); // CEST
        expect(sp.pragueHour(Date.parse('2026-03-29T01:30:00Z'))).toBe(3);
        expect(sp.pragueHour(Date.parse('2026-10-25T01:30:00Z'))).toBe(2);
      });
    } finally {
      (Intl as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat = original;
    }
  });
});
