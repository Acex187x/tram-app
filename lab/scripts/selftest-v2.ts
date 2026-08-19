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

import type { RouteGeometry, RouteStop } from '@/lib/types';
import { cumulativeDistances, pointAt } from '@/lib/geo/polyline';
import {
  TRAJ_A_ACC_GATE,
  TRAJ_A_BRK_GATE,
  TRAJ_J_GATE,
  TRAJ_J_MAX,
  TRAJ_V_MAX_GATE_MS,
  TRAJ_V_MAX_MS,
} from '../src/config';
import {
  buildDriveVehicle,
  curveEnvAt,
  discThresholdM,
  driveProfileFor,
  legKinFloorS,
  mlCrossingMs,
  mlTailPace,
  seamSpeedCap,
  type DriveBuilt,
  type DriveSurfaces,
} from '../src/drive';
import { readJerk, readRealism } from '../src/realism';
import {
  accelAt,
  buildV2Vehicle,
  clientProjectionM,
  evalTrack,
  modalReleaseMs,
  speedAt,
  type KinTrack,
  type TrackPoint,
} from '../src/trajectory';

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

// ═════════════════════════════════════════════════════════════════════════════
// curvegen-v3: the virtual-tram drive (lab/src/drive.ts, design
// docs/research/curvegen-v3-design.md). Pure offline: synthetic geometry,
// constant learned surfaces — the suite asserts the CONTRACT and the design's
// mechanisms (curve braking, ML-as-timetable, C¹⁺ seams, regimes, T_disc),
// never the model. G4 is recomputed here independently from the geometry via
// the imported curve-envelope math (sanctioned by design §8: selftest may
// import the speed profile for curve checks).
// ═════════════════════════════════════════════════════════════════════════════

/** Synthetic shape in local meters → lng/lat around Prague: straight east,
 *  optionally a quarter turn of radius `curveR` at `curveAtM` (a tight
 *  junction curve), then straight north. Vertices every ~8 m. */
function synthGeometry(opts: {
  totalM: number;
  curveAtM?: number;
  curveR?: number;
  stops?: { atM: number; id: string }[];
}): RouteGeometry {
  const LAT0 = 50.08;
  const LNG0 = 14.4;
  const M_LAT = 111_195;
  const M_LNG = M_LAT * Math.cos((LAT0 * Math.PI) / 180);
  const pts: [number, number][] = [];
  const R = opts.curveR ?? 25;
  const cAt = opts.curveAtM ?? Infinity;
  const arcLen = (Math.PI / 2) * R;
  let d = 0;
  while (d <= opts.totalM) {
    let x: number;
    let y: number;
    if (d <= cAt) {
      x = d;
      y = 0;
    } else if (d <= cAt + arcLen) {
      const phi = (d - cAt) / R; // 0 → π/2
      x = cAt + R * Math.sin(phi);
      y = R * (1 - Math.cos(phi));
    } else {
      x = cAt + R;
      y = R + (d - cAt - arcLen);
    }
    pts.push([LNG0 + x / M_LNG, LAT0 + y / M_LAT]);
    d += d > cAt - 20 && d < cAt + arcLen + 20 ? 4 : 8;
  }
  const cumDistM = cumulativeDistances(pts);
  const totalM = cumDistM[cumDistM.length - 1];
  const stops: RouteStop[] = (opts.stops ?? []).map((s, i) => ({
    stopId: s.id,
    name: s.id,
    sequence: i + 1,
    coordinates: pointAt(pts, cumDistM, Math.min(s.atM, totalM)),
    distM: Math.min(s.atM, totalM),
    arrivalMs: 0,
    departureMs: 0,
    dwellSeconds: 0,
    isTerminal: false,
  }));
  return {
    shapeId: 'synth', tripId: 'tSynth', routeId: 'L22', line: '22', headsign: 'Test',
    coordinates: pts, cumDistM, totalM, stops,
  };
}

/** Constant learned surfaces. Dwell stub is TRUSTED with mean > the §14.2
 *  request bar (busy-stop semantics), so plan stops are served unless a test
 *  opts into the skippable class via `surfSkippable`. sd = mean/4 ⇒ p10/p90 ≈
 *  mean ∓ 0.32·mean under the drive's Normal quantiles. */
const surf = (paceMs: number, dwellS = 20): DriveSurfaces => ({
  paceAt: () => paceMs,
  dwellStats: () => ({ mean: dwellS, sd: dwellS * 0.25, trusted: true }),
});
/** §14.2 skippable class: no trusted dwell evidence (rare-holds stop). */
const surfSkippable = (paceMs: number): DriveSurfaces => ({
  paceAt: () => paceMs,
  dwellStats: () => ({ mean: 18, sd: 7.2, trusted: false }),
});

/** Wire contract + kinematic limits + the v3 jerk gate + generator meta. */
function driveContract(name: string, b: DriveBuilt): void {
  for (const tr of ['opinion', 'smooth'] as const) {
    contract(`${name}/${tr}`, b.vehicle[tr], b.vehicle.emittedAtMs);
    const jerks = readJerk(b.vehicle[tr]).map(Math.abs);
    const jMax = jerks.length > 0 ? Math.max(...jerks) : 0;
    check(`${name}/${tr}: wire jerk ≤ J_GATE ${TRAJ_J_GATE}`, jMax <= TRAJ_J_GATE,
      `max |jerk| = ${jMax.toFixed(3)} m/s³ over ${jerks.length} samples`);
  }
  check(`${name}: no generator curve violations (G4) / phantom dips (G7)`,
    b.meta.opinion.curveViolations === 0 && b.meta.smooth.curveViolations === 0 &&
    b.meta.opinion.phantomDips === 0 && b.meta.smooth.phantomDips === 0,
    `G4 ${b.meta.opinion.curveViolations}/${b.meta.smooth.curveViolations}, ` +
    `G7 ${b.meta.opinion.phantomDips}/${b.meta.smooth.phantomDips}`);
  check(`${name}: no model-invented mid-segment stops (G11) / collisions (G12)`,
    b.meta.opinion.midSegmentStops === 0 && b.meta.smooth.midSegmentStops === 0 &&
    b.meta.opinion.collisionViolations === 0 && b.meta.smooth.collisionViolations === 0,
    `G11 ${b.meta.opinion.midSegmentStops}/${b.meta.smooth.midSegmentStops}, ` +
    `G12 ${b.meta.opinion.collisionViolations}/${b.meta.smooth.collisionViolations}`);
}

/** Independent G4 recompute from the geometry (design §8, G4 second column). */
function checkCurveGate(name: string, geom: RouteGeometry, track: TrackPoint[]): void {
  const profile = driveProfileFor(geom);
  let worstExcess = -Infinity;
  let violations = 0;
  for (let i = 1; i < track.length; i++) {
    const dtS = (track[i].t - track[i - 1].t) / 1000;
    if (dtS <= 0) continue;
    const vSeg = (track[i].s - track[i - 1].s) / dtS;
    const cap = curveEnvAt(profile, geom, (track[i].s + track[i - 1].s) / 2);
    const excess = vSeg - (cap * 1.05 + 0.3);
    if (excess > worstExcess) worstExcess = excess;
    if (excess > 0) violations++;
  }
  check(`${name}: G4 recomputed from geometry — 0 violations`, violations === 0,
    `worst excess ${worstExcess.toFixed(2)} m/s`);
}

const mkDrive = (over: Partial<Parameters<typeof buildDriveVehicle>[0]> &
  Pick<Parameters<typeof buildDriveVehicle>[0], 'raw' | 'geom' | 'surfaces'>): DriveBuilt => {
  const b = buildDriveVehicle({
    key: 'V', tripId: 'tSynth', line: '22', anchorMs: T0 - 5000, emittedAtMs: T0,
    modal: null, prev: null, fixGapS: 30, ...over,
  });
  if (b === null) throw new Error('buildDriveVehicle returned null');
  return b;
};

// ── D0. adapter primitives ──────────────────────────────────────────────────
{
  const r = raw(1000, 6);
  const tau = mlCrossingMs(r, 1300);
  check('drive/adapter: ML crossing time of a monotone curve', tau !== null && Math.abs(tau - (T0 + 50_000)) < 20,
    `τ(1300) = +${tau === null ? '∅' : ((tau - T0) / 1000).toFixed(1)}s (expect +50s)`);
  check('drive/adapter: tail pace = mean slope of the last 30 s', Math.abs(mlTailPace(r) - 6) < 1e-9);
  check('drive/adapter: never-crossed stop ⇒ null', mlCrossingMs(r, 1e9) === null);
  const tk = legKinFloorS(100, 0, 0);
  check('drive/adapter: kinematic floor — 100 m stop-to-stop ≈ 19 s S-curve', Math.abs(tk - 19) < 1.2,
    `${tk.toFixed(1)}s`);
  check('drive/adapter: T_disc policy values (2026-08-17 deviation: 300/900/1.1)',
    Math.abs(discThresholdM(60, 5.5) - 363) < 1e-6 && discThresholdM(0, 1) === 300 &&
    discThresholdM(1e6, 100) === 900,
    `T_disc(60s, 5.5) = ${discThresholdM(60, 5.5)}`);
}

// ── D1. straight drive tracks the ML timetable ──────────────────────────────
{
  const geom = synthGeometry({ totalM: 4000 });
  const b = mkDrive({ raw: raw(1000, 8), geom, surfaces: surf(8) });
  driveContract('drive/straight', b);
  const worst = Math.max(...[30_000, 60_000, 120_000].map((d) =>
    Math.abs(evalTrack(b.vehicle.opinion, T0 + d) - evalTrack(raw(1000, 8), T0 + d))));
  check('drive/straight: an unconstrained leg lands with the ML timetable', worst < 25,
    `worst |drive − M| = ${worst.toFixed(1)} m (trim equilibrium ≈ 18 m)`);
  check('drive/straight: few knots on a constant-pace stretch', b.vehicle.opinion.length <= 6,
    `${b.vehicle.opinion.length} pts`);
}

// ── D2. braking INTO a tight curve — the headline perceptual fix ────────────
{
  const geom = synthGeometry({ totalM: 4000, curveAtM: 1500, curveR: 25 });
  const b = mkDrive({ raw: raw(1000, 9), geom, surfaces: surf(9) });
  driveContract('drive/curve', b);
  checkCurveGate('drive/curve', geom, b.vehicle.opinion);
  // curveCap(1/25) = 0.85·√(0.98·25) ≈ 4.2 m/s; the drive must dip into it
  // with S-curve shoulders, then re-accelerate.
  const k = b.opinion;
  const speedNear = (sLo: number, sHi: number): number => {
    let m = Infinity;
    for (let i = 0; i < k.points.length; i++) {
      if (k.points[i].s >= sLo && k.points[i].s <= sHi) m = Math.min(m, k.v[i]);
    }
    return m;
  };
  const dip = speedNear(1450, 1620);
  check('drive/curve: dips to the curve cap at the junction (≈4.2 m/s)', dip < 4.7 && dip > 1.0,
    `min knot speed in the curve zone = ${dip.toFixed(2)} m/s`);
  const before = Math.max(...k.v.filter((_, i) => k.points[i].s < 1300));
  const after = Math.max(...k.v.filter((_, i) => k.points[i].s > 1800));
  check('drive/curve: at pace before, back at pace after', before > 7 && after > 7,
    `${before.toFixed(1)} → dip → ${after.toFixed(1)} m/s`);
}

// ── D3. downstream stop is SERVED; §14.1 hierarchy absorbs ML pressure ──────
{
  const geom = synthGeometry({ totalM: 4000, stops: [{ atM: 500, id: 'S1' }, { atM: 2600, id: 'S2' }] });
  // The learned surface says 4 m/s (arrival would be +100 s); the ML curve
  // runs 6 m/s (τ = +66.7 s). v3.1 doctrine (§14.1): the pressure is absorbed
  // FIRST by shrinking the dwell toward p10 (20 → 13.6 s), then by the ±20 %
  // pace band (≤ 4.8 m/s, ±15 % trim on top) — the drive lands between the
  // ML clock and the learned clock, never at either extreme.
  const b = mkDrive({ raw: raw(100, 6), geom, surfaces: surf(4, 20) });
  driveContract('drive/stop', b);
  const o = b.vehicle.opinion;
  // Arrival: first instant the curve is within 3 m of the platform.
  let tArr: number | null = null;
  let tDep: number | null = null;
  for (let dt = 0; dt <= 120_000; dt += 1000) {
    const s = evalTrack(o, T0 + dt);
    if (tArr === null && s >= 500 - 3) tArr = dt / 1000;
    if (tArr !== null && tDep === null && s > 500 + 3) tDep = dt / 1000;
  }
  const tauS = (mlCrossingMs(raw(100, 6), 500)! - T0) / 1000; // +66.7 s
  check('drive/stop: arrival between the ML clock and the learned clock (§14.1 band)',
    tArr !== null && tArr >= tauS - 5 && tArr <= 88,
    `arrived +${tArr}s; τ = +${tauS.toFixed(1)}s, learned-pace arrival would be +100s`);
  // The ±3 m stand window includes ~6 s of brake-in/accel-out tails on top of
  // the dwell budget: p10 13.6 measures ≈ 20 s, an unshrunk p50 20 ≈ 26 s.
  check('drive/stop: dwell shrunk toward p10 to absorb the ML pressure (§14.1)',
    tArr !== null && tDep !== null && tDep - tArr >= 14 && tDep - tArr <= 23,
    `stood ${(tDep ?? 0) - (tArr ?? 0)}s (dwell budget p10 ≈ 13.6, p50 20)`);
  check('drive/stop: stops AT the platform, not past it',
    tArr !== null && tDep !== null &&
      Math.abs(evalTrack(o, T0 + (tArr + ((tDep - tArr) / 2)) * 1000) - 500) <= 2.5);
}

// ── D4. modal anchor hold: flat, then an S-curve departure ──────────────────
{
  const geom = synthGeometry({ totalM: 4000, stops: [{ atM: 1450, id: 'S1' }] });
  const releaseAtMs = modalReleaseMs(T0, 0, 20, 8); // ≈ +22 s
  const b = mkDrive({
    raw: raw(1000, 4), geom, surfaces: surf(6, 20),
    modal: { stopS: 1000, releaseAtMs },
  });
  driveContract('drive/modal', b);
  check('drive/modal: HOLDS at the platform until the modal release',
    [0, 5_000, 10_000, 20_000].every((d) => evalTrack(b.vehicle.opinion, T0 + d) === 1000));
  const vAt = (d: number): number => speedAt(b.opinion, releaseAtMs + d);
  check('drive/modal: departure is a jerk-limited RAMP',
    vAt(0) < 0.05 && vAt(3_000) > 0.5 && vAt(3_000) < 4 && vAt(25_000) > 3,
    `v at release +0/+3/+25 s = ${[0, 3, 25].map((s) => vAt(s * 1000).toFixed(2)).join('/')}`);
}

// ── D5. C¹⁺ seam: speed AND acceleration carry over under J_MAX ─────────────
{
  const geom = synthGeometry({ totalM: 4000 });
  const releaseAtMs = T0 - 14_000 + 10_000; // released 4 s before the new emission
  const prev = mkDrive({
    raw: raw(1000, 8, T0 - 14_000), geom, surfaces: surf(8),
    emittedAtMs: T0 - 14_000, anchorMs: T0 - 19_000,
    modal: { stopS: 1000, releaseAtMs },
  });
  const vSeam = speedAt(prev.opinion, T0);
  const aSeam = accelAt(prev.opinion, T0);
  check('drive/seam: the previous track is mid-ramp at the seam (test setup)', vSeam > 1 && aSeam > 0.3,
    `v=${vSeam.toFixed(2)} m/s, a=${aSeam.toFixed(2)} m/s²`);
  const next = mkDrive({
    raw: raw(evalTrack(prev.vehicle.opinion, T0) + 4, 8), geom, surfaces: surf(8),
    prev: { tripId: 'tSynth', smooth: prev.smooth, opinion: prev.opinion },
  });
  driveContract('drive/seam', next);
  check('drive/seam: opinion starts at the previous opinion speed (C¹)',
    Math.abs(speedAt(next.opinion, T0) - vSeam) < 1e-9,
    `${vSeam.toFixed(3)} → ${speedAt(next.opinion, T0).toFixed(3)} m/s`);
  const k = next.opinion;
  const firstPhaseDtS = (k.points[1].t - k.points[0].t) / 1000;
  const aFirst = (k.v[1] - k.v[0]) / firstPhaseDtS;
  check('drive/seam: seam acceleration transitions under J_MAX (C¹⁺)',
    Math.abs(aFirst - aSeam) <= TRAJ_J_MAX * firstPhaseDtS + 1e-6,
    `a ${aSeam.toFixed(2)} → first phase ${aFirst.toFixed(2)} m/s² over ${firstPhaseDtS}s`);
}

// ── D6. smooth regimes: catch-up is decisive AND ceiling-bounded ────────────
{
  const geom = synthGeometry({ totalM: 6000 });
  const prev = mkDrive({
    raw: raw(1000, 6, T0 - 40_000), geom, surfaces: surf(6),
    emittedAtMs: T0 - 40_000, anchorMs: T0 - 45_000,
  });
  const sSeam = evalTrack(prev.vehicle.smooth, T0);
  const b = mkDrive({
    raw: raw(sSeam + 80, 6), geom, surfaces: surf(6), fixGapS: 40,
    prev: { tripId: 'tSynth', smooth: prev.smooth, opinion: prev.opinion },
  });
  driveContract('drive/catchup', b);
  check('drive/catchup: 80 m gap is NOT a discontinuity under T_disc', !b.vehicle.discontinuity,
    `T_disc = ${b.meta.tDiscM?.toFixed(0)} m`);
  check('drive/catchup: smooth starts at the previous render (≤2 m)',
    Math.abs(evalTrack(b.vehicle.smooth, T0) - sSeam) <= 2);
  let convS: number | null = null;
  for (let dt = 0; dt <= 120; dt++) {
    if (Math.abs(evalTrack(b.vehicle.smooth, T0 + dt * 1000) - evalTrack(b.vehicle.opinion, T0 + dt * 1000)) < 15) {
      convS = dt;
      break;
    }
  }
  check('drive/catchup: decisive — 80 m gap inside 15 m within ≤ 28 s (G5)',
    convS !== null && convS <= 28, `converged at +${convS}s`);
  const peak = Math.max(...b.smooth.v);
  check('drive/catchup: never above the observed-pace ceiling 1.9×pace',
    peak <= 1.9 * 6 + 1e-9, `peak ${peak.toFixed(2)} ≤ ${(1.9 * 6).toFixed(1)} m/s`);
  // G6: no hunting after convergence.
  let sign = 0;
  let osc = 0;
  for (let dt = convS ?? 0; dt <= 120; dt++) {
    const d = evalTrack(b.vehicle.smooth, T0 + dt * 1000) - evalTrack(b.vehicle.opinion, T0 + dt * 1000);
    if (d > 2) { if (sign < 0) osc++; sign = 1; }
    else if (d < -2) { if (sign > 0) osc++; sign = -1; }
  }
  check('drive/catchup: converge, settle, no hunting (G6 ≤ 1)', osc <= 1, `${osc} sign flips`);
}

// ── D7. smooth regimes: yield-when-ahead — never a phantom mid-street stop ──
{
  const geom = synthGeometry({ totalM: 6000 });
  const prev = mkDrive({
    raw: raw(1000, 9, T0 - 40_000), geom, surfaces: surf(9),
    emittedAtMs: T0 - 40_000, anchorMs: T0 - 45_000,
  });
  const sSeam = evalTrack(prev.vehicle.smooth, T0); // ≈ 1360, running 9 m/s
  const b = mkDrive({
    raw: raw(sSeam - 70, 6), geom, surfaces: surf(6), fixGapS: 40,
    prev: { tripId: 'tSynth', smooth: prev.smooth, opinion: prev.opinion },
  });
  driveContract('drive/yield', b);
  check('drive/yield: 70 m ahead is NOT a discontinuity', !b.vehicle.discontinuity);
  const sm = b.smooth;
  const minV = Math.min(...sm.points.map((p, i) => (p.t <= T0 + 45_000 ? sm.v[i] : Infinity)));
  check('drive/yield: slows to the yield floor, never a dead stand mid-street',
    minV >= 2.8, `min v in the first 45 s = ${minV.toFixed(2)} m/s (floor 3.0)`);
  check('drive/yield: never reverses',
    b.vehicle.smooth.every((p, i, a) => i === 0 || p.s >= a[i - 1].s));
  const dLate = Math.abs(evalTrack(b.vehicle.smooth, T0 + 100_000) - evalTrack(b.vehicle.opinion, T0 + 100_000));
  check('drive/yield: opinion absorbs the lead and the tracks rejoin', dLate < 25,
    `Δ at +100 s = ${dLate.toFixed(1)} m`);
}

// ── D8. discontinuity policy: T_disc, not 150 m ─────────────────────────────
{
  const geom = synthGeometry({ totalM: 6000 });
  const prev = mkDrive({
    raw: raw(1000, 5.5, T0 - 40_000), geom, surfaces: surf(5.5),
    emittedAtMs: T0 - 40_000, anchorMs: T0 - 45_000,
  });
  const sSeam = evalTrack(prev.vehicle.smooth, T0);
  const prevRef = { tripId: 'tSynth', smooth: prev.smooth, opinion: prev.opinion };
  const at = (gapM: number): DriveBuilt =>
    mkDrive({ raw: raw(sSeam + gapM, 5.5), geom, surfaces: surf(5.5), fixGapS: 60, prev: prevRef });
  const b300 = at(300);
  check('drive/disc: 300 m < T_disc(60 s, 5.5) = 363 ⇒ DRIVEN OFF, not a teleport',
    !b300.vehicle.discontinuity && b300.meta.tDiscM !== null && Math.abs(b300.meta.tDiscM - 363) < 1e-6,
    `T_disc = ${b300.meta.tDiscM}`);
  driveContract('drive/disc-300', b300);
  const b500 = at(500);
  check('drive/disc: 500 m > T_disc ⇒ honest discontinuity, smooth = opinion',
    b500.vehicle.discontinuity && b500.meta.discKind === 'gap' &&
      evalTrack(b500.vehicle.smooth, T0) === evalTrack(b500.vehicle.opinion, T0));
  const bTrip = mkDrive({
    raw: raw(sSeam + 5, 5.5), geom, surfaces: surf(5.5), tripId: 'tOther', fixGapS: 60, prev: prevRef,
  });
  check('drive/disc: trip change ⇒ discontinuity even when the numbers are close',
    bTrip.vehicle.discontinuity && bTrip.meta.discKind === 'trip');
}

// ── D9. terminal latch ──────────────────────────────────────────────────────
{
  const geom = synthGeometry({ totalM: 1000 });
  const b = mkDrive({ raw: raw(800, 8), geom, surfaces: surf(8) });
  driveContract('drive/terminal', b);
  const end = evalTrack(b.vehicle.opinion, T0 + 119_000);
  check('drive/terminal: latches AT the geometry end, never past it',
    end <= geom.totalM + 1e-6 && end >= geom.totalM - 3,
    `final s = ${end.toFixed(1)} of ${geom.totalM.toFixed(1)} m`);
  check('drive/terminal: flat once latched',
    Math.abs(evalTrack(b.vehicle.opinion, T0 + 60_000) - end) < 1);
}

// ── D11. catch-up ceiling: dwell-contaminated slow bucket must not stall it ──
// The 2026-08-17 G5 root cause: paceAt at the SMOOTH's own position is the
// stop-zone bucket (dwell-contaminated, e.g. 1.6 m/s) at exactly the moments
// catch-up starts, and the lone-bucket ceiling 1.9×1.6 = 3.04 sat BELOW the
// reference's own speed — the smooth was commanded slower than the thing it
// chases. The reformed ceiling spans both ends of the corridor and never drops
// below vO + CATCH_DV_MIN.
{
  const geom = synthGeometry({ totalM: 6000 });
  const prev = mkDrive({
    raw: raw(1000, 6, T0 - 40_000), geom, surfaces: surf(6),
    emittedAtMs: T0 - 40_000, anchorMs: T0 - 45_000,
  });
  const sSeam = evalTrack(prev.vehicle.smooth, T0); // ≈ 1240, running 6 m/s
  const slowUntil = sSeam + 120;
  const surfaces: DriveSurfaces = {
    paceAt: (sM: number) => (sM < slowUntil ? 1.6 : 6),
    dwellAt: () => 20,
  };
  const b = mkDrive({
    raw: raw(sSeam + 100, 6), geom, surfaces, fixGapS: 40,
    prev: { tripId: 'tSynth', smooth: prev.smooth, opinion: prev.opinion },
  });
  driveContract('drive/slow-bucket', b);
  let convS: number | null = null;
  for (let dt = 0; dt <= 120; dt++) {
    if (Math.abs(evalTrack(b.vehicle.smooth, T0 + dt * 1000) - evalTrack(b.vehicle.opinion, T0 + dt * 1000)) < 15) {
      convS = dt;
      break;
    }
  }
  // ≤32 s: ramp + min(DV, g/T_CLOSE) demand has a first-order tail below
  // g = DV·T_CLOSE, so a full 100 m episode runs ~26–30 s even unclamped;
  // the OLD lone-bucket ceiling (1.9×1.6 = 3.04 < vO) took ~80 s on this
  // exact scenario — the bound discriminates the mechanism, not the noise.
  check('drive/slow-bucket: 100 m gap closes decisively THROUGH the slow cell',
    convS !== null && convS <= 32,
    `converged at +${convS ?? '∅'}s (lone-bucket ceiling would take ~80 s)`);
}

// ── D12. yield never outruns a crawling reference ───────────────────────────
// The 3.0 m/s yield floor is honest only while reality itself does ≥ 3.0;
// against a 2 m/s reference the old floor made the lead GROW (measured live:
// 21 % of yield steps commanded more than vO).
{
  const geom = synthGeometry({ totalM: 6000 });
  const prev = mkDrive({
    raw: raw(1000, 2, T0 - 40_000), geom, surfaces: surf(2),
    emittedAtMs: T0 - 40_000, anchorMs: T0 - 45_000,
  });
  const sSeam = evalTrack(prev.vehicle.smooth, T0); // crawling at ≈ 2 m/s
  const b = mkDrive({
    raw: raw(sSeam - 80, 2), geom, surfaces: surf(2), fixGapS: 40,
    prev: { tripId: 'tSynth', smooth: prev.smooth, opinion: prev.opinion },
  });
  driveContract('drive/yield-crawl', b);
  const gap0 = evalTrack(b.vehicle.smooth, T0) - evalTrack(b.vehicle.opinion, T0);
  const gap90 = evalTrack(b.vehicle.smooth, T0 + 90_000) - evalTrack(b.vehicle.opinion, T0 + 90_000);
  check('drive/yield-crawl: the lead never grows while ahead of a 2 m/s reality',
    gap90 <= gap0 + 5, `lead ${gap0.toFixed(0)} m → ${gap90.toFixed(0)} m at +90 s`);
  check('drive/yield-crawl: never reverses',
    b.vehicle.smooth.every((p, i, a) => i === 0 || p.s >= a[i - 1].s));
}

// ── D13. hot seam into a curve zone: the margin-aware seam cap (G4) ─────────
// A previous emission's CHORD speed at t_E can exceed the local curve envelope
// (legal on the wire at its own midpoint); importing it printed G4 violations
// decaying off the seam. The seam cap must bite BEFORE the sim starts.
{
  const geom = synthGeometry({ totalM: 4000, curveAtM: 1500, curveR: 25 });
  const prev = mkDrive({
    raw: raw(1350, 9, T0 - 16_000), geom, surfaces: surf(9),
    emittedAtMs: T0 - 16_000, anchorMs: T0 - 21_000,
  });
  const sSeam = evalTrack(prev.vehicle.smooth, T0);
  const chordAtSeam = speedAt(prev.smooth, T0);
  const b = mkDrive({
    raw: raw(sSeam + 8, 6), geom, surfaces: surf(6), fixGapS: 30,
    prev: { tripId: 'tSynth', smooth: prev.smooth, opinion: prev.opinion },
  });
  driveContract('drive/hot-seam', b);
  checkCurveGate('drive/hot-seam/opinion', geom, b.vehicle.opinion);
  checkCurveGate('drive/hot-seam/smooth', geom, b.vehicle.smooth);
  const cap = seamSpeedCap(driveProfileFor(geom), geom, sSeam, accelAt(prev.smooth, T0));
  check('drive/hot-seam: smooth seam speed obeys the margin-aware cap',
    speedAt(b.smooth, T0) <= Math.min(chordAtSeam, cap) + 1e-6,
    `inherited ${chordAtSeam.toFixed(2)} m/s, cap ${cap.toFixed(2)}, took ${speedAt(b.smooth, T0).toFixed(2)} ` +
    `(seam ${(1500 - sSeam).toFixed(0)} m before the curve apex)`);
}

// ── D10. knot budget under a dense-centre stop ladder ───────────────────────
{
  const geom = synthGeometry({
    totalM: 4000,
    stops: [300, 500, 700, 900, 1100].map((atM, i) => ({ atM, id: `S${i}` })),
  });
  const b = mkDrive({ raw: raw(100, 6), geom, surfaces: surf(6, 12) });
  driveContract('drive/dense', b);
  check('drive/dense: ≤24 knots with every platform served',
    b.vehicle.opinion.length <= 24 && b.vehicle.smooth.length <= 24,
    `knots ${b.vehicle.opinion.length}/${b.vehicle.smooth.length}, ` +
    `pressureDrops ${b.meta.opinion.pressureDrops}, budgetForced ${b.meta.opinion.budgetForced}`);
}

// ── D14. anchor floor (hotfix 2026-08-17): never behind fix / prev render ───
// Owner field report: the fixed track teleported BEHIND the latest fix. The
// fix is a hard floor (the tram was there and does not reverse): run.ts floors
// raw at the anchor fix (ML ds < 0 → 0), and a same-anchor AGE re-emission is
// additionally floored at the previously rendered opinion (backward nowcast
// jitter is not evidence). Both builders must honour ageFloorS.
{
  const fixS = 1000;
  // (a) floored raw ⇒ the monotone opinion can never start behind the fix.
  const bv = buildV2Vehicle({
    key: 'F', tripId: 't1', line: '22', anchorMs: T0 - 5000, emittedAtMs: T0,
    raw: raw(fixS, 8), modal: null, prev: null,
  })!;
  check('floor: current-gen opinion starts at/after the anchor fix',
    bv.vehicle.opinion[0].s >= fixS - 0.05, `opinion[0].s = ${bv.vehicle.opinion[0].s}`);

  // (b) age-refresh floor, current gen: same anchor, nowcast 50 m backward.
  const T1 = T0 + 60_000;
  const prevO = evalTrack(bv.vehicle.opinion, T1); // previously rendered position
  const bv2 = buildV2Vehicle({
    key: 'F', tripId: 't1', line: '22', anchorMs: T0 - 5000, emittedAtMs: T1,
    raw: raw(prevO - 50, 8, T1), modal: null, ageFloorS: prevO,
    prev: { tripId: 't1', smooth: bv.smooth, opinion: bv.opinion },
  })!;
  contract('floor/age/opinion', bv2.vehicle.opinion, T1);
  contract('floor/age/smooth', bv2.vehicle.smooth, T1);
  check('floor: age re-emission never falls behind the previously rendered opinion',
    bv2.vehicle.opinion[0].s >= prevO - 0.05 && bv2.ageFloorApplied,
    `opinion[0].s = ${bv2.vehicle.opinion[0].s.toFixed(1)}, floor ${prevO.toFixed(1)}, applied=${bv2.ageFloorApplied}`);
  check('floor: no floor ⇒ flag stays false (byte-stability witness)',
    !bv.ageFloorApplied);

  // (c) the same clauses on the v3 drive.
  const geom = synthGeometry({ totalM: 4000 });
  const d1 = mkDrive({ raw: raw(fixS, 8), geom, surfaces: surf(8) });
  check('floor: drive opinion starts at/after the anchor fix',
    d1.vehicle.opinion[0].s >= fixS - 0.05 && d1.meta.ageFloorApplied === false);
  const prevOD = evalTrack(d1.vehicle.opinion, T1);
  const d2 = mkDrive({
    raw: raw(prevOD - 50, 8, T1), geom, surfaces: surf(8), emittedAtMs: T1,
    ageFloorS: prevOD,
    prev: { tripId: 'tSynth', smooth: d1.smooth, opinion: d1.opinion },
  });
  driveContract('floor/age/drive', d2);
  check('floor: drive age re-emission floored at the previously rendered opinion',
    d2.vehicle.opinion[0].s >= prevOD - 0.05 && d2.meta.ageFloorApplied,
    `opinion[0].s = ${d2.vehicle.opinion[0].s.toFixed(1)}, floor ${prevOD.toFixed(1)}`);
}

// ── D15. §14.2 request-stop skip: evidence-gated, never random ──────────────
{
  const geom = synthGeometry({ totalM: 4000, stops: [{ atM: 500, id: 'REQ' }, { atM: 2600, id: 'S2' }] });
  // Skippable class (no trusted dwell evidence) + ML shows no dwell (constant
  // pace through the stop) ⇒ the platform is passed at pace, doors closed.
  const b = mkDrive({ raw: raw(100, 6), geom, surfaces: surfSkippable(6) });
  driveContract('drive/request-skip', b);
  check('drive/request-skip: the stop leaves the plan and is counted',
    b.meta.requestSkips.length === 1 && b.meta.requestSkips[0].stopId === 'REQ',
    JSON.stringify(b.meta.requestSkips));
  let tCross: number | null = null;
  for (let dt = 0; dt <= 120_000; dt += 500) {
    if (evalTrack(b.vehicle.opinion, T0 + dt) >= 500) { tCross = dt; break; }
  }
  const vThrough = tCross === null ? 0 :
    (evalTrack(b.vehicle.opinion, T0 + tCross + 3000) - evalTrack(b.vehicle.opinion, T0 + tCross - 3000)) / 6;
  check('drive/request-skip: rolls THROUGH the platform at pace (no stand)',
    tCross !== null && vThrough > 3, `v through the stop = ${vThrough.toFixed(2)} m/s`);
  // Control: trusted busy-stop evidence vetoes the skip even with the same ML.
  const c = mkDrive({ raw: raw(100, 6), geom, surfaces: surf(6, 20) });
  check('drive/request-skip: trusted long-dwell evidence vetoes the skip (serves)',
    c.meta.requestSkips.length === 0, JSON.stringify(c.meta.requestSkips));
}

// ── D16. §14.3 jam hold: evidence-backed mid-segment stand, smooth exit ─────
{
  const geom = synthGeometry({ totalM: 4000, stops: [{ atM: 1500, id: 'S1' }] });
  // Two flat fixes mid-segment (run.ts evidence) ⇒ stuckAtM = 600; the ML
  // nowcast says 620 and moving — reality wins, ML pressure suspended.
  const b = mkDrive({ raw: raw(620, 5), geom, surfaces: surf(5), stuckAtM: 600 });
  driveContract('drive/jam', b);
  check('drive/jam: holds AT the observed stuck position, not the ML nowcast',
    [0, 30_000, 60_000, 100_000].every((d) => Math.abs(evalTrack(b.vehicle.opinion, T0 + d) - 600) < 0.1),
    `s at +0/+60 s = ${evalTrack(b.vehicle.opinion, T0).toFixed(1)}/${evalTrack(b.vehicle.opinion, T0 + 60_000).toFixed(1)}`);
  check('drive/jam: classified jamHold, NOT a G11 violation',
    b.meta.jamHolding && b.meta.opinion.jamHolds >= 1 && b.meta.opinion.midSegmentStops === 0,
    `jamHolds ${b.meta.opinion.jamHolds}`);
  // Staleness release at anchor + 120 s (anchor = T0 − 5 s): departs by +119 s.
  check('drive/jam: staleness clock releases the hold with a smooth departure',
    speedAt(b.opinion, T0 + 119_000) > 0.3,
    `v at +119 s = ${speedAt(b.opinion, T0 + 119_000).toFixed(2)} m/s`);
}

// ── D17. §14.4 anti-collision: follower never passes through its leader ─────
{
  const geom = synthGeometry({ totalM: 6000 });
  const lead = mkDrive({ key: 'L', raw: raw(1300, 2), geom, surfaces: surf(2) });
  const gapM = 3 + 14.1;
  const leader = { key: 'L', opinion: lead.vehicle.opinion, smooth: lead.vehicle.smooth, gapM };
  const b = mkDrive({ raw: raw(1200, 8), geom, surfaces: surf(8), leader });
  driveContract('drive/queue', b); // includes G12 = 0
  let minClear = Infinity;
  for (let dt = 0; dt <= 120_000; dt += 1000) {
    minClear = Math.min(minClear,
      evalTrack(lead.vehicle.opinion, T0 + dt) - evalTrack(b.vehicle.opinion, T0 + dt));
  }
  check('drive/queue: follower stays ≥ gap behind the leader at every instant',
    minClear >= gapM - 1.0, `min clearance ${minClear.toFixed(1)} m (gap ${gapM.toFixed(1)})`);
  // Control: unconstrained, the same follower drives THROUGH the leader —
  // proving the scenario actually bites.
  const u = mkDrive({ raw: raw(1200, 8), geom, surfaces: surf(8) });
  let minClearU = Infinity;
  for (let dt = 0; dt <= 120_000; dt += 1000) {
    minClearU = Math.min(minClearU,
      evalTrack(lead.vehicle.opinion, T0 + dt) - evalTrack(u.vehicle.opinion, T0 + dt));
  }
  check('drive/queue: control without the constraint would collide', minClearU < 0,
    `unconstrained min clearance ${minClearU.toFixed(1)} m`);
}

// ── D17b. §14.4 inherited inversion: the seam hands the drive a follower ────
// already sitting PAST its leader's curve (its own fresh fix / modal hold /
// smooth continuity outranking an older leader curve). The old effLeader
// clipped the enforced gap to 0, which froze the overlap for the whole
// horizon AND counted it as ~120 s of G12 penetration. The schedule must
// instead read the seam as legal, repay the overlap, and never reverse.
{
  const geom = synthGeometry({ totalM: 6000 });
  const lead = mkDrive({ key: 'L', raw: raw(1200, 6), geom, surfaces: surf(6) });
  const gapM = 3 + 14.1;
  const leader = { key: 'L', opinion: lead.vehicle.opinion, smooth: lead.vehicle.smooth, gapM };
  // Follower's own fresh fix sits 3 m past the leader's curve at t_E. This is
  // the real inversion path: the §14.4 s0 clamp is FLOORED at the anchor fix
  // (G10 — a fix is evidence and outranks a model curve), so the clamp cannot
  // pull the seam back behind the leader and the drive starts inverted.
  const lead0 = evalTrack(lead.vehicle.opinion, T0);
  const b = mkDrive({
    raw: raw(lead0 + 3, 6),
    geom,
    surfaces: surf(6),
    leader,
    anchorFixS: lead0 + 3,
  });
  driveContract('drive/queue-inverted', b); // includes G12 = 0
  check('drive/queue-inverted: an inherited inversion is not counted as a collision',
    b.meta.opinion.collisionViolations === 0 && b.meta.smooth.collisionViolations === 0,
    `G12 ${b.meta.opinion.collisionViolations}/${b.meta.smooth.collisionViolations}, ` +
    `penAt0 ${b.meta.opinion.collisionPenAt0M} m, gap0 ${b.meta.opinion.collisionGapM} m`);
  const clearAt = (dt: number): number =>
    evalTrack(lead.vehicle.opinion, T0 + dt) - evalTrack(b.vehicle.opinion, T0 + dt);
  check('drive/queue-inverted: the overlap is repaid, not frozen',
    clearAt(60_000) > clearAt(0) + 10,
    `clearance ${clearAt(0).toFixed(1)} m at t_E → ${clearAt(60_000).toFixed(1)} m at +60 s`);
  // Never reverse: the repayment is a speed cap, so s stays monotone.
  const mono = b.vehicle.opinion.every((p, i) => i === 0 || p.s >= b.vehicle.opinion[i - 1].s - 1e-9);
  check('drive/queue-inverted: repayment never drives the follower backward', mono);
}

// ── D17c. …and a WIDE inversion (inside QUEUE_INVERT_MAX_M) is still clipped ─
// rather than dropped: at 5 m the constraint used to vanish, which is exactly
// where the 2026-08-19 probe found the real through-passing.
{
  const geom = synthGeometry({ totalM: 6000 });
  const lead = mkDrive({ key: 'L', raw: raw(1200, 6), geom, surfaces: surf(6) });
  const gapM = 3 + 14.1;
  const leader = { key: 'L', opinion: lead.vehicle.opinion, smooth: lead.vehicle.smooth, gapM };
  const lead0 = evalTrack(lead.vehicle.opinion, T0);
  const b = mkDrive({
    raw: raw(lead0 + 40, 6), geom, surfaces: surf(6), leader, anchorFixS: lead0 + 40,
  });
  driveContract('drive/queue-wide-inversion', b);
  check('drive/queue-wide-inversion: 40 m inverted still binds (leader not dropped)',
    b.meta.leaderKey === 'L' && !b.meta.leaderDroppedInverted && b.meta.opinion.collisionMeasured,
    `leaderKey ${b.meta.leaderKey}, dropped ${b.meta.leaderDroppedInverted}, gap0 ${b.meta.opinion.collisionGapM} m`);
  const clearAt = (dt: number): number =>
    evalTrack(lead.vehicle.opinion, T0 + dt) - evalTrack(b.vehicle.opinion, T0 + dt);
  check('drive/queue-wide-inversion: the band is repaid within one horizon',
    clearAt(120_000) > clearAt(0) + 40,
    `clearance ${clearAt(0).toFixed(1)} m at t_E → ${clearAt(120_000).toFixed(1)} m at +120 s`);
  check('drive/queue-wide-inversion: repayment never drives the follower backward',
    b.vehicle.opinion.every((p, i) => i === 0 || p.s >= b.vehicle.opinion[i - 1].s - 1e-9));
}

// ── D17d. §14.4 lapse: a leader whose prediction has RUN OUT is not a wall ──
// Emissions are staggered (median 15.6 s across the bundle, max 56 s measured
// 2026-08-19), so a follower's horizon routinely outlives its leader's.
// evalTrack freezes past the last knot, so the old code both braked for and
// counted penetration against a phantom parked at the leader's final position.
{
  const geom = synthGeometry({ totalM: 8000 });
  // Leader emitted 60 s ago ⇒ its curve ends at T0 + 60 s, the follower's at
  // T0 + 120 s. The last 60 s of the follower's horizon has no leader at all.
  const lead = mkDrive({
    key: 'L', raw: raw(2000, 6, T0 - 60_000), geom, surfaces: surf(6),
    emittedAtMs: T0 - 60_000, anchorMs: T0 - 65_000,
  });
  const gapM = 3 + 14.1;
  const leader = { key: 'L', opinion: lead.vehicle.opinion, smooth: lead.vehicle.smooth, gapM };
  const b = mkDrive({ raw: raw(1400, 6), geom, surfaces: surf(6), leader });
  driveContract('drive/queue-lapse', b);
  const leadEnd = lead.vehicle.opinion[lead.vehicle.opinion.length - 1].t;
  check('drive/queue-lapse: nothing is counted past the leader\'s last knot',
    b.meta.opinion.collisionViolations === 0 && b.meta.smooth.collisionViolations === 0,
    `G12 ${b.meta.opinion.collisionViolations}/${b.meta.smooth.collisionViolations}, ` +
    `leader ends +${((leadEnd - T0) / 1000).toFixed(0)}s, follower +120s`);
  // …and the drive keeps rolling after the lapse instead of braking for the
  // phantom: no invented stand in the unconstrained tail.
  const vTail = (evalTrack(b.vehicle.opinion, T0 + 110_000) - evalTrack(b.vehicle.opinion, T0 + 90_000)) / 20;
  check('drive/queue-lapse: the follower does not brake for the phantom',
    vTail > 3, `mean v over +90…110 s = ${vTail.toFixed(2)} m/s`);
}

// ── D18. §6/§14.1 creep: ahead of a standing reality — no phantom stand ─────
{
  const geom = synthGeometry({ totalM: 6000, stops: [{ atM: 1000, id: 'S1' }, { atM: 2000, id: 'S2' }] });
  const prev = mkDrive({
    raw: raw(1150, 6, T0 - 20_000), geom, surfaces: surf(6),
    emittedAtMs: T0 - 20_000, anchorMs: T0 - 25_000,
  });
  const sSeam = evalTrack(prev.vehicle.smooth, T0); // ≈ 1270 — mid-segment
  // Fresh at-stop fix pins the opinion at S1 (modal hold, +60 s): the smooth
  // is ~270 m AHEAD of a standing reality, far outside any stop zone.
  const b = mkDrive({
    raw: raw(1000, 0.5), geom, surfaces: surf(6),
    modal: { stopS: 1000, releaseAtMs: T0 + 60_000 },
    prev: { tripId: 'tSynth', smooth: prev.smooth, opinion: prev.opinion },
  });
  driveContract('drive/creep', b); // includes G11 = 0
  check('drive/creep: not a discontinuity (gap under T_disc floor)', !b.vehicle.discontinuity,
    `seam gap ${(sSeam - 1000).toFixed(0)} m, T_disc ${b.meta.tDiscM?.toFixed(0)}`);
  const adv = evalTrack(b.vehicle.smooth, T0 + 60_000) - evalTrack(b.vehicle.smooth, T0);
  check('drive/creep: creeps at traffic-column pace instead of standing mid-street',
    adv > 50 && adv < 130, `advanced ${adv.toFixed(0)} m in 60 s (creep 1.5 m/s ⇒ ~90)`);
}

// ── D19. §14.7 re-anchor seam rule: no backward swap the fix does not justify ─
// Owner field report 2026-08-18: a fresh fix arrives, the tram follows it,
// then ~5–10 s later the fixed marker FLIES BACKWARD and stands — the new
// emission re-anchored at nowcast ≈ fix + ds(latency), BEHIND where the
// previous curve was already rendering. Rule: when the newest fix cannot
// exclude the previous projection (prevO ≤ fix + fixAge·vObs + TOL), the new
// opinion STARTS AT it; a provable overshoot corrects honestly (≥ fix, G10);
// standing evidence (modal/jam) outranks continuity.
{
  // (a) drive, moving tram (vObs ≈ 6.9 m/s): continuity floor engages.
  const geom = synthGeometry({ totalM: 6000 });
  const prev = mkDrive({
    raw: raw(1000, 8, T0 - 30_000), geom, surfaces: surf(8),
    emittedAtMs: T0 - 30_000, anchorMs: T0 - 35_000,
  });
  const prevO = evalTrack(prev.vehicle.opinion, T0); // ≈ 1240
  const prevTk = { tripId: 'tSynth', smooth: prev.smooth, opinion: prev.opinion };
  const b = mkDrive({
    raw: raw(1190, 8), geom, surfaces: surf(8), emittedAtMs: T0, anchorMs: T0 - 9_000,
    anchorFixS: 1180, prevFixS: 1000, fixGapS: 26, prev: prevTk,
  });
  driveContract('drive/seam-rule', b);
  check('drive/seam-rule: consistent prev projection ⇒ continuity, no backward step',
    b.vehicle.opinion[0].s >= prevO - 0.05 && b.meta.seamFloorApplied,
    `opinion[0].s = ${b.vehicle.opinion[0].s.toFixed(1)}, prevO ${prevO.toFixed(1)}, ` +
    `nowcast would be 1190 (${(prevO - 1190).toFixed(0)} m backward)`);

  // (a2) …and the floor is where the PHONE is drawing, not where the previous
  // curve as served sits. Build 17 clients wind a stale curve forward in time
  // onto the newest fix (src/lib/physics/fixForward.ts), so a floor set at the
  // unshifted projection sits below the marker and the swap still steps back —
  // measured 2026-08-19 as 796 of 809 backward steps. clientProjectionM is the
  // server's copy of that rule and must be what the floor uses.
  const prevOClient = clientProjectionM(prev.vehicle.opinion, 1180, T0 - 9_000, T0);
  check('drive/seam-rule: the floor is the CLIENT projection, not the served curve',
    prevOClient > prevO + 1 && Math.abs(b.vehicle.opinion[0].s - prevOClient) < 0.05,
    `opinion[0].s = ${b.vehicle.opinion[0].s.toFixed(1)}, client draws ${prevOClient.toFixed(1)}, ` +
    `served curve is at ${prevO.toFixed(1)}`);

  // (b) drive, flat fixes (vObs = 0): the old curve provably overshot — the
  // honest backward correction to the nowcast is emitted unchanged.
  const c = mkDrive({
    raw: raw(1000, 2), geom, surfaces: surf(2), emittedAtMs: T0, anchorMs: T0 - 9_000,
    anchorFixS: 1000, prevFixS: 1000, fixGapS: 26, prev: prevTk,
  });
  check('drive/seam-rule: provable overshoot corrects back to the nowcast (≥ fix)',
    !c.meta.seamFloorApplied &&
    c.vehicle.opinion[0].s >= 1000 - 0.05 && c.vehicle.opinion[0].s < prevO - 100,
    `opinion[0].s = ${c.vehicle.opinion[0].s.toFixed(1)} (prevO ${prevO.toFixed(1)} was unjustified)`);

  // (c) drive, standing evidence at the anchor: modal hold outranks
  // continuity — the curve stands AT the platform, not at the old projection.
  const d = mkDrive({
    raw: raw(1220, 2), geom, surfaces: surf(2), emittedAtMs: T0, anchorMs: T0 - 9_000,
    anchorFixS: 1220, prevFixS: 800, fixGapS: 26,
    modal: { stopS: 1220, releaseAtMs: T0 + 40_000 }, prev: prevTk,
  });
  check('drive/seam-rule: standing evidence outranks continuity (holds at platform)',
    !d.meta.seamFloorApplied &&
    Math.abs(evalTrack(d.vehicle.opinion, T0 + 10_000) - 1220) < 0.1,
    `s at +10 s = ${evalTrack(d.vehicle.opinion, T0 + 10_000).toFixed(1)} (stopS 1220, prevO ${prevO.toFixed(1)})`);

  // (d) the published generator honours the same rule.
  const pv = buildV2Vehicle({
    key: 'S', tripId: 't1', line: '22', anchorMs: T0 - 35_000, emittedAtMs: T0 - 30_000,
    raw: raw(1000, 8, T0 - 30_000), modal: null, prev: null,
  })!;
  const pPrevO = evalTrack(pv.vehicle.opinion, T0);
  const pb = buildV2Vehicle({
    key: 'S', tripId: 't1', line: '22', anchorMs: T0 - 9_000, emittedAtMs: T0,
    raw: raw(1190, 8), modal: null,
    prev: { tripId: 't1', smooth: pv.smooth, opinion: pv.opinion },
    anchorFixS: 1180, prevFixS: 1000, fixGapS: 26,
  })!;
  contract('seam-rule/published/opinion', pb.vehicle.opinion, T0);
  check('seam-rule: published gen — continuity floor engages, telemetry set',
    pb.vehicle.opinion[0].s >= pPrevO - 0.05 && pb.seamFloorApplied && !pb.ageFloorApplied,
    `opinion[0].s = ${pb.vehicle.opinion[0].s.toFixed(1)}, prevO ${pPrevO.toFixed(1)}`);
  const pc = buildV2Vehicle({
    key: 'S', tripId: 't1', line: '22', anchorMs: T0 - 9_000, emittedAtMs: T0,
    raw: raw(1000, 2), modal: null,
    prev: { tripId: 't1', smooth: pv.smooth, opinion: pv.opinion },
    anchorFixS: 1000, prevFixS: 1000, fixGapS: 26,
  })!;
  check('seam-rule: published gen — overshoot corrects honestly (no floor)',
    !pc.seamFloorApplied && pc.vehicle.opinion[0].s >= 1000 - 0.05 &&
    pc.vehicle.opinion[0].s < pPrevO - 100,
    `opinion[0].s = ${pc.vehicle.opinion[0].s.toFixed(1)}`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
