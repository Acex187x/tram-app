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

const surf = (paceMs: number, dwellS = 20): DriveSurfaces => ({
  paceAt: () => paceMs,
  dwellAt: () => dwellS,
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

// ── D3. downstream stop is SERVED, timed by the ML's τ, not the surface ─────
{
  const geom = synthGeometry({ totalM: 4000, stops: [{ atM: 500, id: 'S1' }, { atM: 2600, id: 'S2' }] });
  // The learned surface says 4 m/s (arrival would be +100 s); the ML curve
  // runs 6 m/s (τ = +66.7 s). The ML has leg-timing authority inside the
  // ±50 % trust region, so the drive must arrive on the ML's clock. The ±15 %
  // positional trim (equilibrium gap ≈ 18 m, §4.3) keeps arrival within a few
  // seconds of τ itself; −0.5·D moves it earlier when the ladder is unbound.
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
  check('drive/stop: arrival rides the ML timetable, not the slow surface',
    tArr !== null && tArr >= tauS - 14 && tArr <= tauS + 6 && tArr <= 80,
    `arrived +${tArr}s; τ = +${tauS.toFixed(1)}s, learned-pace arrival would be +100s`);
  check('drive/stop: stands the learned dwell (20 s), then departs',
    tArr !== null && tDep !== null && tDep - tArr >= 18 && tDep - tArr <= 32,
    `stood ${(tDep ?? 0) - (tArr ?? 0)}s`);
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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
