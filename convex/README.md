# Tram Spotter backend (Convex)

The 24/7 half of the app: one poll loop against Golemio, a diff stream the
client subscribes to, and continuous pace/dwell calibration that runs whether or
not anyone has the app open. Design record: `docs/decisions/backend-convex.md`.
The feed contract this must satisfy on the client side is in
`src/lib/feed/types.ts`.

```
convex/
  schema.ts              tables + the shared TramSnapshot validator
  poller.ts              pollLoop / start / stop / watchdog / recordFailure
  ingest.ts              applyPoll (diff + upsert + retire) / sweepBatches
  stream.ts              PUBLIC: fullFleet, batchesSince, health, calibrationBundle
  calibration/
    keys.ts              Prague hour band / day type / 250 m bucket keys
    models.ts            reg-number → tram model (ported from src/lib/fleet/registry.ts)
    fold.ts              foldPairs (the R13 gate + EWMAs) / pruneStale
    bundle.ts            compact (floors + shrinkage → the client bundle)
  crons.ts               watchdog, retention, hourly bundle, daily prune
```

Normalization is **not** duplicated here: `poller.ts` imports
`src/lib/golemio/normalize.ts`, the same pure module the app uses, so the server
and the client can never disagree about what a valid tram fix is.

## One-time setup (owner, interactive)

1. **Log in and create the deployment.** This is interactive and cannot be done
   by an agent:

   ```sh
   npx convex dev
   ```

   It logs into Convex, creates the project, writes `CONVEX_DEPLOYMENT` into
   `.env.local` (git-ignored), pushes `convex/`, and stays running as a watcher.
   Stop it with Ctrl-C once the first push succeeds.

2. **Give the deployment the Golemio key.** It is a *server-only* secret here —
   never `EXPO_PUBLIC_*`, which Expo would inline into the shipped bundle:

   ```sh
   npx convex env set GOLEMIO_KEY "<the JWT from .env>"
   npx convex env set GOLEMIO_KEY "<the JWT from .env>" --prod
   ```

   Optional: `GOLEMIO_ENDPOINT` overrides the API base
   (default `https://api.golemio.cz`), mirroring `EXPO_PUBLIC_GOLEMIO_ENDPOINT`.

   With no key set the poller enters the auth-failed state and probes once a
   minute — visible in `stream.health` as `authFailed: true`, exactly like a
   revoked token.

3. **Start the poller.** It does not start itself; a deployment with no
   `pollerState` row stays idle (that is deliberate — a fresh preview deployment
   should not immediately start burning the shared rate limit):

   ```sh
   npx convex run poller:start          # dev deployment
   npx convex run poller:start --prod   # production
   ```

   `poller:start` is idempotent: it bumps the generation token, which orphans
   any loop already running, so exactly one loop survives no matter how many
   times it is called.

4. **Check it.**

   ```sh
   npx convex run stream:health
   ```

   Healthy looks like `running: true`, `authFailed: false`,
   `consecutiveFailures: 0`, `fleetSize` around 150–200 in daytime, and
   `lastOkAtMs` within a couple of seconds of now.

Stop it with `npx convex run poller:stop` (bumps the generation and clears
`running`, so the watchdog leaves it stopped).

## Deploying changes

```sh
npx convex dev      # watch + push to the dev deployment while iterating
npx convex deploy   # push to production
npx convex codegen  # regenerate convex/_generated (committed; needed to typecheck)
npx tsc --noEmit -p convex   # typecheck the backend
npx tsc --noEmit             # the app project typechecks convex/ too
```

`convex/_generated/` is committed on purpose — without it neither project
typechecks. Never hand-edit it; it is excluded from ESLint for that reason.

## What runs on a schedule (`crons.ts`)

| job | every | what it does |
|---|---|---|
| `poller watchdog` | 1 min | Restarts `pollLoop` if the heartbeat is older than 2 min. Scheduled actions run **at most once** and are never retried, so this — not the loop — is the liveness guarantee: a deploy, crash or infrastructure hiccup self-heals within a minute. Does nothing if the poller was never started or was stopped on purpose. |
| `batches retention` | 1 min | Deletes `batches` rows older than 10 minutes. The diff stream is a resume buffer, not a log; a client that falls further behind re-seeds from `fullFleet`. |
| `calibration bundle` | 1 h | Compacts `segmentStats`/`modelStats`/`vehicleStats`/`stopStats` into the `bundles` singleton, applying minimum-sample floors and vehicle → model → fleet shrinkage. Refuses to publish while the fleet-level evidence is still thin. |
| `calibration prune` | daily 03:20 UTC | Deletes stats cells that have decayed to nothing and were last touched over 60 days ago (retired shape variants, scrapped trams). Decay itself is lazy — applied on write — so this only removes corpses. |

## The poll loop in one paragraph

`pollLoop` fetches `/v2/vehiclepositions?limit=10000` every 2 s (the CDN serves
it with `s-maxage=5`, so a 2 s poll reads each fresh object within ~2 s of it
existing; one key at ~4 starts / 8 s is far inside Golemio's 20-per-8-s budget),
normalizes with the shared pure module, and calls `ingest.applyPoll`. That
mutation writes only the vehicles whose fix actually moved, appends a `batches`
row only when something changed, retires trams unseen for 90 s, updates the
heartbeat, and schedules `calibration.fold.foldPairs` with the fresh fix pairs.
After ~8 minutes the action re-schedules itself and exits, staying under the
10-minute action ceiling. On 401/403 it enters the auth-failed state and probes
every 60 s; on any other failure it backs off exponentially to a 60 s ceiling
(jittered, floored by `Retry-After`). There is no retry *inside* a cycle — the
loop is the retry, and an inner retry would overlap the next tick and
double-spend the rate quota.

## Manual operations

```sh
npx convex run poller:start                 # start / restart the loop
npx convex run poller:stop                  # stop it
npx convex run stream:health                # poller + feed health
npx convex run stream:fullFleet             # current fleet snapshot
npx convex run calibration/bundle:compact   # force a bundle rebuild now
npx convex run calibration/fold:pruneStale  # force the GC sweep
npx convex env list                         # check GOLEMIO_KEY is set
```

Add `--prod` to any of these to target production.
