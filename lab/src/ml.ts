// ML variants client + the SHARED FEATURE CONTRACT.
//
// The Python side (lab/ml/service.py) trains LightGBM + a small MLP nightly
// on the archived fix pairs to predict Δs — "how far does this tram travel in
// the next `gapS` seconds" — and serves batch inference. The TS side builds
// the SAME features online. The two implementations are kept in sync by hand;
// FEATURE_VERSION must match or predictions are refused (safe skip).
//
// FEATURES v3 (order unchanged; target/evidence clocks corrected):
//   0 gapS            seconds from anchor observation to evaluation instant
//   1 atStop          1 if the anchor fix was at_stop
//   2 delayS          reported schedule delay at anchor, clamped [-600, 900]
//   3 hourSin         sin(2π · pragueHour/24)
//   4 hourCos         cos(2π · pragueHour/24)
//   5 weekend         1 if Prague Sat/Sun
//   6 distToNextStopM distance from anchor to next stop ahead, clamp [0,2000] (1000 if unknown)
//   7 stopsNext1km    number of stops within the next 1000 m
//   8 learnedPace     current learned slow-surface pace at the anchor, m/s
//   9 learnedRelease  learned release seconds if atStop else 0
//  10 posFrac         anchor position / shape length, [0,1]
//  11 corridorPace    v2: recent measured pace of this km of track by ANY
//                     vehicle (12-min half-life) — the leader/congestion
//                     signal; falls back to learnedPace when no fresh sample
//  12 corridorTrust   v2: decayed weight of that signal, clamp [0, 5]
//
// v4 appends the seven causal per-trip fields from motionFeatures.ts.
// Its history is updated only after scoring the prior information set.
// v3: target horizon uses observation time; arrival is transport telemetry.
// Offline corridor evidence must be available by anchor receipt.
// Target: dsM = actualNext.shapeDistM − anchor.shapeDistM. The stacked
// learned features make the models residual learners over the statistical
// layer (the DeepETA lesson) — their win condition is "found signal the
// tables miss". v2 (2026-08-12) adds the corridor/leader signal after v1
// plateaued at ~58.6 m holdout across a ×1.8 data growth.

import type { RouteGeometry, TramSnapshot } from '@/lib/types';
import { ML_URL, pragueContext } from './config';
import type { LearnedModel } from './learned';
import {unknownMotionFeatures,type MotionFeatureHistory} from './motionFeatures';

export const FEATURE_VERSION = process.env.ML_FEATURE_VERSION === '4' ? 4 : 3;

export function buildMlFeatures(
  prev: TramSnapshot,
  geom: RouteGeometry,
  learned: LearnedModel,
  tEvalMs: number,
  motion?: MotionFeatureHistory,
): number[] {
  const s0 = prev.shapeDistM;
  const gapS = (tEvalMs - prev.observedAtMs) / 1000;
  const atStop = prev.statePosition === 'at_stop' ? 1 : 0;
  const delayS = Math.min(900, Math.max(-600, prev.delaySeconds));
  const { hour, dayType } = pragueContext(tEvalMs);
  const hourSin = Math.sin((2 * Math.PI * hour) / 24);
  const hourCos = Math.cos((2 * Math.PI * hour) / 24);
  const weekend = dayType === 'weekend' ? 1 : 0;

  let distToNextStopM = 1000;
  let stopsNext1km = 0;
  for (const st of geom.stops) {
    if (st.distM > s0) {
      if (distToNextStopM === 1000 && stopsNext1km === 0) {
        distToNextStopM = Math.min(2000, Math.max(0, st.distM - s0));
      }
      if (st.distM <= s0 + 1000) stopsNext1km++;
      else break;
    }
  }

  const learnedPace = learned.paceAt(geom.shapeId, geom.routeId, s0 + 100, tEvalMs);
  const learnedRelease =
    atStop === 1 && prev.nextStopId != null ? learned.releaseAt(prev.nextStopId, tEvalMs) : 0;
  const posFrac = geom.totalM > 0 ? Math.min(1, Math.max(0, s0 / geom.totalM)) : 0;
  const corridor = learned.corridorPaceAt(geom.shapeId, s0, tEvalMs);

  return [
    gapS,
    atStop,
    delayS,
    hourSin,
    hourCos,
    weekend,
    distToNextStopM,
    stopsNext1km,
    learnedPace,
    learnedRelease,
    posFrac,
    corridor.paceMs ?? learnedPace,
    corridor.trust,
    ...(FEATURE_VERSION===4 ? motion?.features(prev.key,prev.tripId,tEvalMs) ?? unknownMotionFeatures() : []),
  ];
}

export interface MlPredictions {
  modelRevision?: string | null;
  gbdt: (number | null)[];
  mlp: (number | null)[];
}

export class MlClient {
  lastOkMs = 0;
  lastError: string | null = null;
  modelsReady = false;
  modelRevision: string | null = null;
  lastRequestMs = 0;
  lastLatencyMs: number | null = null;
  private pendingRequests = 0;
  get inFlight(): boolean { return this.pendingRequests > 0; }

  async predictBatch(rows: number[][]): Promise<MlPredictions | null> {
    if (rows.length === 0) return { gbdt: [], mlp: [] };
    const startedAtMs = Date.now();
    this.lastRequestMs = startedAtMs;
    this.pendingRequests++;
    try {
      const res = await fetch(`${ML_URL}/predict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: FEATURE_VERSION, rows }),
        signal: AbortSignal.timeout(2_500),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { modelRevision?:string; version: number; ready: boolean; gbdt: (number | null)[]; mlp: (number | null)[] };
      if (body.version !== FEATURE_VERSION) throw new Error(`feature version ${body.version} != ${FEATURE_VERSION}`);
      if (body.ready && (!Array.isArray(body.gbdt) || body.gbdt.length !== rows.length ||
          !Array.isArray(body.mlp) || body.mlp.length !== rows.length)) {
        throw new Error('ML response row count does not match request');
      }
      this.lastOkMs = Date.now();
      this.lastError = null;
      this.modelsReady = body.ready;
      this.modelRevision = typeof body.modelRevision === 'string' ? body.modelRevision : null;
      if (!body.ready) return null;
      return { gbdt: body.gbdt, mlp: body.mlp, modelRevision: this.modelRevision };
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
      this.lastLatencyMs = Date.now() - startedAtMs;
      this.pendingRequests--;
    }
  }
}
