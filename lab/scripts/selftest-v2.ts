// Offline invariant test for the physics-v3 track builder (lab/src/trajectory.ts).
// Pure — no DB, no ML, no network; the learned walk is stubbed with a constant
// pace so the test asserts the CONTRACT, not the model.
//
//   cd lab && TSX_TSCONFIG_PATH=$PWD/tsconfig.runtime.json \
//     ./node_modules/.bin/tsx scripts/selftest-v2.ts
//
// Since 2026-08-16 the contract includes the KINEMATIC LIMITS
// (docs/research/physics-v3-protocol.md §Kinematic limits): every emitted
// segment of every track must stay under 17.0 m/s and inside +1.35/−1.45 m/s²
// as a lerping client experiences it. `contract()` asserts that on every track
// this file builds, so a limit violation fails the suite wherever it appears.

import {
  TRAJ_A_ACC_GATE,
  TRAJ_A_BRK_GATE,
  TRAJ_V_MAX_GATE_MS,
  TRAJ_V_MAX_MS,
} from '../src/config';
import { readRealism } from '../src/realism';
import { buildV2Vehicle, evalTrack, modalReleaseMs, speedAt, type TrackPoint } from '../src/trajectory';

const T0 = 1_800_000_000_000;
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** ml-gbdt TARGET positions: 13 points, 10 s apart, constant pace from s0. */
function raw(s0: number, paceMs: number, t0 = T0): TrackPoint[] {
  return Array.from({ length: 13 }, (_, k) => ({ t: t0 + k * 10_000, s: s0 + paceMs * k * 10 }));
}

/** Wire contract + kinematic limits, asserted on every track the suite builds. */
function contract(name: string, track: TrackPoint[], t0: number): void {
  const tMono = track.every((p, i) => i === 0 || p.t > track[i - 1].t);
  const sMono = track.every((p, i) => i === 0 || p.s >= track[i - 1].s);
  const horizonS = (track[track.length - 1].t - t0) / 1000;
  check(
    `${name}: t↑ / s↛↓ / ${track.length}≤24 pts / horizon ${horizonS}s ≥120 / t0 anchored`,
    tMono && sMono && track.length <= 24 && horizonS >= 120 && track[0].t === t0,
  );
  const r = readRealism(track);
  check(
    `${name}: kinematic limits — v ≤ ${TRAJ_V_MAX_GATE_MS}, a ∈ [−${TRAJ_A_BRK_GATE}, +${TRAJ_A_ACC_GATE}]`,
    r.maxSpeed <= TRAJ_V_MAX_GATE_MS && r.maxAccel <= TRAJ_A_ACC_GATE && r.minAccel >= -TRAJ_A_BRK_GATE,
    `vmax ${r.maxSpeed.toFixed(2)} m/s, a ∈ [${r.minAccel.toFixed(3)}, ${r.maxAccel.toFixed(3)}]`,
  );
}

// ── 1. moving vehicle, first emission ───────────────────────────────────────
{
  const r = raw(1000, 8);
  const b = buildV2Vehicle({
    key: 'A', tripId: 't1', line: '22', anchorMs: T0 - 5000, emittedAtMs: T0,
    raw: r, modal: null, prev: null,
  })!;
  const v = b.vehicle;
  contract('moving/opinion', v.opinion, T0);
  contract('moving/smooth', v.smooth, T0);
  check('moving: first emission ⇒ smooth == opinion, no discontinuity',
    !v.discontinuity && JSON.stringify(v.smooth) === JSON.stringify(v.opinion));
  // A constant-pace target is already physical, so the fit should reproduce it
  // almost exactly — the kinematic layer must not cost accuracy where physics
  // is not binding.
  const worst = Math.max(...[0, 30_000, 60_000, 120_000].map((d) =>
    Math.abs(evalTrack(v.opinion, T0 + d) - evalTrack(r, T0 + d))));
  check('moving: a physical target is tracked to the centimetre', worst < 0.05,
    `worst |opinion − target| = ${worst.toFixed(3)} m`);
  check('moving: constant pace ⇒ compressed to a handful of knots', v.opinion.length <= 4,
    `${v.opinion.length} pts`);
}

// ── 2. modal stop rule + a PHYSICAL departure ───────────────────────────────
{
  // Expectation-floating raw curve: the ML mean creeps off the platform.
  const r = raw(2000, 2.5);
  const releaseAtMs = modalReleaseMs(T0, 0, 20, 8); // Φ⁻¹(0.6)=0.2533 ⇒ ~+22 s
  const b = buildV2Vehicle({
    key: 'B', tripId: 't1', line: '22', anchorMs: T0 - 5000, emittedAtMs: T0,
    raw: r,
    modal: { stopS: 2000, releaseAtMs, walk: (t) => 2000 + Math.max(0, (t - releaseAtMs) / 1000) * 6 },
    prev: null,
  })!;
  const v = b.vehicle;
  contract('modal/opinion', v.opinion, T0);
  check('modal: release instant ≈ mean + 0.2533·sd',
    Math.abs(releaseAtMs - (T0 + 22_027)) < 100, `${(releaseAtMs - T0) / 1000}s`);
  check('modal: HOLDS at the platform until release (no floating)',
    [0, 5_000, 10_000, 20_000, 22_000].every((d) => evalTrack(v.opinion, T0 + d) === 2000),
    `raw would be at ${evalTrack(r, T0 + 22_000).toFixed(1)} m`);
  // THE build-13 fix: the old builder stepped from 0 to full learned pace at
  // the release knot. It must now ramp, and reach the pace it was going to.
  const vAt = (d: number) => speedAt(b.opinion, releaseAtMs + d);
  check('modal: departure is a RAMP, not a step',
    vAt(0) < 0.05 && vAt(2_000) > 1 && vAt(2_000) < 3.5 && vAt(20_000) > 5,
    `v at release +0/+2/+20 s = ${vAt(0).toFixed(2)}/${vAt(2_000).toFixed(2)}/${vAt(20_000).toFixed(2)} m/s`);
  check('modal: reaches full learned pace once accelerated',
    Math.abs(vAt(30_000) - 6) < 1.2, `${vAt(30_000).toFixed(2)} m/s (learned pace 6)`);
}

// ── 3. braking INTO a stop, not at it ───────────────────────────────────────
{
  // Target curve that runs at 9 m/s and then stops dead at +60 s — exactly the
  // step function the owner saw as an instant brake on a real phone.
  const r: TrackPoint[] = Array.from({ length: 13 }, (_, k) => ({
    t: T0 + k * 10_000,
    s: 1000 + Math.min(k, 6) * 90,
  }));
  const b = buildV2Vehicle({
    key: 'G', tripId: 't1', line: '22', anchorMs: T0 - 5000, emittedAtMs: T0,
    raw: r, modal: null, prev: null,
  })!;
  contract('braking/opinion', b.vehicle.opinion, T0);
  const vAt = (d: number) => speedAt(b.opinion, T0 + d);
  // 9 m/s needs 9²/(2·1.4) = 28.9 m and 6.4 s to shed, so a tram braking on
  // the physical envelope is STILL AT PACE at +55 s and starts at ~+57 — that
  // is the calibrated "brake into stops later and harder" behaviour, not a
  // late brake. What must never happen again is pace → 0 at a single knot.
  check('braking: brakes on the envelope, starting before the stop instant',
    vAt(55_000) > 8 && vAt(58_000) < vAt(55_000) && vAt(60_000) < 0.75 * vAt(55_000),
    `v at +50/+55/+58/+60 s = ${[50, 55, 58, 60].map((s) => vAt(s * 1000).toFixed(2)).join('/')} m/s`);
  check('braking: takes a physically correct time to stop, then stays stopped',
    vAt(66_000) < 0.6 && Math.abs(evalTrack(b.vehicle.opinion, T0 + 90_000) - evalTrack(b.vehicle.opinion, T0 + 115_000)) < 1,
    `v at +64/+66 s = ${vAt(64_000).toFixed(2)}/${vAt(66_000).toFixed(2)} m/s`);
  check('braking: stops AT the platform, not past it',
    Math.abs(evalTrack(b.vehicle.opinion, T0 + 115_000) - 1540) < 6,
    `${evalTrack(b.vehicle.opinion, T0 + 115_000).toFixed(1)} m vs target 1540 m`);
}

// ── 4. continuity, rendered position BEHIND the opinion ─────────────────────
{
  const prev0 = buildV2Vehicle({
    key: 'C', tripId: 't1', line: '22', anchorMs: T0 - 45_000, emittedAtMs: T0 - 40_000,
    raw: raw(900, 8, T0 - 40_000), modal: null, prev: null,
  })!;
  const sStart = evalTrack(prev0.vehicle.smooth, T0); // ≈ 900 + 8·40 = 1220
  const r = raw(1300, 8);                             // fresh opinion jumped ahead 80 m
  const b = buildV2Vehicle({
    key: 'C', tripId: 't1', line: '22', anchorMs: T0 - 5000, emittedAtMs: T0,
    raw: r, modal: null, prev: { tripId: 't1', smooth: prev0.smooth, opinion: prev0.opinion },
  })!;
  const v = b.vehicle;
  contract('behind/smooth', v.smooth, T0);
  check('behind: smooth starts exactly where the previous track had the tram',
    Math.abs(evalTrack(v.smooth, T0) - sStart) <= 2,
    `Δ=${(evalTrack(v.smooth, T0) - sStart).toFixed(3)} m`);
  check('behind: 80 m gap essentially closed by +30 s (legally closable)',
    Math.abs(evalTrack(v.smooth, T0 + 30_000) - evalTrack(v.opinion, T0 + 30_000)) < 5,
    `Δ=${(evalTrack(v.smooth, T0 + 30_000) - evalTrack(v.opinion, T0 + 30_000)).toFixed(2)} m of 80 m`);
  check('behind: still together long after convergence',
    Math.abs(evalTrack(v.smooth, T0 + 90_000) - evalTrack(v.opinion, T0 + 90_000)) < 1.5,
    `Δ=${(evalTrack(v.smooth, T0 + 90_000) - evalTrack(v.opinion, T0 + 90_000)).toFixed(2)} m`);
  // The build-13 complaint: the old blend closed the gap at whatever speed the
  // arithmetic implied. Now it is a drive, so the catch-up speed is bounded.
  const catchUp = Math.max(...Array.from({ length: 30 }, (_, i) => speedAt(b.smooth, T0 + i * 1000)));
  check('behind: catch-up speed stays under V_MAX', catchUp <= TRAJ_V_MAX_MS + 1e-9,
    `peak ${catchUp.toFixed(2)} m/s vs V_MAX ${TRAJ_V_MAX_MS}`);
  check('behind: no discontinuity flagged', !v.discontinuity);
}

// ── 5. a gap that CANNOT be closed legally in 30 s ⇒ the window extends ─────
{
  // Rendered 145 m behind (just inside the discontinuity threshold) while the
  // opinion is already running at 15 m/s: closing that in 30 s would need
  // ~20 m/s. The contract says the window extends; the limits do not.
  const prev0 = buildV2Vehicle({
    key: 'H', tripId: 't1', line: '22', anchorMs: T0 - 45_000, emittedAtMs: T0 - 40_000,
    raw: raw(3000, 0.1, T0 - 40_000), modal: null, prev: null,
  })!;
  const sStart = evalTrack(prev0.vehicle.smooth, T0);
  const b = buildV2Vehicle({
    key: 'H', tripId: 't1', line: '22', anchorMs: T0 - 5000, emittedAtMs: T0,
    raw: raw(sStart + 145, 15), modal: null,
    prev: { tripId: 't1', smooth: prev0.smooth, opinion: prev0.opinion },
  })!;
  const v = b.vehicle;
  contract('extended/smooth', v.smooth, T0);
  check('extended: not a discontinuity (gap < 150 m)', !v.discontinuity);
  const peak = Math.max(...Array.from({ length: 121 }, (_, i) => speedAt(b.smooth, T0 + i * 1000)));
  check('extended: NEVER exceeds V_MAX to make the 30 s bound',
    peak <= TRAJ_V_MAX_MS + 1e-9, `peak ${peak.toFixed(2)} m/s`);
  const at30 = Math.abs(evalTrack(v.smooth, T0 + 30_000) - evalTrack(v.opinion, T0 + 30_000));
  const at120 = Math.abs(evalTrack(v.smooth, T0 + 120_000) - evalTrack(v.opinion, T0 + 120_000));
  check('extended: window EXTENDS — still converging at 30 s, closer later',
    at120 < at30, `gap ${at30.toFixed(1)} m at +30 s → ${at120.toFixed(1)} m at +120 s`);
}

// ── 6. rendered position AHEAD of the opinion (never reverse) ───────────────
{
  const prev0 = buildV2Vehicle({
    key: 'D', tripId: 't1', line: '22', anchorMs: T0 - 45_000, emittedAtMs: T0 - 40_000,
    raw: raw(1400, 8, T0 - 40_000), modal: null, prev: null,
  })!;
  const sStart = evalTrack(prev0.vehicle.smooth, T0); // ≈ 1720
  const b = buildV2Vehicle({
    key: 'D', tripId: 't1', line: '22', anchorMs: T0 - 5000, emittedAtMs: T0,
    raw: raw(1650, 8), modal: null,
    prev: { tripId: 't1', smooth: prev0.smooth, opinion: prev0.opinion },
  })!;
  const v = b.vehicle;
  contract('ahead/smooth', v.smooth, T0);
  check('ahead: smooth starts at the rendered position',
    Math.abs(evalTrack(v.smooth, T0) - sStart) <= 2);
  check('ahead: NEVER reverses to converge',
    v.smooth.every((p, i) => i === 0 || p.s >= v.smooth[i - 1].s));
  check('ahead: slows down instead of freezing (trams cannot stop instantly)',
    speedAt(b.smooth, T0 + 5_000) < speedAt(b.smooth, T0),
    `v ${speedAt(b.smooth, T0).toFixed(2)} → ${speedAt(b.smooth, T0 + 5_000).toFixed(2)} m/s`);
  check('ahead: follows the opinion once it has caught up',
    Math.abs(evalTrack(v.smooth, T0 + 90_000) - evalTrack(v.opinion, T0 + 90_000)) < 5,
    `Δ=${(evalTrack(v.smooth, T0 + 90_000) - evalTrack(v.opinion, T0 + 90_000)).toFixed(2)} m`);
  check('ahead: no discontinuity flagged', !v.discontinuity);
}

// ── 7. discontinuities ──────────────────────────────────────────────────────
{
  const prev0 = buildV2Vehicle({
    key: 'E', tripId: 't1', line: '22', anchorMs: T0 - 45_000, emittedAtMs: T0 - 40_000,
    raw: raw(1000, 8, T0 - 40_000), modal: null, prev: null,
  })!; // ⇒ ≈1320 at T0
  const prev = { tripId: 't1', smooth: prev0.smooth, opinion: prev0.opinion };
  const v = buildV2Vehicle({
    key: 'E', tripId: 't1', line: '22', anchorMs: T0 - 5000, emittedAtMs: T0,
    raw: raw(1600, 8), modal: null, prev,
  })!.vehicle;
  check('break >150 m ⇒ discontinuity + smooth starts AT opinion',
    v.discontinuity && evalTrack(v.smooth, T0) === evalTrack(v.opinion, T0));

  const w = buildV2Vehicle({
    key: 'E', tripId: 't2', line: '22', anchorMs: T0 - 5000, emittedAtMs: T0,
    raw: raw(1330, 8), modal: null, prev,
  })!.vehicle;
  check('trip change ⇒ discontinuity even when the numbers are close',
    w.discontinuity && evalTrack(w.smooth, T0) === evalTrack(w.opinion, T0));
}

// ── 8. modal + continuity together (the real at-stop case) ──────────────────
{
  const releaseAtMs = modalReleaseMs(T0, 5, 24, 10);
  const prev0 = buildV2Vehicle({ // crawling toward the stop
    key: 'F', tripId: 't1', line: '22', anchorMs: T0 - 45_000, emittedAtMs: T0 - 40_000,
    raw: raw(4980, 0.4, T0 - 40_000), modal: null, prev: null,
  })!;
  const b = buildV2Vehicle({
    key: 'F', tripId: 't1', line: '22', anchorMs: T0 - 5000, emittedAtMs: T0,
    raw: raw(5000, 3), modal: {
      stopS: 5000, releaseAtMs,
      walk: (t) => 5000 + Math.max(0, (t - releaseAtMs) / 1000) * 6,
    },
    prev: { tripId: 't1', smooth: prev0.smooth, opinion: prev0.opinion },
  })!;
  const v = b.vehicle;
  contract('modal+continuity/smooth', v.smooth, T0);
  check('modal+continuity: smooth honours the previous render',
    Math.abs(evalTrack(v.smooth, T0) - evalTrack(prev0.vehicle.smooth, T0)) <= 2);
  check('modal+continuity: the blend never floats PAST the platform pre-release',
    [0, 5_000, 10_000, 20_000, 21_000].every((d) => evalTrack(v.smooth, T0 + d) <= 5000.5),
    `+21 s: ${evalTrack(v.smooth, T0 + 21_000).toFixed(2)} m (stop 5000, release +${((releaseAtMs - T0) / 1000).toFixed(1)} s)`);
  check('modal+continuity: on the platform when the hold is still on',
    Math.abs(evalTrack(v.smooth, releaseAtMs) - 5000) < 2,
    `${evalTrack(v.smooth, releaseAtMs).toFixed(2)} m`);
  check('modal+continuity: leaves with the opinion, not before it',
    evalTrack(v.smooth, releaseAtMs + 30_000) <= evalTrack(v.opinion, releaseAtMs + 30_000) + 2);
}

// ── 9. velocity continuity across a seam (C¹, not just C⁰) ──────────────────
{
  const prev0 = buildV2Vehicle({
    key: 'I', tripId: 't1', line: '22', anchorMs: T0 - 45_000, emittedAtMs: T0 - 40_000,
    raw: raw(2000, 9, T0 - 40_000), modal: null, prev: null,
  })!;
  const vBefore = speedAt(prev0.smooth, T0);
  const b = buildV2Vehicle({
    key: 'I', tripId: 't1', line: '22', anchorMs: T0 - 5000, emittedAtMs: T0,
    raw: raw(evalTrack(prev0.vehicle.smooth, T0) + 5, 9), modal: null,
    prev: { tripId: 't1', smooth: prev0.smooth, opinion: prev0.opinion },
  })!;
  check('seam: the new track starts at the OLD track\'s speed',
    Math.abs(speedAt(b.smooth, T0) - vBefore) < 1e-9,
    `${vBefore.toFixed(3)} → ${speedAt(b.smooth, T0).toFixed(3)} m/s`);
}

// ── 10. evaluator purity ────────────────────────────────────────────────────
{
  const r = raw(1000, 8);
  const a = [T0 - 99, T0 + 12_345, T0 + 119_999, T0 + 500_000].map((t) => evalTrack(r, t));
  const c = [T0 - 99, T0 + 12_345, T0 + 119_999, T0 + 500_000].map((t) => evalTrack(r, t));
  check('evalTrack is pure + clamps outside the horizon',
    a.every((x, i) => Object.is(x, c[i])) && a[0] === 1000 && a[3] === r[12].s);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
