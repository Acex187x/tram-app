// Pure tests for the search sheet's fleet-browser helpers
// (src/components/search/fleetFilter.ts): facets, filter combination
// (AND across groups, OR within), sort order, and the row display selectors.
import { describe, expect, it } from '@jest/globals';

import {
  compareLines,
  EMPTY_FLEET_FILTERS,
  filterFleet,
  fleetRowData,
  formatShortDuration,
  hasActiveFilters,
  lineFacets,
  liveStatusText,
  MODEL_ORDER,
  MODEL_SHORT_NAMES,
  modelFacets,
  stopNameAt,
  toggleFilterValue,
} from '@/components/search/fleetFilter';
import type { TramModelId, TramPublicState } from '@/lib/types';

/** Minimal TramPublicState carrying only the fields the helpers touch. */
function tram(over: {
  key: string;
  line: string;
  modelId: TramModelId;
  isCanceled?: boolean;
  phase?: TramPublicState['phase'];
  simDistM?: number;
  simSpeedKmh?: number;
  hasGeometry?: boolean;
  nextStopName?: string | null;
  nextStopEtaS?: number | null;
  headsign?: string;
  delaySeconds?: number;
  airConditioned?: boolean | null;
  observedAtMs?: number;
  tripId?: string;
}): TramPublicState {
  return {
    key: over.key,
    snapshot: {
      line: over.line,
      isCanceled: over.isCanceled ?? false,
      headsign: over.headsign ?? 'Somewhere',
      delaySeconds: over.delaySeconds ?? 0,
      airConditioned: over.airConditioned ?? null,
      observedAtMs: over.observedAtMs ?? 0,
      tripId: over.tripId ?? 'trip-1',
    },
    model: { id: over.modelId },
    phase: over.phase ?? 'cruise',
    simDistM: over.simDistM ?? 0,
    simSpeedKmh: over.simSpeedKmh ?? 0,
    hasGeometry: over.hasGeometry ?? true,
    nextStopName: over.nextStopName ?? null,
    nextStopEtaS: over.nextStopEtaS ?? null,
  } as TramPublicState;
}

describe('toggleFilterValue', () => {
  it('appends a missing value and removes a present one', () => {
    expect(toggleFilterValue(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleFilterValue(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggleFilterValue([], 'x')).toEqual(['x']);
  });
});

describe('hasActiveFilters', () => {
  it('is false only when both groups are empty', () => {
    expect(hasActiveFilters(EMPTY_FLEET_FILTERS)).toBe(false);
    expect(hasActiveFilters({ models: ['15t'], lines: [] })).toBe(true);
    expect(hasActiveFilters({ models: [], lines: ['22'] })).toBe(true);
  });
});

describe('modelFacets', () => {
  it('counts models present in live data, in canonical fleet order', () => {
    const states = [
      tram({ key: '9265', line: '22', modelId: '15t' }),
      tram({ key: '9301', line: '9', modelId: '15t' }),
      tram({ key: '8300', line: '22', modelId: 't3rp' }),
      tram({ key: '9520', line: '17', modelId: '52t' }),
    ];
    expect(modelFacets(states)).toEqual([
      { id: 't3rp', count: 1 },
      { id: '15t', count: 2 },
      { id: '52t', count: 1 },
    ]);
  });

  it('short names cover every model id in canonical order', () => {
    for (const id of MODEL_ORDER) expect(MODEL_SHORT_NAMES[id]).toBeTruthy();
    expect(MODEL_SHORT_NAMES['15t']).toBe('15T');
    expect(MODEL_SHORT_NAMES.t3rplf).toBe('T3R.PLF');
  });
});

describe('lineFacets / compareLines', () => {
  it('sorts lines numerically, deduplicated', () => {
    const states = ['22', '3', '91', '9', '22'].map((line, i) =>
      tram({ key: `900${i}`, line, modelId: '15t' }),
    );
    expect(lineFacets(states)).toEqual(['3', '9', '22', '91']);
  });

  it('falls back to locale order for non-numeric lines', () => {
    expect(compareLines('X1', 'X2')).toBeLessThan(0);
  });
});

describe('filterFleet', () => {
  const states = [
    tram({ key: '9265', line: '22', modelId: '15t' }),
    tram({ key: '9051', line: '9', modelId: 'kt8d5' }),
    tram({ key: '8300', line: '22', modelId: 't3rp' }),
    tram({ key: '9128', line: '17', modelId: '14t' }),
    tram({ key: '9201', line: '22', modelId: '15t' }),
    tram({ key: '9999', line: '22', modelId: '15t', isCanceled: true }),
  ];

  it('no filters → all live trams sorted by line then registration', () => {
    expect(filterFleet(states, EMPTY_FLEET_FILTERS).map((s) => s.key)).toEqual([
      '9051', // line 9
      '9128', // line 17
      '8300', // line 22, reg order
      '9201',
      '9265',
    ]);
  });

  it('excludes canceled trips', () => {
    const keys = filterFleet(states, EMPTY_FLEET_FILTERS).map((s) => s.key);
    expect(keys).not.toContain('9999');
  });

  it('ORs within a group: two models', () => {
    expect(
      filterFleet(states, { models: ['kt8d5', '14t'], lines: [] }).map((s) => s.key),
    ).toEqual(['9051', '9128']);
  });

  it('ANDs across groups: model ∧ line', () => {
    expect(filterFleet(states, { models: ['15t'], lines: ['22'] }).map((s) => s.key)).toEqual([
      '9201',
      '9265',
    ]);
    expect(filterFleet(states, { models: ['14t'], lines: ['22'] })).toEqual([]);
  });

  it('line-only filter ORs lines', () => {
    expect(filterFleet(states, { models: [], lines: ['9', '17'] }).map((s) => s.key)).toEqual([
      '9051',
      '9128',
    ]);
  });
});

describe('formatShortDuration', () => {
  it('seconds under 100, minutes beyond, clamped at 0', () => {
    expect(formatShortDuration(12)).toBe('12 s');
    expect(formatShortDuration(99.4)).toBe('99 s');
    expect(formatShortDuration(150)).toBe('3 min');
    expect(formatShortDuration(-5)).toBe('0 s');
  });
});

describe('stopNameAt', () => {
  const stops = [
    { distM: 0, name: 'Depot' },
    { distM: 500, name: 'Muzeum' },
    { distM: 1200, name: 'Malostranská' },
  ];

  it('returns the stop the sim is standing at (within tolerance)', () => {
    expect(stopNameAt(500, stops)).toBe('Muzeum');
    expect(stopNameAt(495, stops)).toBe('Muzeum'); // stop slightly ahead, within 30 m
    expect(stopNameAt(1300, stops)).toBe('Malostranská'); // past the last stop
  });

  it('returns null before the first stop or without stops', () => {
    expect(stopNameAt(-50, stops)).toBeNull();
    expect(stopNameAt(100, [])).toBeNull();
  });
});

describe('liveStatusText', () => {
  it('covers all phases', () => {
    expect(
      liveStatusText({ phase: 'dwell', nextStopName: 'Next', nextStopEtaS: 30, atStopName: 'Muzeum' }),
    ).toBe('At Muzeum');
    expect(liveStatusText({ phase: 'dwell', nextStopName: null, nextStopEtaS: null })).toBe(
      'At stop',
    );
    expect(
      liveStatusText({ phase: 'cruise', nextStopName: 'Malostranská', nextStopEtaS: 42.4 }),
    ).toBe('→ Malostranská · 42 s');
    expect(liveStatusText({ phase: 'cruise', nextStopName: 'Muzeum', nextStopEtaS: null })).toBe(
      '→ Muzeum',
    );
    expect(liveStatusText({ phase: 'cruise', nextStopName: null, nextStopEtaS: null })).toBe(
      'Cruising',
    );
    expect(liveStatusText({ phase: 'terminal', nextStopName: null, nextStopEtaS: null })).toBe(
      'At terminus',
    );
    expect(liveStatusText({ phase: 'unknown', nextStopName: null, nextStopEtaS: null })).toBe(
      'Tracking',
    );
  });
});

describe('fleetRowData', () => {
  it('reduces a state to primitive display fields', () => {
    const state = tram({
      key: '9265',
      line: '22',
      modelId: '15t',
      phase: 'cruise',
      simSpeedKmh: 41.7,
      nextStopName: 'Muzeum',
      nextStopEtaS: 25,
      headsign: 'Bílá Hora',
      delaySeconds: 90,
      airConditioned: true,
      observedAtMs: 100_000,
    });
    expect(fleetRowData(state, undefined, 112_000)).toEqual({
      tramKey: '9265',
      line: '22',
      reg: '#9265',
      modelId: '15t',
      modelShort: '15T',
      headsign: 'Bílá Hora',
      status: '→ Muzeum · 25 s',
      speedText: '≈42 km/h',
      delaySeconds: 90,
      airConditioned: true,
      ageText: '12 s',
    });
  });

  it('names the dwell stop from the trip stops and hides speed without geometry', () => {
    const dwelling = tram({
      key: '8300',
      line: '22',
      modelId: 't3rp',
      phase: 'dwell',
      simDistM: 500,
      observedAtMs: 0,
    });
    const stops = [
      { distM: 0, name: 'Depot' },
      { distM: 500, name: 'Muzeum' },
    ];
    expect(fleetRowData(dwelling, stops, 5_000).status).toBe('At Muzeum');
    expect(fleetRowData(dwelling, undefined, 5_000).status).toBe('At stop');

    const noGeo = tram({
      key: '9051',
      line: '9',
      modelId: 'kt8d5',
      phase: 'unknown',
      hasGeometry: false,
      observedAtMs: 0,
    });
    const row = fleetRowData(noGeo, undefined, 3_000);
    expect(row.speedText).toBeNull();
    expect(row.status).toBe('Tracking');
    expect(row.ageText).toBe('3 s');
  });
});
