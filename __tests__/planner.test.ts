import { describe, expect, it } from '@jest/globals';

import { planItineraries, searchStops } from '@/lib/planner/planner';
import { buildNetwork, normalizeName } from '@/lib/planner/network';
import type { RouteGeometry, RouteStop } from '@/lib/types';

let stopCounter = 0;

function makeGeo(
  line: string,
  tripId: string,
  stopSpecs: [name: string, distM: number][],
): RouteGeometry {
  const coordinates: [number, number][] = [];
  const cumDistM: number[] = [];
  const stops: RouteStop[] = stopSpecs.map(([name, distM], idx) => {
    const lng = 14.4 + distM / 100000;
    const coord: [number, number] = [lng, 50.05];
    coordinates.push(coord);
    cumDistM.push(distM);
    return {
      stopId: `S${stopCounter++}`,
      name,
      sequence: idx + 1,
      coordinates: coord,
      distM,
      arrivalMs: 0,
      departureMs: 0,
      dwellSeconds: 0,
      isTerminal: idx === stopSpecs.length - 1,
    };
  });
  return {
    shapeId: `${line}V1`,
    tripId,
    routeId: `L${line}`,
    line,
    headsign: stopSpecs[stopSpecs.length - 1][0],
    coordinates,
    cumDistM,
    totalM: cumDistM[cumDistM.length - 1],
    stops,
  };
}

// Network:
//   Line A: Alpha — Beta — Cross — Delta
//   Line B: Echo — Cross — Foxtrot          (Cross transfers A↔B)
//   Line C: Delta — Gamma — Hotel           (Delta transfers A↔C)
//   Line 9: Alpha — Nádraží Holešovice      (for diacritics search)
const geometries: RouteGeometry[] = [
  makeGeo('A', 'tA', [
    ['Alpha', 0],
    ['Beta', 400],
    ['Cross', 900],
    ['Delta', 1500],
  ]),
  makeGeo('B', 'tB', [
    ['Echo', 0],
    ['Cross', 500],
    ['Foxtrot', 1100],
  ]),
  makeGeo('C', 'tC', [
    ['Delta', 0],
    ['Gamma', 600],
    ['Hotel', 1200],
  ]),
  makeGeo('9', 't9', [
    ['Alpha', 0],
    ['Nádraží Holešovice', 800],
  ]),
];

describe('buildNetwork', () => {
  const net = buildNetwork(geometries);

  it('groups stops by name into stations', () => {
    expect(net.stations.has(normalizeName('Cross'))).toBe(true);
    const cross = net.stations.get(normalizeName('Cross'))!;
    expect(cross.lines.has('A')).toBe(true);
    expect(cross.lines.has('B')).toBe(true);
  });

  it('records sequences per line', () => {
    expect(net.sequencesByLine.get('A')?.length).toBe(1);
  });
});

describe('planItineraries', () => {
  it('finds a direct ride on a single line', () => {
    const its = planItineraries('Alpha', 'Delta', geometries);
    expect(its.length).toBeGreaterThanOrEqual(1);
    const direct = its[0];
    expect(direct.transferCount).toBe(0);
    expect(direct.legs).toHaveLength(1);
    expect(direct.legs[0].line).toBe('A');
    expect(direct.legs[0].fromStopName).toBe('Alpha');
    expect(direct.legs[0].toStopName).toBe('Delta');
    expect(direct.legs[0].stopCount).toBe(3);
    expect(direct.legs[0].coordinates.length).toBeGreaterThan(0);
  });

  it('finds a one-transfer ride across two lines', () => {
    const its = planItineraries('Alpha', 'Foxtrot', geometries);
    expect(its.length).toBeGreaterThanOrEqual(1);
    const best = its[0];
    expect(best.transferCount).toBe(1);
    expect(best.legs.map((l) => l.line)).toEqual(['A', 'B']);
    expect(best.legs[0].toStopName).toBe('Cross');
    expect(best.legs[1].fromStopName).toBe('Cross');
    expect(best.legs[1].toStopName).toBe('Foxtrot');
  });

  it('finds a transfer via the other shared station', () => {
    const its = planItineraries('Alpha', 'Hotel', geometries);
    expect(its.length).toBeGreaterThanOrEqual(1);
    const best = its[0];
    expect(best.transferCount).toBe(1);
    expect(best.legs.map((l) => l.line)).toEqual(['A', 'C']);
    expect(best.totalStops).toBe(best.legs.reduce((s, l) => s + l.stopCount, 0));
  });

  it('is diacritics-insensitive for endpoint names', () => {
    const its = planItineraries('alpha', 'nadrazi holesovice', geometries);
    expect(its.length).toBeGreaterThanOrEqual(1);
    expect(its[0].legs[0].line).toBe('9');
  });

  it('returns nothing for unknown or identical endpoints', () => {
    expect(planItineraries('Alpha', 'Alpha', geometries)).toEqual([]);
    expect(planItineraries('Nowhere', 'Delta', geometries)).toEqual([]);
  });
});

describe('searchStops', () => {
  it('matches case- and diacritics-insensitively', () => {
    expect(searchStops('cro', geometries)).toContain('Cross');
    expect(searchStops('nadr', geometries)).toContain('Nádraží Holešovice');
    expect(searchStops('HOLESOVICE', geometries)).toContain(
      'Nádraží Holešovice',
    );
  });

  it('returns [] for empty query', () => {
    expect(searchStops('', geometries)).toEqual([]);
  });
});
