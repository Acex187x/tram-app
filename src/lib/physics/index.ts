// Physics v3 — the entire client physics, in one folder.
//
// The contract it implements is docs/research/physics-v3-protocol.md (FROZEN).
// Read the parts in order; each file's header explains its half of the design:
//
//   evaluator.ts        pure arithmetic over one curve (the "engine")
//   bundle.ts           one-time decode of a /api/trajectories/v2 body
//   clock.ts            server-clock sync — what makes clients agree
//   connection.ts       the live/degraded/offline verdict — honesty
//   fixForward.ts       the last-mile shim: the newest fix moves the curve
//   render.ts           which curve, evaluated when (smooth vs fixed)
//   adapter.ts          curves → TramPublicState for the existing UI
//   trajectoryStore.ts  the 5 s fetch loop (the only network call)
//   fleet.ts            the seam the old TramEngine occupied
//
// What is NOT here, deliberately: any notion of a tick, a controller, an
// integrator, or per-tram memory. Without the server there is still no
// physics: the ONE thing the client adds is fixForward.ts, and even that
// invents no motion — it translates the server's own curve so it passes
// through the newest AVL fix, because the fix stream reaches the phone ~7–11 s
// ahead of the curve that accounts for it. Past the horizon a tram coasts to a
// halt over 20 s and then freezes, dimmed, behind an explicit banner.

export {
  evalTrajectory,
  evalSpeedMs,
  crossingTimeMs,
  knotCount,
  trackStartMs,
  trackEndMs,
  trackEndS,
  SPEED_HALF_WINDOW_MS,
} from './evaluator';

export {
  parseBundle,
  packTrack,
  EMPTY_TRACK,
  MAX_KNOTS,
  PROTOCOL_VERSION,
  type ParsedBundle,
  type ParsedVehicle,
} from './bundle';

export {
  ClockSync,
  weightedOffset,
  CLOCK_WINDOW,
  CLOCK_DECAY,
  CLOCK_IMPLAUSIBLE_MS,
} from './clock';

export {
  connectionState,
  DEGRADED_AFTER_S,
  OFFLINE_AFTER_S,
  OFFLINE_AFTER_FAILURES,
  OFFLINE_BANNER_TEXT,
  type ConnectionInput,
  type ConnectionState,
} from './connection';

export {
  fixForwardTauMs,
  trackEndSpeedMs,
  coastDistM,
  SMOOTH_CATCHUP_V_MS,
  COAST_DECAY_MS,
} from './fixForward';

export {
  renderTram,
  renderDistM,
  renderedDistM,
  renderSpeedMs,
  fixForwardAppliedM,
  smoothFixedDeltaM,
  catchupVMsFor,
  trackFor,
  type RenderMode,
  type RenderedTram,
} from './render';

export {
  adaptTram,
  nearestStopIndex,
  nextStopIndex,
  DWELL_SPEED_KMH,
  DWELL_NEAR_STOP_M,
  type AdaptInput,
} from './adapter';

export { TrajectoryStore, type TrajectoryHealth } from './trajectoryStore';

export { TramFleet, type TramFleetOptions } from './fleet';
