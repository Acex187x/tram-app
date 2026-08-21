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

// Compact the live calibration stats into the client-facing bundle. Hourly is a
// deliberate ceiling on churn — the underlying EWMAs have a 14-day half-life,
// so nothing meaningful moves faster than that.
crons.interval('calibration bundle', { hours: 1 }, internal.calibration.bundle.compact, {});

// Garbage-collect decayed-out cells (retired shape variants, scrapped trams).
// Decay itself is lazy — applied on write — so this only removes the corpses.
crons.daily(
  'calibration prune',
  { hourUTC: 3, minuteUTC: 20 },
  internal.calibration.fold.pruneStale,
  {},
);

export default crons;
