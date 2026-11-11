// Scheduled maintenance (backend-convex.md §2 and §4).
//
// Every job here is idempotent and bounded: each one either does nothing or
// does a fixed amount of work, so a missed run is caught by the next tick and
// a burst of runs cannot pile up.

import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

// Liveness. A scheduled action executes at most once and is never retried, so
// this is what actually guarantees the 24/7 poller: a loop killed by a deploy
// or a crash is restarted within a minute of its heartbeat going stale.
crons.interval('poller watchdog', { minutes: 1 }, internal.poller.watchdog, {});

// The diff stream is a resume buffer, not a log: rows older than 10 minutes are
// deleted, which is what keeps `batches` (and the storage bill) tiny.
crons.interval('batches retention', { minutes: 1 }, internal.ingest.sweepBatches, {});

// Trajectory feed hygiene: the diff stream is a resume buffer like `batches`,
// and abandoned vehicle rows (predictor died without a removal notice) must
// not serve ghost curves forever.
crons.interval('trajectory batches retention', { minutes: 1 }, internal.trajectories.sweepBatches, {});
crons.interval(
  'trajectory stale vehicles',
  { minutes: 5 },
  internal.trajectories.sweepStaleVehicles,
  {},
);

export default crons;
