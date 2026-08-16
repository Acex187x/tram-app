// TramPublicState → CalibrationRecord conversion. This is the single source of
// the record field ORDER and ROUNDING: the motionlog daily JSONL lines are
// `JSON.stringify` of these objects (insertion order preserved), so changing a
// field here changes the on-disk format — keep it stable.
//
// Lives in the feed because the record shape is the feed↔backend contract
// (reportCalibration / POST /v1/calibration); motionlog is merely today's
// storage for it.

import type { TramPublicState } from '@/lib/types';
import type { CalibrationRecord } from './types';

/** Round to `p` decimals; null for missing/non-finite values. */
function r(n: number | null | undefined, p = 0): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** p;
  return Math.round(n * f) / f;
}

/**
 * Build one calibration record for a tram at batch time `t`. Field order and
 * rounding are byte-compatible with the historic motionlog `pollRecord` line.
 */
export function toCalibrationRecord(s: TramPublicState, t: number): CalibrationRecord {
  return {
    t,
    key: s.key,
    model: s.model.id,
    line: s.snapshot.line,
    obsDist: r(s.snapshot.shapeDistM),
    simDist: r(s.simDistM),
    // physics v3: the second curve (the model's raw opinion) took over this
    // slot from the deleted dead-reckoned projection — still "the other
    // estimate of where this tram is", so the column stays comparable.
    projDist: r(s.fixedDistM),
    // Now the smooth↔fixed gap rather than sim-vs-fix; see TramPublicState.
    devM: r(s.deviationM, 1),
    kmh: r(s.simSpeedKmh, 1),
    // paceBias died with the client engine — pace is learned server-side now.
    // The column is kept (on-disk/JSONL prefix contract) and always null.
    bias: null,
    lat: r(s.position[1], 6),
    lng: r(s.position[0], 6),
    mode: s.phase,
    // R7 (schema v2) — appended AFTER the historic fields so old lines remain a
    // strict prefix; JSONL parsers reading known keys ignore these.
    obsAt: r(s.snapshot.observedAtMs),
    statePos: s.snapshot.statePosition ?? null,
    delayS: r(s.snapshot.delaySeconds),
    nextSeq: r(s.snapshot.nextStopSequence),
  };
}

/**
 * Records for one snapshot batch: every tram WITH geometry (a tram without a
 * shape has no sim to calibrate against). May be empty — callers still report
 * empty batches so the storage's flush clock keeps ticking.
 */
export function toCalibrationRecords(
  states: readonly TramPublicState[],
  t: number,
): CalibrationRecord[] {
  const out: CalibrationRecord[] = [];
  for (const s of states) {
    if (!s.hasGeometry) continue;
    out.push(toCalibrationRecord(s, t));
  }
  return out;
}
