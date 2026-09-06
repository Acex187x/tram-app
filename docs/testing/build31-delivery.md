# Review build 31 — 6 September 2026

**Follow-up correction after the user's device review:** the earlier replay's
zero-jump/zero-reverse counts excluded server-discontinuity frames. Replaying
the same capture with those frames included found 208 over-budget visible
jumps, including about 744 m of world displacement. The counts below describe
that incomplete original metric, not a teleport-free application. The original
native tests also exercised controls without establishing visual fidelity of
every mesh. The subsequent defect investigation starts in
[the visible-continuity amendment](../research/physics-v3-protocol.md) and
[model audit](../research/model-audit-2026-09-06/README.md).

The signed Release build was installed over the network on `pipka` (iPhone 17
Pro) at 08:11 CEST. CoreDevice independently reported bundle version **31** at
08:12:49. The launch request was denied because the iPhone was locked; installation
is verified, but physical-device rendering and private-network access are not.

This review build uses the private candidate described in
[tracking-candidate.md](tracking-candidate.md). Its new trajectory service needs
the home LAN/IPsec route. Production services and Git remotes were not changed.

## Verified

- All 34 map GLBs and 19 movable viewer GLBs pass geometry/mechanism/budget checks
  and Khronos validation with zero errors or warnings. All 53 current files are
  present byte-for-byte in the signed device artifact.
  A clean isolated install of the declared authoring dependencies also validates
  all 53 files without the workspace's temporary node_modules links.
- 979 Jest tests pass across 74 suites; one optional real-data suite/test is
  skipped because its external fixture is absent. App TypeScript passes.
- Build31 passes native iPad UI testing (R7) and iPhone UI testing (R8 models,
  R9 inspector/map). Tests exercise all seven front/rear views, doors, indicator
  controls, pinch/orbit, background return, real panel scrolling and fresh,
  advancing trajectory publication. Compact fleet navigation required a
  harness correction to use the visible search header at the sheet's peek detent.
  R10 repeats the inspector/map flows after the served-platform backend update:
  AVL age 10.5 s, profile age 2.7 s, fleet publication 0.8 s and movement 31.4 km/h
  were visible in the fresh Overview. The app runtime and assets stayed identical.
- Native images confirm the removal of the diagonal glazing corruption and
  decorative ground wedges. Simulator materials/resolution are deliberately
  cheaper than physical PBR rendering; they do not establish device GPU quality.
- The final matched 300-second replay follows 120 seconds of actual renderer
  warmup and retains 1,234,103 coherent frames and 747 identical historical AVL
  pairs per side. Held-marker time falls from 1061.53 to 29.03 vehicle-seconds;
  24.60 seconds of the remainder involve AVL older than 45 seconds. Reverse
  frames, speeds over 25 m/s and positive one-frame speed jumps over 1 m/s
  remain zero. Historical AVL MAE decreases from 67.17 to 64.00 m on_track and
  155.96 to 120.02 m at_stop. Among the same 224 before-platform anchors,
  duplicated smooth holds change from 82 to zero. These are short-window AVL
  proxies, not rider GPS accuracy; individual forecasts can still move ahead
  of later observations. Abrupt braking on source corrections remains: the
  largest one-frame speed reduction was 16.32 m/s in this candidate replay.
  This compares the whole candidate with production,
  not the isolated effect of the final served-platform change.
- Live shipping-source stop/start recovers fresh curves and a synchronized
  clock; expired trajectories stop moving. The isolated server's startup memory
  issue was resolved using a fresh retained-history-bounded volume; the previous
  volume remains preserved and production container identities are unchanged.

## Limits and review evidence

An experimental local-horizon pace correction remains disabled because its
average improvement came with individual regressions. Holds remain possible
at planned stops and during source corrections. A native 6-second hold of
9128 is recorded in the inspector evidence. Its exact recovered server curve
explains the first hold and the 36.3 m track difference, then schedules another
hold near the same platform. The accepted served-platform correction removes
this duplicated planning under exact ID/sequence, nonterminal, approach-distance
and intervening-platform guards. Initial modal dwell and physical limits remain.
The existing bounded trim-blinding window removes the redundant ML dwell smear.
In 326 faithful future-fix pairs, opinion/smooth MAE changes
96.95/111.72 to 91.85/106.78 m, without additional opinion speed dips or physical
violations; individual on-track error regressions remain documented. The
independent replay removes all 40 reproduced smooth duplicates. Actual moving
transitions already reach/past the platform; unsupported moving fixes before
it conservatively retain the old distance plan, without sticky controller state.

The iPad was reachable on the LAN during the evening, but not in CoreDevice;
its morning advertisement and old IP were also unavailable. The exact checks
and USB/Trust reconnect procedure are in
[ipad-network-discovery.md](ipad-network-discovery.md). No iPad installation is claimed.

Source and artifact hashes: [build31-manifest.json](results/build31-manifest.json).
Native evidence: [tracking-inspector.md](tracking-inspector.md).
Final paired capture:
[post-served-live-validation.json](results/tracking-2026-09-06-post-served-live-validation.json).
Earlier capture and lifecycle checks:
[final-live-validation.json](results/tracking-2026-09-06-final-live-validation.json).
