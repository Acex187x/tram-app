/// <reference types="jest" />
//
// Prague local-time resolution (audit 2026-07-13 P2). The original bug: an
// Intl-free fallback hardcoded UTC+2, which is an hour off through the entire
// CET winter, shifting the day/night boundary and every schedule anchor.
//
// The engine that owned that fallback is gone (physics v3 moved time-of-day
// modelling to the server), but the invariant it protected is not: the ONE
// deterministic EU DST rule in `src/lib/time/prague.ts` must be the single
// resolver everything Prague-local shares — today the GTFS service-day
// resolution, tomorrow whatever else needs a Prague hour. A second, drifting
// copy of this rule is the failure this file exists to prevent.

import { pragueOffsetSeconds } from '@/lib/time/prague';
import { pragueOffsetSeconds as gtfsPragueOffsetSeconds } from '@/lib/golemio/gtfs';

/** Prague-local hour-of-day from the shared offset (what callers derive). */
function pragueHourFrac(utcMs: number): number {
  const local = new Date(utcMs + pragueOffsetSeconds(utcMs) * 1000);
  return local.getUTCHours() + local.getUTCMinutes() / 60;
}

describe('shared Prague offset module', () => {
  it('gtfs re-exports the exact same resolver — never a second copy', () => {
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

  it('is stable across years (the rule is computed, not tabulated)', () => {
    expect(pragueOffsetSeconds(Date.parse('2027-03-28T01:00:00Z'))).toBe(7200);
    expect(pragueOffsetSeconds(Date.parse('2027-03-28T00:59:59Z'))).toBe(3600);
    expect(pragueOffsetSeconds(Date.parse('2027-10-31T01:00:00Z'))).toBe(3600);
  });
});

describe('Prague hour derived from the shared offset', () => {
  it('winter is CET = UTC+1 (the old fallback said UTC+2 here)', () => {
    expect(pragueHourFrac(Date.UTC(2026, 0, 15, 6, 30))).toBe(7.5);
    expect(pragueHourFrac(Date.UTC(2026, 11, 24, 17, 0))).toBe(18);
  });

  it('summer is CEST = UTC+2', () => {
    expect(pragueHourFrac(Date.UTC(2026, 6, 11, 6, 30))).toBe(8.5);
  });

  it('handles both sides of the spring-forward transition (2026-03-29 01:00 UTC)', () => {
    expect(pragueHourFrac(Date.parse('2026-03-29T00:30:00Z'))).toBe(1.5); // CET
    expect(pragueHourFrac(Date.parse('2026-03-29T01:30:00Z'))).toBe(3.5); // CEST (02:xx skipped)
  });

  it('handles both sides of the fall-back transition (2026-10-25 01:00 UTC)', () => {
    expect(pragueHourFrac(Date.parse('2026-10-25T00:30:00Z'))).toBe(2.5); // CEST
    expect(pragueHourFrac(Date.parse('2026-10-25T01:30:00Z'))).toBe(2.5); // CET (02:xx repeats)
  });

  it('agrees with the ICU path across seasons and transitions', () => {
    const samples = [
      Date.UTC(2026, 0, 15, 6, 30),
      Date.UTC(2026, 6, 11, 12, 0),
      Date.parse('2026-03-29T00:30:00Z'),
      Date.parse('2026-03-29T01:30:00Z'),
      Date.parse('2026-10-25T00:30:00Z'),
      Date.parse('2026-10-25T01:30:00Z'),
      Date.UTC(2027, 1, 1, 0, 0),
    ];
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Prague',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    for (const ms of samples) {
      const [h, m] = fmt.format(new Date(ms)).split(':').map(Number);
      expect(pragueHourFrac(ms)).toBe((h % 24) + m / 60);
    }
  });
});
