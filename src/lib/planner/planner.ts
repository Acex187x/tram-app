// Journey planner over the tram network graph.
//
// planItineraries finds rides from one station name to another: direct lines
// first, then 1-transfer, then 2-transfer routes (bounded BFS/DFS over line
// sequences). searchStops offers diacritics-insensitive station name lookup.

import type { PlannerItinerary, PlannerLeg, RouteGeometry } from '@/lib/types';
import {
  buildNetwork,
  isTransferStation,
  normalizeName,
  sliceCoordinates,
  type LineSequence,
  type TramNetwork,
} from './network';

const MAX_TRANSFERS = 2;
const MAX_RESULTS = 8;
const MAX_EXPANSIONS = 20_000; // safety guard against pathological branching

function makeLeg(seq: LineSequence, i: number, j: number): PlannerLeg {
  const a = seq.stops[i];
  const b = seq.stops[j];
  return {
    line: seq.line,
    fromStopId: a.stopId,
    fromStopName: a.name,
    toStopId: b.stopId,
    toStopName: b.name,
    stopCount: j - i,
    coordinates: sliceCoordinates(seq, a.distM, b.distM),
  };
}

function legSignature(legs: PlannerLeg[]): string {
  return legs
    .map((l) => `${l.line}:${normalizeName(l.fromStopName)}>${normalizeName(l.toStopName)}`)
    .join('|');
}

/**
 * Plan itineraries between two station NAMES over the supplied geometries.
 * Returns up to MAX_RESULTS itineraries, ordered by fewest transfers then
 * fewest stops.
 */
export function planItineraries(
  from: string,
  to: string,
  geometries: RouteGeometry[],
): PlannerItinerary[] {
  const network = buildNetwork(geometries);
  const fromKey = resolveStationKey(network, from);
  const toKey = resolveStationKey(network, to);
  if (!fromKey || !toKey || fromKey === toKey) return [];

  const results: PlannerItinerary[] = [];
  const seenSignatures = new Set<string>();
  let expansions = 0;

  const dfs = (
    stationKey: string,
    legs: PlannerLeg[],
    usedLines: Set<string>,
    visited: Set<string>,
  ): void => {
    if (expansions++ > MAX_EXPANSIONS) return;
    if (results.length >= MAX_RESULTS * 4) return; // gather a pool, trim later

    const sequences = network.sequencesByStation.get(stationKey) ?? [];
    const lastLine = legs.length > 0 ? legs[legs.length - 1].line : null;

    for (const seq of sequences) {
      if (seq.line === lastLine) continue; // no consecutive same-line leg
      if (usedLines.has(seq.line)) continue; // don't ride a line twice

      const i = seq.stops.findIndex((s) => s.key === stationKey);
      if (i < 0) continue;

      for (let j = i + 1; j < seq.stops.length; j++) {
        const cand = seq.stops[j];
        if (visited.has(cand.key)) continue;

        if (cand.key === toKey) {
          const legs2 = [...legs, makeLeg(seq, i, j)];
          const sig = legSignature(legs2);
          if (!seenSignatures.has(sig)) {
            seenSignatures.add(sig);
            results.push(toItinerary(legs2));
          }
          break; // earliest arrival on this sequence; stop scanning
        }

        if (
          legs.length < MAX_TRANSFERS && // room for another leg (=> a transfer)
          isTransferStation(network, cand.key)
        ) {
          dfs(
            cand.key,
            [...legs, makeLeg(seq, i, j)],
            new Set(usedLines).add(seq.line),
            new Set(visited).add(cand.key),
          );
        }
      }
    }
  };

  dfs(fromKey, [], new Set<string>(), new Set<string>([fromKey]));

  results.sort(
    (a, b) => a.transferCount - b.transferCount || a.totalStops - b.totalStops,
  );
  return results.slice(0, MAX_RESULTS);
}

function toItinerary(legs: PlannerLeg[]): PlannerItinerary {
  return {
    legs,
    transferCount: legs.length - 1,
    totalStops: legs.reduce((sum, l) => sum + l.stopCount, 0),
  };
}

function resolveStationKey(network: TramNetwork, name: string): string | null {
  const key = normalizeName(name);
  if (network.stations.has(key)) return key;
  // Fall back to a prefix / substring match if the exact name isn't present.
  for (const stationKey of network.stations.keys()) {
    if (stationKey === key) return stationKey;
  }
  return null;
}

/**
 * Search station names, diacritics- and case-insensitive. Returns matching
 * display names (deduped, prefix matches first) capped at `limit`.
 */
export function searchStops(
  query: string,
  geometries: RouteGeometry[],
  limit = 20,
): string[] {
  const q = normalizeName(query);
  if (q.length === 0) return [];

  const network = buildNetwork(geometries);
  const prefix: string[] = [];
  const substring: string[] = [];

  for (const node of network.stations.values()) {
    const idx = node.key.indexOf(q);
    if (idx === 0) prefix.push(node.name);
    else if (idx > 0) substring.push(node.name);
  }

  prefix.sort((a, b) => a.localeCompare(b));
  substring.sort((a, b) => a.localeCompare(b));
  return [...prefix, ...substring].slice(0, limit);
}
