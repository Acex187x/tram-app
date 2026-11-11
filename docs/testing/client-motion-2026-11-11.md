# Client motion: tram envelope, curve cap, fade-rebase (2026-11-11)

Branch `tram/client-motion-2026-11` (off `tram/bringup-2026-11`). Not merged to `main`.

## What changed

1. **Tram presentation envelope** (`src/lib/physics/presentation.ts`, `fleet.ts`).
   Smooth-mode display follows the target inside the server contract:
   1.3 m/s² traction, 1.4 m/s² braking, 0.8 m/s³ jerk, 19.5 m/s ceiling
   (`TRAM_PRESENTATION_LIMITS`). It used the 2.5 / 2.5 / 4, 25 m/s correction
   envelope before. World-space (no geometry) and axis alignment keep the wider
   `PRESENTATION_LIMITS`.
2. **Curve soft cap** (`src/lib/physics/curveSpeed.ts`). It uses the drive-v3 rule
   0.85·√(0.98/κ) with a 0.8 m/s² approach envelope over 400 m, refreshed with the
   1 s lookahead. It steers speed through the jerk limit and never clips v. This is
   taken from the unmerged platform-driver worktree. Its positional controller
   (106→156 m MAE) was **not** taken.
3. **Fade-rebase for unreachable corrections** (`PRESENTATION_REBASE`). The display
   fades out, rebases and fades in (`unreachable-correction`) when either condition
   holds for 1 s:
   - the target is >300 m ahead, so catching up would mean racing at line speed;
   - the display is >60 m ahead of a target that needs more than 15 s to come level,
     so it would stand mid-route.

   Before this, the marker sprinted at up to 25 m/s or froze.
4. **Calibration log gate** (`src/lib/feed/*`, `src/hooks/tramData.ts`,
   `src/stores/settings.ts`). The runtime asks `feed.wantsCalibration()` before the
   whole-fleet `getPredictionStates()`. Before this, it built the records on every
   batch and dropped them inside `reportCalibration`. Passive fleet logging now
   defaults to off, and settings v3 migrates existing installs once. Ride recording
   is unaffected.
5. **Bench** (`bench/src/displayAudit.ts`, `replay-wire.ts`,
   `bench/scripts/capture-wire.mjs`). Adds the off-platform hold and required-crossing
   audit, ported from the platform-driver worktree. Also adds `REPLAY_MODE` and a
   `REPLAY_REBASE` sweep, plus a public live wire capture.

## Server flag (not in git: `lab/.env` on the deployment)

`TRAJ_CONTINUOUS_V1=1` was appended to `/root/code/pets/tram-app/lab/.env` on
2026-11-11 at 22:44 CET. `tram-lab` was recreated with the limits overlay. It is a
pure engine env flag (`lab/src/config.ts:183`). The ML service does not read it, and
Convex already validates `motionPolicy` on the wire, so no function deploy was
needed. The previous `.env` is backed up at
`/root/backups/tram-bringup-20261111/lab.env.before-continuous-v1`.
Rollback: delete the line, then run
`docker compose -p tram-lab -f docker-compose.yml -f docker-compose.limits.yml up -d --no-deps lab`.

## Replay (30 Hz, 300 s)

```sh
npx tsx --tsconfig lab/tsconfig.runtime.json bench/src/replay-wire.ts <wire.jsonl.gz> <geometry.json.gz> 30 300
node bench/scripts/capture-wire.mjs /tmp/live 330   # → /tmp/live-wire.jsonl.gz + /tmp/live-geometry.json.gz
```

"base" = `tram/bringup-2026-11` client (same as main) with the new audit. "new" = this branch.
The fixture is `docs/testing/fixtures/tracking-2026-09-06-final-candidate-wire.jsonl.gz`.
The live captures are in `/root/backups/tram-bringup-20261111/captures/`:

- legacy: 22:37–22:43 CET, `TRAJ_CONTINUOUS_V1=0`;
- cv1: 22:46–22:51 CET, `=1`.

| run | MAE m | p90 | p99 | off-platform held s | material hold s | moving-target-behind hold s | platform crossings >5 m/s | speed p99 m/s | acc p99 | jerk p99 | fade transitions | fading s | visible |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| fixture base | 106.0 | 250 | 393 | 1914 | 1389 | 933 | 157 | 23.4 | 2.5 | 4 | 1 | 0.8 | 0.99999 |
| fixture new | 105.2 | 243 | 391 | 1129 | 1025 | 109 | 175 | 16.5 | 1.4 | 0.8 | 64 | 51 | 0.99926 |
| fixture new, no rebase | 110.0 | 255 | 403 | 1973 | 2123 | 992 | 175 | 17.5 | 1.4 | 0.8 | 1 | 0.8 | 0.99999 |
| live legacy base | 82.6 | 185 | 449 | 1717 | 1411 | 998 | 277 | 24.9 | 2.5 | 4 | 1 | 0.8 | 0.99999 |
| live legacy new | 83.3 | 188 | 391 | 1258 | 1436 | 238 | 307 | 16.3 | 1.4 | 0.8 | 100 | 80 | 0.99901 |
| live cv1 base | 93.6 | 211 | 479 | 340 | 164 | 88 | 199 | 24.9 | 2.5 | 4 | 2 | 1.6 | 0.99998 |
| **live cv1 new (prod now)** | 90.9 | 203 | 423 | 317 | 410 | 62 | 200 | 16.8 | 1.4 | 0.8 | 43 | 34 | 0.99957 |

How to read the table:

- Legacy and cv1 are different 5-minute windows. MAE differences between them include
  traffic and are not attributable to the flag alone. The off-platform and hold drops
  (1717→340 s) are far larger than that noise.
- The tram limits alone, without rebase, are slightly worse: holds grow because braking
  is gentler. The rebase rule is what turns them into a net win.
- The rebase envelope was swept (behind 200/300/400/450 m, ahead 60/80/100/150 m, wait
  10/15/20/30 s). 300/60/15 keeps MAE at baseline with about half the fades of 200 m.
- Platform crossings above 5 m/s go up a little (157→175 on the fixture), because the
  1.4 m/s² brake cannot stop for a target that halts abruptly. Request-stop metadata is
  still off in prod, so "required" crossings count every platform.

## Simulator smoke

QA build **39.1.3** is the native base 39 with this branch's JS. It was built with
`expo export:embed` on Linux, then the bundle and assets were swapped into the 39.1.2
app on mac-builder. There was no native rebuild. Staging is
`/Users/server/Code/tram-qa-client-motion-20261111`, and the bundle SHA-256 is in its
`manifest.json`. The run went through the ios-resource arbiter on the iPhone 17 Pro Max
(758B3A6C), with the deep link `fablespotsthetram://tram/9321`. Live data loaded and the
followed tram moved smoothly: 13.7→16.6 km/h over 8 s. Screenshots are at
`/workspace/tram/screens/motion-{1,2,3}.png` on the agent box.

## Tests

`npx jest`: 1218 passed, 1 skipped. `tsc --noEmit` is clean, and ESLint shows no new
warnings. These frame-ownership tests were updated to the tram envelope:

- the braking test now uses a closable 15 m jump-back over 10 s;
- the forward launch bound is now 1.3 m/s².

New tests cover:

- fade-rebase behind;
- fade-rebase ahead;
- the curve cap;
- the calibration gate.
