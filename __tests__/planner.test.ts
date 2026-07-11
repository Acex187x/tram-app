import { describe, expect, it } from '@jest/globals';

import { planItineraries, searchStops } from '@/lib/planner/planner';
import {
  buildNetwork,
  normalizeName,
  sliceCoordinates,
  type LineSequence,
} from '@/lib/planner/network';
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

describe('buildNetwork dedupe (PLN-1)', () => {
  it('collapses many identical trips into ONE sequence per line+direction', () => {
    // The geometry cache is keyed by tripId, so dozens of vehicles contribute
    // the same ordered station list for a line. They must not multiply.
    const dupes: RouteGeometry[] = [];
    for (let n = 0; n < 12; n++) {
      dupes.push(
        makeGeo('A', `dupA${n}`, [
          ['Alpha', 0],
          ['Beta', 400],
          ['Cross', 900],
          ['Delta', 1500],
        ]),
      );
    }
    // Plus one genuinely different direction for the same line.
    dupes.push(
      makeGeo('A', 'revA', [
        ['Delta', 0],
        ['Cross', 600],
        ['Beta', 1100],
        ['Alpha', 1500],
      ]),
    );
    const net = buildNetwork(dupes);
    expect(net.sequencesByLine.get('A')?.length).toBe(2); // one per direction
    expect(net.sequences.length).toBe(2);
    // Every duplicate still registered the stations/lines.
    expect(net.stations.get(normalizeName('Cross'))?.lines.has('A')).toBe(true);
  });
});

describe('planItineraries two-transfer completeness (PLN-1)', () => {
  // P —L1— Q —L1— R ; R —L2— S —L2— T ; T —L3— U —L3— V
  // R transfers L1↔L2, T transfers L2↔L3. P→V needs exactly two transfers.
  function twoTransferGeos(): RouteGeometry[] {
    return [
      makeGeo('L1', 't1', [
        ['P', 0],
        ['Q', 300],
        ['R', 700],
      ]),
      makeGeo('L2', 't2', [
        ['R', 0],
        ['S', 300],
        ['T', 700],
      ]),
      makeGeo('L3', 't3', [
        ['T', 0],
        ['U', 300],
        ['V', 700],
      ]),
    ];
  }

  it('finds the 2-transfer route regardless of insertion order', () => {
    const base = twoTransferGeos();
    // Try several permutations (including duplicate-heavy ones) — the result
    // must not depend on cache insertion order.
    const orders: RouteGeometry[][] = [
      base,
      [base[2], base[1], base[0]],
      [base[1], base[2], base[0]],
      // Bloat with duplicate first legs that previously exhausted the budget.
      [
        ...Array.from({ length: 20 }, (_, n) =>
          makeGeo('L1', `dup${n}`, [
            ['P', 0],
            ['Q', 300],
            ['R', 700],
          ]),
        ),
        base[1],
        base[2],
      ],
    ];
    for (const geos of orders) {
      const its = planItineraries('P', 'V', geos);
      expect(its.length).toBeGreaterThanOrEqual(1);
      const best = its[0];
      expect(best.transferCount).toBe(2);
      expect(best.legs.map((l) => l.line)).toEqual(['L1', 'L2', 'L3']);
      expect(best.legs[0].fromStopName).toBe('P');
      expect(best.legs[2].toStopName).toBe('V');
    }
  });
});

describe('sliceCoordinates endpoints (PLN-2)', () => {
  it('includes interpolated endpoints even when both stops share one segment', () => {
    // One long segment [0m .. 1000m]; two stops fall strictly inside it, so
    // there is no interior shape vertex to draw.
    const seq: LineSequence = {
      line: 'X',
      tripId: 'tx',
      stops: [],
      coordinates: [
        [14.4, 50.05],
        [14.42, 50.05],
      ],
      cumDistM: [0, 1000],
    };
    const slice = sliceCoordinates(seq, 200, 800);
    expect(slice.length).toBeGreaterThanOrEqual(2);
    // Endpoints are interpolated at the exact from/to distances (t = 0.2, 0.8).
    expect(slice[0][0]).toBeCloseTo(14.404, 6);
    expect(slice[slice.length - 1][0]).toBeCloseTo(14.416, 6);
  });

  it('keeps interior vertices between the interpolated endpoints', () => {
    const seq: LineSequence = {
      line: 'Y',
      tripId: 'ty',
      stops: [],
      coordinates: [
        [14.4, 50.05],
        [14.41, 50.05],
        [14.42, 50.05],
        [14.43, 50.05],
      ],
      cumDistM: [0, 500, 1000, 1500],
    };
    const slice = sliceCoordinates(seq, 250, 1250);
    // interpolated start (250) + vertices at 500 and 1000 + interpolated end (1250)
    expect(slice.length).toBe(4);
    expect(slice[0][0]).toBeCloseTo(14.405, 6);
    expect(slice[1][0]).toBeCloseTo(14.41, 6);
    expect(slice[2][0]).toBeCloseTo(14.42, 6);
    expect(slice[3][0]).toBeCloseTo(14.425, 6);
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
