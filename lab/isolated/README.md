# Isolated tracking candidate

Deployed privately on 2026-09-05 at 23:08 Prague time. This is a separate output plane for the test app. Production services, files,
volumes, tokens, routes and T3/Hermes remain untouched. The candidate reads only
public production fix queries and geometry. It writes to its own fresh SQLite
and Convex volumes. No live database file is copied.

## Reviewed layout

Server directory: `/root/tram-tracking-candidate-20260905`.
Docker project: `tram-tracking-candidate` (compose.yml in this directory).
All published ports bind **10.10.10.1 only**, never 0.0.0.0/public WAN:

| Surface | Address | Purpose |
| --- | --- | --- |
| Candidate Convex | `http://10.10.10.1:13210` | trajectory WS/query and fresh clock |
| Candidate Convex HTTP | `http://10.10.10.1:13211` | candidate geometry-pack HTTP |
| Candidate Lab | `http://10.10.10.1:18090` | debug inspector and research endpoints |
| Candidate ML | `http://ml:8092` inside project network | version-3 inference only |

Read-only preflight verified these ports unused, the existing Convex ports
127.0.0.1:3210/3211, and the pinned Convex image digest in compose.yml. The home
IPsec selector covers 192.168.1.0/24 to 10.10.10.1; the Mac routes via 192.168.1.1.
No new DNS record is assumed: `tram-candidate.acex.lan` does not resolve.
Hard caps are 2 GiB for Convex and 1 GiB each for Lab/ML. There is no
Docker image build or application build in this procedure. Model fitting was
isolated locally with 2 threads and is already complete.

## Artifact and model inputs

Run `node lab/isolated/build-artifact.mjs /tmp/tram-isolated/artifact` from the
repository. The JS bundle includes 35 code inputs (exact list in
`artifact/build-inputs.json`), including the shared pure client render,
fix-forward and Hermite evaluator. The script rejects a React Native dependency.
It copies the Lab static HTML and ML service. `better-sqlite3` remains external:
the candidate installs pinned better-sqlite3 11.10.0 into its own node-runtime
volume. The production checkout dependencies had a different native ABI; the
smoke test caught this before startup and they remain unchanged.

Local review package currently lives in `/tmp/tram-isolated/`:

- `artifact/`: bundled Lab, static HTML, candidate ML service/requirements.
- `models/`: reviewed version 3 GBDT and MLP artifacts plus evaluation/report.
- `learned-aggregates.json`: 72k derived numeric learned-surface rows (pace,
  dwell, release and corridor statistics). It has no raw fixes, identities,
  scores, credentials or archives. Seed only into an empty candidate DB using
  `seed-learned.cjs`; the script refuses an existing nonempty DB.

The source 72h feature dataset is numeric-only and stays local:
`/tmp/tram-tracking-20260905/training-features-frozen.npz`. The earlier unsuffixed
export is superseded. Final models come from `ml-frozen-20pct`; the separate
`ml-frozen-24h` experiment validates the night subset. Model dependency versions
match the current ML container and are pinned for candidate startup.
`ML_TRAIN_ENABLED=0` loads these artifacts without opening any training DB.

The isolated Convex function project must contain ONLY:
`schema.ts`, `trajectories.ts`, `clock.ts`, `geometryPack.ts`, generated Convex
files, and `crons.ts` copied from this directory. Its only jobs are trajectory
retention. Do not copy production `crons.ts`, poller, ingest, calibration or
other functions. A minimal `http.ts` may expose geometryPack.serve at
`/api/geometry-pack`; the test phone's identity/geometry source remains production.

## Start order after review

1. Create the new server directory and upload only this review package and
   minimal Convex project. Use a fresh candidate-only ENGINE_PUSH_TOKEN in a
   mode 0600 `.env`; never reuse a production token. Validate compose with
   `docker compose config --quiet` (do not print expanded secrets).
2. Start only candidate `convex`. Its new named volume generates its own
   instance secret. Capture `docker compose exec -T convex
   ./generate_admin_key.sh` directly to a mode 0600 candidate admin-key file;
   do not print or copy this key into the repository.
3. From the isolated function project, use the existing server Convex CLI,
   `CONVEX_SELF_HOSTED_URL=http://10.10.10.1:13210` and the candidate admin key
   loaded in the process environment. Deploy the minimal functions with
   `convex deploy --yes --typecheck disable`, then set that instance's
   ENGINE_PUSH_TOKEN to the newly generated candidate token. Verify function
   listing has no city poller/watchdog or production cron.
4. Before starting Lab, run its seed helper once against its **empty** lab-data
   volume, with the numeric surface JSON mounted read-only. It must refuse any
   existing archive. Start candidate ML; verify health ready and feature 3 with
   an actual prediction. Start candidate Lab. It reads CONVEX_URL production,
   while PUBLISH_CONVEX_URL points only to the candidate Convex service.
5. Verify private endpoints from the Mac and from candidate containers, WS
   fullSet/diffs, clock nonce, successful publishes, geometry uploads, bounded
   memory, recent curves and new observation-time score series. Compare
   candidate/live predictions against the same next observed fixes before
   the final device build. Verify existing services were not restarted.

Stopping this Docker project stops only candidate containers. Retain its own
volumes/artifacts for diagnosis; do not prune shared Docker state.

## Validated 6 September recovery

The original candidate survived its first eight hours without publication
failures, but used its entire initial 1 GiB Convex memory cap plus swap. After
a credential rotation/recreation, SQLite bootstrap exhausted a 2 GiB cap.
The preserved old volume contains 106,610 historical document revisions and
303 MB of JSON despite only about 1.8 MB of active application documents.

The current Convex volume is `tram-tracking-candidate-convex-v2-20260906`,
created at 05:56:52Z. The original `tram-tracking-candidate_convex-data` volume
remains untouched for diagnosis/rollback. The same minimal function project
and candidate `ENGINE_PUSH_TOKEN` were installed in the fresh instance; Lab
republished the fleet. Its separate SQLite learned data and model artifacts
were preserved. The instance/admin credential was rotated without storing it
in this repository. Do not inspect process command lines: Convex includes its
instance secret in arguments. Keep credential generation redirected to files
with mode 0600.

`DOCUMENT_RETENTION_DELAY=3600` bounds this ephemeral candidate's MVCC history
in addition to the application-level five-minute stream retention. The exact
pinned backend defines that setting in
[common/knobs.rs](https://github.com/get-convex/convex-backend/blob/c0cb7ae17f54e14846c243c5332a8a5e6d0e19d4/crates/common/src/knobs.rs).
This setting applies only to the private test instance. No production retention
policy or database was changed. Initial recovered memory was approximately
207 MiB Convex, 117 MiB Lab and 123 MiB ML, with zero swap/pressure events.

The recovered instance was stable from 06:00Z. The final served-platform
policy update restarted only Lab at 06:39:01.483Z; use **06:41Z onward on
6 September** for final runtime validation. Older captures
must preserve the 05:49–05:58Z maintenance interval and sequence reset rather
than interpreting it as normal operation. Final Lab includes the shared
source-coherence gate, recovery on corrected evidence, rejection of older
contradictory fixes, and explicit invalid-row withdrawal even after restart.

## Device build

Keep `EXPO_PUBLIC_CONVEX_URL=https://tram-api.acex.sh` for identity/geometry.
Set `EXPO_PUBLIC_TRAJECTORY_CONVEX_URL=http://10.10.10.1:13210` and
`EXPO_PUBLIC_LAB_DEBUG_URL=http://10.10.10.1:18090/api/vehicle` for the test build.
The trajectory source and nonce clock move together.

The current Release Info.plist blocks HTTP. Add only a temporary test-build
ATS exception for `10.10.10.1` with NSExceptionAllowsInsecureHTTPLoads=true,
then restore the generated plist. iOS 17+ supports individual IP exceptions:
[Apple NSExceptionDomains](https://developer.apple.com/documentation/BundleResources/Information-Property-List/NSAppTransportSecurity/NSExceptionDomains).
Keep NSAllowsArbitraryLoads=false. Include local-network usage text if the
runtime requests it. This test build requires the user's home LAN/IPsec path;
no public route or TLS infrastructure is changed. Confirm real phone WS and
clock connectivity, rather than assuming Mac reachability proves it.
