// Pure ride-JSONL parser (schema v1–v4) for the recorded-rides list and the
// on-map ride preview. Deliberately forgiving: meta lines carry a `type`
// ('ride-start' header, 'ride-end'/'ride-orphaned' footers — v3+; 'motion'
// IMU batches — v4), every other parseable line is a GPS point, and
// corrupt/half-written lines are skipped — so interrupted (orphaned) files
// render exactly like completed ones.
import type { LngLat } from '@/lib/geo/polyline';

export interface ParsedRidePoint {
  t: number;
  gps: LngLat | null;
  sim: LngLat | null;
  /** v3 ground-truth lag simDist − gpsDist (m), null pre-v3 / without geometry. */
  lagM: number | null;
}

export interface ParsedRide {
  /** From the v3 header; null for v1/v2 files. */
  tramKey: string | null;
  model: string | null;
  line: string | null;
  schema: string | null;
  /** Header t, else first point t, else null. */
  startedMs: number | null;
  /** Footer t, else last point t, else null. */
  endedMs: number | null;
  /** True when the file was closed by orphan recovery (process died mid-ride). */
  orphaned: boolean;
  /** True when any footer is present (clean stop or orphan recovery). */
  closed: boolean;
  points: number;
  /** The rider's GPS track, [lng,lat][] (points without a fix are skipped). */
  gpsTrack: LngLat[];
  /** The simulated tram's track, [lng,lat][]. */
  simTrack: LngLat[];
  /** Mean of the available lagM values (m), null when none. */
  meanLagM: number | null;
  /** v4: IMU samples across all {type:'motion'} batch lines (0 pre-v4). */
  motionSamples: number;
  /** v4: GPS points flagged as outliers by the filter (`rej` non-null). */
  rejectedPoints: number;
  /** v4: mean of the available fLagM values (filtered-lag, m), null when none. */
  meanFLagM: number | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

export function parseRideFile(text: string): ParsedRide {
  const ride: ParsedRide = {
    tramKey: null,
    model: null,
    line: null,
    schema: null,
    startedMs: null,
    endedMs: null,
    orphaned: false,
    closed: false,
    points: 0,
    gpsTrack: [],
    simTrack: [],
    meanLagM: null,
    motionSamples: 0,
    rejectedPoints: 0,
    meanFLagM: null,
  };
  let firstPointMs: number | null = null;
  let lastPointMs: number | null = null;
  let lagSum = 0;
  let lagN = 0;
  let fLagSum = 0;
  let fLagN = 0;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // half-written tail line etc.
    }
    if (rec == null || typeof rec !== 'object') continue;

    const type = str(rec.type);
    if (type === 'ride-start') {
      ride.tramKey = str(rec.tramKey);
      ride.model = str(rec.model);
      ride.line = str(rec.line);
      ride.schema = str(rec.schema);
      ride.startedMs = num(rec.t);
      continue;
    }
    if (type === 'ride-end' || type === 'ride-orphaned') {
      ride.closed = true;
      if (type === 'ride-orphaned') ride.orphaned = true;
      ride.endedMs = num(rec.t) ?? ride.endedMs;
      continue;
    }
    if (type === 'motion') {
      // v4 IMU batch: prefer the sample-array length; `n` is the fallback for
      // a hand-truncated line.
      const s = rec.s;
      ride.motionSamples += Array.isArray(s) ? s.length : (num(rec.n) ?? 0);
      continue;
    }
    if (type != null) continue; // unknown future meta line

    // A GPS point (any schema version).
    const t = num(rec.t);
    if (t != null) {
      if (firstPointMs == null) firstPointMs = t;
      lastPointMs = t;
    }
    ride.points += 1;
    const gpsLat = num(rec.gpsLat);
    const gpsLng = num(rec.gpsLng);
    if (gpsLat != null && gpsLng != null) ride.gpsTrack.push([gpsLng, gpsLat]);
    const simLat = num(rec.simLat);
    const simLng = num(rec.simLng);
    if (simLat != null && simLng != null) ride.simTrack.push([simLng, simLat]);
    // v1/v2 lines have no line/model header — fall back to the point fields.
    if (ride.line == null) ride.line = str(rec.line);
    if (ride.model == null) ride.model = str(rec.model);
    const lagM = num(rec.lagM);
    if (lagM != null) {
      lagSum += lagM;
      lagN += 1;
    }
    // v4 extras.
    if (str(rec.rej) != null) ride.rejectedPoints += 1;
    const fLagM = num(rec.fLagM);
    if (fLagM != null) {
      fLagSum += fLagM;
      fLagN += 1;
    }
  }

  ride.startedMs = ride.startedMs ?? firstPointMs;
  ride.endedMs = ride.endedMs ?? lastPointMs;
  ride.meanLagM = lagN > 0 ? lagSum / lagN : null;
  ride.meanFLagM = fLagN > 0 ? fLagSum / fLagN : null;
  return ride;
}
