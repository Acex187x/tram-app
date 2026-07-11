// Pure filter/sort/format helpers behind the search sheet's fleet browser.
// No React / React Native imports — everything here runs under plain jest
// (__tests__/fleet-filter.test.ts) and stays cheap enough to re-run at the
// 1 Hz useAllTramStates cadence.

import type { TramModelId, TramPublicState } from '@/lib/types';

// ── Filters ──────────────────────────────────────────────────────────────────

/**
 * Active fleet-browser filters. Empty array = "All" for that group. Groups
 * combine with AND (a tram must match both), values within a group with OR.
 */
export interface FleetFilters {
  models: readonly TramModelId[];
  lines: readonly string[];
}

export const EMPTY_FLEET_FILTERS: FleetFilters = { models: [], lines: [] };

/** Canonical fleet order (oldest → newest), used for the model chip row. */
export const MODEL_ORDER: readonly TramModelId[] = [
  't3',
  't3rp',
  't3rplf',
  'kt8d5',
  '14t',
  '15t',
  '52t',
];

/** Chip-sized short names for MODEL_SPECS[...].name. */
export const MODEL_SHORT_NAMES: Record<TramModelId, string> = {
  t3: 'T3',
  t3rp: 'T3R.P',
  t3rplf: 'T3R.PLF',
  kt8d5: 'KT8D5',
  '14t': '14T',
  '15t': '15T',
  '52t': '52T',
};

export function hasActiveFilters(filters: FleetFilters): boolean {
  return filters.models.length > 0 || filters.lines.length > 0;
}

/** Multi-select toggle: remove the value if present, append it otherwise. */
export function toggleFilterValue<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

// ── Facets & filtering ───────────────────────────────────────────────────────

/** Trams the browser counts as live: everything reported except canceled trips. */
export function liveFleet(states: readonly TramPublicState[]): TramPublicState[] {
  return states.filter((s) => !s.snapshot.isCanceled);
}

export interface ModelFacet {
  id: TramModelId;
  count: number;
}

/** Models present in the given states (canonical order) with live counts. */
export function modelFacets(states: readonly TramPublicState[]): ModelFacet[] {
  const counts = new Map<TramModelId, number>();
  for (const s of states) counts.set(s.model.id, (counts.get(s.model.id) ?? 0) + 1);
  return MODEL_ORDER.filter((id) => counts.has(id)).map((id) => ({
    id,
    count: counts.get(id) ?? 0,
  }));
}

/** Numeric-first line ordering ('4' < '22' < '91'); non-numeric fall back to locale. */
export function compareLines(a: string, b: string): number {
  return Number(a) - Number(b) || a.localeCompare(b);
}

/** Distinct lines present in the given states, sorted numerically. */
export function lineFacets(states: readonly TramPublicState[]): string[] {
  const set = new Set<string>();
  for (const s of states) set.add(s.snapshot.line);
  return [...set].sort(compareLines);
}

/** Browser list order: line (numeric), then registration (numeric-aware). */
export function compareFleetOrder(a: TramPublicState, b: TramPublicState): number {
  return (
    compareLines(a.snapshot.line, b.snapshot.line) ||
    a.key.localeCompare(b.key, undefined, { numeric: true })
  );
}

export function matchesFilters(state: TramPublicState, filters: FleetFilters): boolean {
  if (filters.models.length > 0 && !filters.models.includes(state.model.id)) return false;
  if (filters.lines.length > 0 && !filters.lines.includes(state.snapshot.line)) return false;
  return true;
}

/**
 * The browser's list: live (non-canceled) trams matching the filters, sorted
 * by line then registration. Pure — safe to memo on (states, filters).
 */
export function filterFleet(
  states: readonly TramPublicState[],
  filters: FleetFilters,
): TramPublicState[] {
  return liveFleet(states).filter((s) => matchesFilters(s, filters)).sort(compareFleetOrder);
}

// ── Row display data ─────────────────────────────────────────────────────────

/** '12 s' under ~1.5 min, then '2 min' — used for both ETA and updated-age. */
export function formatShortDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 100) return `${s} s`;
  return `${Math.round(s / 60)} min`;
}

/**
 * Name of the stop a dwelling tram is standing at: the last stop whose
 * distance-along-shape is at (or just ahead of) the sim position. `stops`
 * must be ordered by distM (RouteGeometry contract). Null when the sim sits
 * before the first stop or no stops are known.
 */
export function stopNameAt(
  simDistM: number,
  stops: readonly { distM: number; name: string }[],
  toleranceM = 30,
): string | null {
  let best: string | null = null;
  for (const stop of stops) {
    if (stop.distM > simDistM + toleranceM) break;
    best = stop.name;
  }
  return best;
}

/**
 * Phase-aware one-line live status:
 *  dwell    → 'At <stop>' (falls back to 'At stop' without a resolvable name)
 *  cruise   → '→ <next stop> · N s'
 *  terminal → 'At terminus'
 *  unknown  → 'Tracking' (no geometry yet)
 */
export function liveStatusText(input: {
  phase: TramPublicState['phase'];
  nextStopName: string | null;
  nextStopEtaS: number | null;
  atStopName?: string | null;
}): string {
  switch (input.phase) {
    case 'terminal':
      return 'At terminus';
    case 'dwell':
      return input.atStopName != null ? `At ${input.atStopName}` : 'At stop';
    case 'cruise':
      if (input.nextStopName == null) return 'Cruising';
      return input.nextStopEtaS != null
        ? `→ ${input.nextStopName} · ${formatShortDuration(input.nextStopEtaS)}`
        : `→ ${input.nextStopName}`;
    default:
      return 'Tracking';
  }
}

/** Everything a FleetRow renders, reduced to primitives (memo-friendly). */
export interface FleetRowData {
  tramKey: string;
  line: string;
  /** '#9265' (or '#<tripId>' for the rare registration-less fallback key). */
  reg: string;
  modelId: TramModelId;
  modelShort: string;
  headsign: string;
  status: string;
  /** '≈42 km/h' — tilde marks it as simulated. Null without geometry. */
  speedText: string | null;
  delaySeconds: number;
  airConditioned: boolean;
  /** Age of the last real AVL fix, e.g. '12 s'. */
  ageText: string;
}

export function fleetRowData(
  state: TramPublicState,
  stops: readonly { distM: number; name: string }[] | undefined,
  nowMs: number,
): FleetRowData {
  const atStopName =
    state.phase === 'dwell' && stops ? stopNameAt(state.simDistM, stops) : null;
  return {
    tramKey: state.key,
    line: state.snapshot.line,
    reg: `#${state.key}`,
    modelId: state.model.id,
    modelShort: MODEL_SHORT_NAMES[state.model.id],
    headsign: state.snapshot.headsign,
    status: liveStatusText({
      phase: state.phase,
      nextStopName: state.nextStopName,
      nextStopEtaS: state.nextStopEtaS,
      atStopName,
    }),
    speedText: state.hasGeometry ? `≈${Math.round(state.simSpeedKmh)} km/h` : null,
    delaySeconds: state.snapshot.delaySeconds,
    airConditioned: state.snapshot.airConditioned === true,
    ageText: formatShortDuration((nowMs - state.snapshot.observedAtMs) / 1000),
  };
}
