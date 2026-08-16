// The FROZEN slice of the app's src/lib/types.ts that the vendored build-12
// engine under ./engine needs, and that the app no longer has.
//
// Same rationale as ./engine-api.ts, applied to the engine's own sources: the
// vendored engine is a frozen artifact (build 12, the last shipped v2 engine),
// while src/lib/types.ts moves with the app. Physics v3 deleted SimDebugInfo
// outright and reshaped TramPublicState (projectedObservedDistM and paceBias
// are gone, deviationM changed meaning), so the vendored engine can no longer
// describe its own output with the app's types. It describes it with these.
//
// Deliberately NOT vendored: TramSnapshot, RouteGeometry, RouteStop and the
// fleet model spec. Those are the FEED contract — shared with the backend and
// fed into the engine by the lab from live app code — so the lab must keep
// tracking them from '@/lib/types' and break loudly if they drift.

import type { TramModelSpec, TramSnapshot } from '@/lib/types';

/** Per-tram public state for UI (detail sheet, lists). */
export interface TramPublicState {
  key: string;
  snapshot: TramSnapshot;
  model: TramModelSpec;
  /** Simulated distance along shape, m. */
  simDistM: number;
  /** Simulated speed, km/h. */
  simSpeedKmh: number;
  position: [number, number];
  bearing: number;
  phase: 'cruise' | 'dwell' | 'terminal' | 'unknown';
  /** Last REAL reported position (raw AVL fix), on-shape when geometry known. */
  observedPosition: [number, number];
  /** Bearing at the observed position (shape tangent; falls back to AVL bearing). */
  observedBearing: number;
  /** Distance between simulated and observed positions, meters (null w/o geometry). */
  deviationM: number | null;
  /**
   * Last observation dead-reckoned forward to `now` by the physics engine
   * (anchored strictly to the fix — jumps when a new fix arrives). Along-shape
   * meters; null without geometry. Drives 'live' position mode rendering.
   */
  projectedObservedDistM: number | null;
  /** Next stop name + eta if geometry known. */
  nextStopName: string | null;
  nextStopEtaS: number | null;
  hasGeometry: boolean;
  /**
   * Learned per-tram pace multiplier (recency-weighted EWMA of real vs
   * profile-expected inter-fix speed; 1 = profile pace). Undefined without a
   * sim (no geometry). Optional/additive — telemetry + diagnostics only.
   */
  paceBias?: number;
}

/**
 * Additive, on-demand debug view of one tram's INTERNAL sim state
 * (engine.getDebugInfo — debug overlay only, 10 Hz, never the map frame path).
 * Diagnostics only; nothing here feeds rendering. All distances are
 * along-shape meters; speeds km/h.
 */
export interface SimDebugInfo {
  /** False when the tram has no geometry sim yet (renders as a raw dot). */
  hasSim: boolean;
  phase: 'cruise' | 'dwell' | 'terminal' | 'unknown';
  simDistM: number;
  simSpeedKmh: number;
  /** The smoother's reference (sPred − active trail), m. null w/o sim. */
  targetDistM: number | null;
  /** errPred = (sPred − trail) − simDist, m. POSITIVE = smoother BEHIND the
   *  predictor (catching up), NEGATIVE = smoother ahead (yielding). null w/o
   *  sim. Replaces v1's schedule-blend-target errorM. */
  errPredM: number | null;
  /** Smoother regime chosen by the last tick (engine-v2.md §2.3 table).
   *  Replaces v1's crawling/deepCrawl/burstActive/skipRollActive latches. */
  regime: 'hold-follow' | 'track' | 'catchup' | 'yield' | null;
  /** Learned per-tram pace multiplier (1 = profile pace). null w/o sim. */
  paceBias: number | null;
  /** Braking-envelope/curve/stop speed cap at the current position, km/h
   *  (the hard limit; can reach the network V_MAX on open track). */
  vAllowedKmh: number | null;
  /** Zone/curve cruise cap at the current position, km/h (what open-track
   *  cruising aims at). vAllowed < cruiseCap ⇒ braking for a curve/stop. */
  cruiseCapKmh: number | null;
  /** Predictor stuck-hold anchor (jam/light), m along shape, or null. */
  stuckAtM: number | null;
  /** Junction-yield hold point on the RENDERED layer, m along shape, or null. */
  yieldHoldM: number | null;
  /** Platform the latest fix pins the tram at, m along shape, or null. */
  fixStopDistM: number | null;
  /** Whether that fix-pin is still fresh enough to be authoritative. */
  fixPinActive: boolean;
  /** Wall-clock ms the current dwell may release (0 outside 'dwell'). */
  dwellUntilMs: number;
  /** Latest raw AVL fix distance along shape, m. */
  obsDistM: number;
  /** ms epoch of that fix. */
  obsAtMs: number;
  /** Age of the last fix, ms (now − obsAt). */
  fixAgeMs: number;
  /** Last hard-teleport wall-clock ms (0 = never). */
  lastTeleportMs: number;
  /** Live-projection (dead-reckoned raw fix) distance, m, or null. */
  projDistM: number | null;

  // ── additive raw-internals extensions (10 Hz debug overlay) ────────────────
  // Diagnostics only — nothing below influences rendering or the simulation.
  // Appended so existing consumers (and the on-disk debug shape) stay valid.

  /** Sim speed, m/s (simSpeedKmh / 3.6, exposed raw alongside km/h). */
  simSpeedMs: number;
  /**
   * The PREDICTOR's cruise product, km/h: min(cruiseCap, V_CRUISE_REF) ·
   * paceBias · todPace — the pace reality is estimated to move at (still
   * clamped by vAllowed). null w/o sim.
   */
  cruiseTargetKmh: number | null;
  /** Zone speed cap at the current position (centre 31 vs network 50), km/h. null w/o sim. */
  zoneCapKmh: number | null;
  /** Curve speed cap at the current position, km/h (≈V_MAX where straight). null w/o sim. */
  curveCapKmh: number | null;
  /** Track curvature at the current position, rad/m (0 = straight). null w/o sim. */
  curveKappa: number | null;
  /** Curve radius at the current position, m (null when straight / no sim). */
  curveRadiusM: number | null;
  /** Time-of-day pace multiplier folded into the cruise target (1 = neutral). null w/o sim. */
  todPaceFactor: number | null;
  /** Latency-adjusted fix age, ms (fixAge + FEED_LATENCY) — the staleness clock. */
  staleFixAgeMs: number;
  /** Distance below which stops are ignored as 0-limits (served/passed), m. null w/o sim. */
  minStopDistM: number | null;
  /** Skip-roll zone end along shape, m (0 = none). */
  skipRollUntilM: number;
  /** Physical tram length incl. any coupled trailer, m. null w/o sim. */
  lengthM: number | null;
  /** Feed-reported schedule delay, seconds (+ late). */
  delaySeconds: number;
  /** Feed state string (on_track / at_stop / …). */
  statePosition: string;
}
