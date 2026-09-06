import { sameStopOccurrence, timelineStops } from '@/components/tram/timelineStops';
import { straightGeometry } from './physicsFixtures';

const stops = straightGeometry([
  { stopId: 'previous', name: 'Previous', sequence: 1, distM: 0 },
  { stopId: 'platform', name: 'Jiráskovo náměstí', sequence: 2, distM: 1000 },
  { stopId: 'next', name: 'Národní divadlo', sequence: 3, distM: 1500 },
  { stopId: 'platform', name: 'Jiráskovo náměstí', sequence: 4, distM: 2000, isTerminal: true },
]).stops;

it('retains the actual predicted platform 3m past it and keeps the next stop/ETA', () => {
  const rows = timelineStops(stops, 1003, 'dwell');
  expect(rows.estimatedAtStop).toBe(stops[1]);
  expect(rows.upcoming).toEqual(stops.slice(1));
  expect(rows.departed).toBe(stops[0]);
  expect(rows.upcoming[rows.nextIndex]).toBe(stops[2]);
  expect(rows.etaMatchesNext).toBe(true);
  expect(sameStopOccurrence(stops[2], rows.estimatedAtStop)).toBe(false);
});

it('does not infer dwell from unchanged position when the phase is moving or unknown', () => {
  for (const phase of ['cruise', 'unknown'] as const) {
    const rows = timelineStops(stops, 1003, phase);
    expect(rows.estimatedAtStop).toBeUndefined();
    expect(rows.departed).toBe(stops[1]);
    expect(rows.upcoming[rows.nextIndex]).toBe(stops[2]);
    expect(timelineStops(stops, 1003, phase)).toEqual(rows);
  }
});

it('does not apply a stale dwell phase to a platform more than 30m away', () => {
  expect(timelineStops(stops, 1030, 'dwell').estimatedAtStop).toBe(stops[1]);
  const rows = timelineStops(stops, 1030.01, 'dwell');
  expect(rows.estimatedAtStop).toBeUndefined();
  expect(rows.upcoming[rows.nextIndex]).toBe(stops[2]);
});

it('matches repeated stop IDs by sequence and retains a nearby final platform', () => {
  const rows = timelineStops(stops, 2003, 'terminal');
  expect(rows.upcoming).toEqual([stops[3]]);
  expect(rows.nextIndex).toBe(-1);
  expect(rows.etaMatchesNext).toBe(false);
  expect(sameStopOccurrence(stops[1], rows.estimatedAtStop)).toBe(false);
  expect(sameStopOccurrence({ ...stops[3] }, rows.estimatedAtStop)).toBe(true);
});

it('does not attach the current-platform ETA to a different following stop', () => {
  const rows = timelineStops(stops, 990, 'dwell');
  expect(rows.estimatedAtStop).toBe(stops[1]);
  expect(rows.upcoming[rows.nextIndex]).toBe(stops[2]);
  expect(rows.etaMatchesNext).toBe(false);
});

it('has no predicted stop or next row after the final platform bound or without geometry', () => {
  for (const rows of [timelineStops(stops, 2031, 'terminal'), timelineStops([], 1003, 'dwell')]) {
    expect(rows.upcoming).toEqual([]);
    expect(rows.estimatedAtStop).toBeUndefined();
    expect(rows.nextIndex).toBe(-1);
    expect(rows.etaMatchesNext).toBe(false);
  }
});
