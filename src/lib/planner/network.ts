// Tram network graph built from cached RouteGeometry stop sequences.
//
// Stations are grouped by stop NAME (all platforms sharing a name = one
// station), so a transfer is "same station name, different line". Each
// RouteGeometry contributes one directed ordered sequence of stations for its
// line; a line typically has several sequences (directions / short-turns).

import { pointAt } from '@/lib/geo/polyline';
import type { RouteGeometry } from '@/lib/types';

/** Diacritics-insensitive, case-insensitive normalization for name matching. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** One stop within a directed line sequence. */
export interface SeqStop {
  /** Display name (first-seen spelling). */
  name: string;
  /** Normalized station key. */
  key: string;
  stopId: string;
  coordinates: [number, number];
  /** Distance along the shape, meters. */
  distM: number;
}

/** A single directed run of a line (one RouteGeometry). */
export interface LineSequence {
  line: string;
  tripId: string;
  stops: SeqStop[];
  coordinates: [number, number][];
  cumDistM: number[];
}

export interface StationNode {
  key: string;
  name: string;
  /** Representative coordinate (first platform seen). */
  coordinates: [number, number];
  lines: Set<string>;
}

export interface TramNetwork {
  /** Station key → node. */
  stations: Map<string, StationNode>;
  /** All directed line sequences. */
  sequences: LineSequence[];
  /** Station key → sequences that pass through it. */
  sequencesByStation: Map<string, LineSequence[]>;
  /** Line short name → its sequences. */
  sequencesByLine: Map<string, LineSequence[]>;
}

/** Build the network graph from a set of loaded geometries. */
export function buildNetwork(geometries: RouteGeometry[]): TramNetwork {
  const stations = new Map<string, StationNode>();
  const sequences: LineSequence[] = [];
  const sequencesByStation = new Map<string, LineSequence[]>();
  const sequencesByLine = new Map<string, LineSequence[]>();
  // Many cached trips share an identical line + ordered station list (the same
  // direction driven by dozens of vehicles). Collapse those to ONE sequence
  // before indexing so the planner search doesn't re-explore identical rides.
  const seenSeqKeys = new Set<string>();

  for (const geo of geometries) {
    if (!geo.stops || geo.stops.length < 2) continue;

    const seqStops: SeqStop[] = geo.stops.map((s) => {
      const key = normalizeName(s.name);
      let node = stations.get(key);
      if (!node) {
        node = {
          key,
          name: s.name,
          coordinates: s.coordinates,
          lines: new Set<string>(),
        };
        stations.set(key, node);
      }
      node.lines.add(geo.line);
      return {
        name: s.name,
        key,
        stopId: s.stopId,
        coordinates: s.coordinates,
        distM: s.distM,
      };
    });

    // Dedupe by line + ordered station-key list. The station nodes above are
    // already registered (idempotent), so skipping here only avoids inserting a
    // redundant traversal into the search indexes.
    const seqKey = `${geo.line}::${seqStops.map((s) => s.key).join('>>')}`;
    if (seenSeqKeys.has(seqKey)) continue;
    seenSeqKeys.add(seqKey);

    const sequence: LineSequence = {
      line: geo.line,
      tripId: geo.tripId,
      stops: seqStops,
      coordinates: geo.coordinates,
      cumDistM: geo.cumDistM,
    };
    sequences.push(sequence);

    const byLine = sequencesByLine.get(geo.line) ?? [];
    byLine.push(sequence);
    sequencesByLine.set(geo.line, byLine);

    // Register the sequence under each distinct station it visits.
    const seen = new Set<string>();
    for (const st of seqStops) {
      if (seen.has(st.key)) continue;
      seen.add(st.key);
      const list = sequencesByStation.get(st.key) ?? [];
      list.push(sequence);
      sequencesByStation.set(st.key, list);
    }
  }

  return { stations, sequences, sequencesByStation, sequencesByLine };
}

/** True if a station is served by two or more distinct lines (a transfer point). */
export function isTransferStation(network: TramNetwork, stationKey: string): boolean {
  const node = network.stations.get(stationKey);
  return node ? node.lines.size >= 2 : false;
}

/**
 * Extract the polyline vertices between two along-shape distances (meters),
 * inclusive of the covered span. Used to draw a leg on the map.
 */
export function sliceCoordinates(
  seq: LineSequence,
  fromDistM: number,
  toDistM: number,
): [number, number][] {
  const lo = Math.min(fromDistM, toDistM);
  const hi = Math.max(fromDistM, toDistM);
  const out: [number, number][] = [];
  const push = (c: [number, number]) => {
    const last = out[out.length - 1];
    // Drop points coincident with the previous one (interpolated endpoints
    // frequently land exactly on an existing vertex).
    if (last && Math.abs(last[0] - c[0]) < 1e-9 && Math.abs(last[1] - c[1]) < 1e-9) return;
    out.push(c);
  };
  // Start with the interpolated point AT the from-distance...
  push(pointAt(seq.coordinates, seq.cumDistM, lo));
  // ...then every strictly-interior shape vertex...
  for (let i = 0; i < seq.coordinates.length; i++) {
    const d = seq.cumDistM[i];
    if (d > lo && d < hi) push(seq.coordinates[i]);
  }
  // ...and finish at the interpolated to-distance. Guarantees >= 2 coords even
  // when both stops share a single long shape segment.
  push(pointAt(seq.coordinates, seq.cumDistM, hi));
  return out;
}
