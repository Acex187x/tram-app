// Offline invariant test for the physics-v3 track builder (lab/src/trajectory.ts).
// Pure — no DB, no ML, no network; the learned walk is stubbed with a constant
// pace so the test asserts the CONTRACT, not the model.
//
//   cd lab && TSX_TSCONFIG_PATH=$PWD/tsconfig.runtime.json \
//     ./node_modules/.bin/tsx scripts/selftest-v2.ts

import { buildV2Vehicle, evalTrack, modalReleaseMs, type TrackPoint } from '../src/trajectory';

const T0 = 1_800_000_000_000;
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** v1-style raw keyframes: 13 points, 10 s apart, constant pace from s0. */
function raw(s0: number, paceMs: number, t0 = T0): TrackPoint[] {
  return Array.from({ length: 13 }, (_, k) => ({ t: t0 + k * 10_000, s: s0 + paceMs * k * 10 }));
}

function contract(name: string, track: TrackPoint[], t0: number): void {
  const tMono = track.every((p, i) => i === 0 || p.t > track[i - 1].t);
  const sMono = track.every((p, i) => i === 0 || p.s >= track[i - 1].s);
  const horizonS = (track[track.length - 1].t - t0) / 1000;
  check(
    `${name}: t↑ / s↛↓ / ${track.length}≤24 pts / horizon ${horizonS}s ≥120`,
    tMono && sMono && track.length <= 24 && horizonS >= 120,
  );
}

// ── 1. moving vehicle, first emission ───────────────────────────────────────
{
  const r = raw(1000, 8);
  const v = buildV2Vehicle({
    key: 'A', tripId: 't1', line: '22', anchorMs: T0 - 5000, emittedAtMs: T0,
    raw: r, modal: null, prev: null,
  })!;
  contract('moving/opinion', v.opinion, T0);
  contract('moving/smooth', v.smooth, T0);
  check('moving: first emission ⇒ smooth == opinion, no discontinuity',
    !v.discontinuity && JSON.stringify(v.smooth) === JSON.stringify(v.opinion));
  check('moving: opinion == raw ml curve (v1 parity)',
    v.opinion.every((p, i) => p.t === r[i].t && p.s === r[i].s));
}

// ── 2. modal stop rule ──────────────────────────────────────────────────────
{
  // Expectation-floating raw curve: the ML mean creeps off the platform.
  const r = raw(2000, 2.5);
  const releaseAtMs = modalReleaseMs(T0, 0, 20, 8); // Φ⁻¹(0.6)=0.2533 ⇒ ~+22 s
  const v = buildV2Vehicle({
    key: 'B', tripId: 't1', line: '22', anchorMs: T0 - 5000, emittedAtMs: T0,
    raw: r,
    modal: { stopS: 2000, releaseAtMs, walk: (t) => 2000 + Math.max(0, (t - releaseAtMs) / 1000) * 6 },
    prev: null,
  })!;
  contract('modal/opinion', v.opinion, T0);
  check('modal: release instant ≈ mean + 0.2533·sd',
    Math.abs(releaseAtMs - (T0 + 22_027)) < 100, `${(releaseAtMs - T0) / 1000}s`);
  check('modal: HOLDS at the platform until release (no floating)',
    [0, 5_000, 10_000, 20_000, 22_000].every((d) => evalTrack(v.opinion, T0 + d) === 2000),
    `raw would be at ${evalTrack(r, T0 + 22_000).toFixed(1)} m`);
  check('modal: departs at full learned pace after release',
    Math.abs(evalTrack(v.opinion, releaseAtMs + 10_000) - 2060) < 1,
    `${evalTrack(v.opinion, releaseAtMs + 10_000).toFixed(1)} m`);
  check('modal: kink knots inserted', v.opinion.length > 13, `${v.opinion.length} pts`);

  // already-standing credit shortens the hold by exactly that much
  const r2 = modalReleaseMs(T0, 15, 20, 8);
  check('modal: already-standing time is credited',
    Math.abs(releaseAtMs - r2 - 15_000) < 2, `${(releaseAtMs - r2) / 1000}s earlier`);
}

// ── 3. continuity, rendered position BEHIND the opinion ─────────────────────
{
  const prevSmooth = raw(900, 8, T0 - 40_000); // where the phone is drawing
  const sStart = evalTrack(prevSmooth, T0);    // = 900 + 8*40 = 1220
  const r = raw(1300, 8);                      // fresh opinion jumped ahead 80 m
  const v = buildV2Vehicle({
    key: 'C', tripId: 't1', line: '22', anchorMs: T0 - 5000, emittedAtMs: T0,
    raw: r, modal: null, prev: { tripId: 't1', smooth: prevSmooth },
  })!;
  contract('behind/smooth', v.smooth, T0);
  check('behind: smooth starts exactly where the previous track had the tram',
    Math.abs(evalTrack(v.smooth, T0) - sStart) <= 2,
    `Δ=${(evalTrack(v.smooth, T0) - sStart).toFixed(3)} m`);
  check('behind: converged onto opinion within 30 s',
    Math.abs(evalTrack(v.smooth, T0 + 30_000) - evalTrack(v.opinion, T0 + 30_000)) < 0.02);
  check('behind: identical to opinion after convergence',
    Math.abs(evalTrack(v.smooth, T0 + 90_000) - evalTrack(v.opinion, T0 + 90_000)) < 0.02);
  check('behind: no discontinuity flagged', !v.discontinuity);
}

// ── 4. continuity, rendered position AHEAD of the opinion (never reverse) ───
{
  const prevSmooth = raw(1400, 8, T0 - 40_000);
  const sStart = evalTrack(prevSmooth, T0); // 1720
  const r = raw(1650, 8);                   // opinion is 70 m behind the render
  const v = buildV2Vehicle({
    key: 'D', tripId: 't1', line: '22', anchorMs: T0 - 5000, emittedAtMs: T0,
    raw: r, modal: null, prev: { tripId: 't1', smooth: prevSmooth },
  })!;
  contract('ahead/smooth', v.smooth, T0);
  check('ahead: smooth starts at the rendered position',
    Math.abs(evalTrack(v.smooth, T0) - sStart) <= 2);
  check('ahead: HOLDS (never reverses) until the opinion catches up',
    [0, 2_000, 5_000, 8_000].every((d) => evalTrack(v.smooth, T0 + d) === sStart));
  check('ahead: follows the opinion once it has passed',
    Math.abs(evalTrack(v.smooth, T0 + 60_000) - evalTrack(v.opinion, T0 + 60_000)) < 0.02);
  check('ahead: no discontinuity flagged', !v.discontinuity);
}

// ── 5. discontinuities ──────────────────────────────────────────────────────
{
  const prevSmooth = raw(1000, 8, T0 - 40_000); // ⇒ 1320 at T0
  const v = buildV2Vehicle({
    key: 'E', tripId: 't1', line: '22', anchorMs: T0 - 5000, emittedAtMs: T0,
    raw: raw(1600, 8), modal: null, prev: { tripId: 't1', smooth: prevSmooth },
  })!;
  check('break >150 m ⇒ discontinuity + smooth starts AT opinion',
    v.discontinuity && evalTrack(v.smooth, T0) === evalTrack(v.opinion, T0));

  const w = buildV2Vehicle({
    key: 'E', tripId: 't2', line: '22', anchorMs: T0 - 5000, emittedAtMs: T0,
    raw: raw(1330, 8), modal: null, prev: { tripId: 't1', smooth: prevSmooth },
  })!;
  check('trip change ⇒ discontinuity even when the numbers are close',
    w.discontinuity && evalTrack(w.smooth, T0) === evalTrack(w.opinion, T0));
}

// ── 6. modal + continuity together (the real at-stop case) ──────────────────
{
  const releaseAtMs = modalReleaseMs(T0, 5, 24, 10);
  const prevSmooth = raw(4980, 0.4, T0 - 40_000); // crawling toward the stop
  const v = buildV2Vehicle({
    key: 'F', tripId: 't1', line: '22', anchorMs: T0 - 5000, emittedAtMs: T0,
    raw: raw(5000, 3), modal: {
      stopS: 5000, releaseAtMs,
      walk: (t) => 5000 + Math.max(0, (t - releaseAtMs) / 1000) * 6,
    },
    prev: { tripId: 't1', smooth: prevSmooth },
  })!;
  contract('modal+continuity/smooth', v.smooth, T0);
  check('modal+continuity: smooth honours the previous render',
    Math.abs(evalTrack(v.smooth, T0) - evalTrack(prevSmooth, T0)) <= 2);
  check('modal+continuity: converged onto the modal opinion by +30 s',
    Math.abs(evalTrack(v.smooth, T0 + 30_000) - evalTrack(v.opinion, T0 + 30_000)) < 0.02,
    `smooth ${evalTrack(v.smooth, T0 + 30_000).toFixed(2)} / opinion ${evalTrack(v.opinion, T0 + 30_000).toFixed(2)}`);
  check('modal+continuity: the blend never floats PAST the platform pre-release',
    [0, 5_000, 10_000, 20_000, 21_000].every((d) => evalTrack(v.smooth, T0 + d) <= 5000),
    `+21 s: ${evalTrack(v.smooth, T0 + 21_000).toFixed(2)} m (stop 5000, release +${((releaseAtMs - T0) / 1000).toFixed(1)} s)`);
}

// ── 7. evaluator purity ─────────────────────────────────────────────────────
{
  const r = raw(1000, 8);
  const a = [T0 - 99, T0 + 12_345, T0 + 119_999, T0 + 500_000].map((t) => evalTrack(r, t));
  const b = [T0 - 99, T0 + 12_345, T0 + 119_999, T0 + 500_000].map((t) => evalTrack(r, t));
  check('evalTrack is pure + clamps outside the horizon',
    a.every((x, i) => Object.is(x, b[i])) && a[0] === 1000 && a[3] === r[12].s);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
