// Physics v3 — the entire client physics, in one folder.
//
// The contract it implements is docs/research/physics-v3-protocol.md (FROZEN).
// Read the parts in order; each file's header explains its half of the design:
//
//   evaluator.ts        pure arithmetic over one curve (the "engine")
//   bundle.ts           one-time decode of a /api/trajectories/v2 body
//   clock.ts            server-clock sync — what makes clients agree
//   connection.ts       the live/degraded/offline verdict — honesty
//   render.ts           which curve, evaluated when (smooth vs fixed)
//   adapter.ts          curves → TramPublicState for the existing UI
//   trajectoryStore.ts  the 5 s fetch loop (the only network call)
//   fleet.ts            the seam the old TramEngine occupied
//
// What is NOT here, deliberately: any notion of a tick, a controller, an
// integrator, per-tram memory, or a fallback that invents motion when the
// server is unreachable. Without the server there is no physics — the trams
// freeze on their last known curve, dimmed, behind an explicit banner.

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
  renderTram,
  renderDistM,
  smoothFixedDeltaM,
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

export {
  TrajectoryStore,
  TRAJECTORIES_URL,
  TRAJECTORY_POLL_MS,
  trajectoriesUrl,
  genFromGenerator,
  type PhysicsGen,
  type TrajectoryHealth,
} from './trajectoryStore';

export { TramFleet, type TramFleetOptions } from './fleet';
