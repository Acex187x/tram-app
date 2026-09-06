// Isolated output instance: retention only, no city poller or production jobs.
import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';
const crons = cronJobs();
crons.interval('trajectory batches retention', { minutes: 1 }, internal.trajectories.sweepBatches, {});
crons.interval('trajectory vehicle retention', { minutes: 1 }, internal.trajectories.sweepStaleVehicles, {});
export default crons;
