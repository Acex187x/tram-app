// Live contract + continuity checker for GET /api/trajectories/v2
// (docs/research/physics-v3-protocol.md). Plain node, no deps:
//
//   node lab/scripts/check-v2.mjs                 # 75 s against tram-lab.acex.sh
//   LAB_URL=http://localhost:8090 DURATION_S=90 node lab/scripts/check-v2.mjs
//
// What it proves:
//  1. every emitted track satisfies the wire contract (both tracks, t↑, s↛↓,
//     ≥120 s horizon, ≤24 points, anchor/emission sanity);
//  2. the SERVER-ENFORCED continuity invariant on every re-emission actually
//     observed by dense polling: smooth_n(emittedAtMs_n) == smooth_{n-1}
//     (emittedAtMs_n) within 2 m unless discontinuity=true;
//  3. the literal two-fetch (t, t+65 s) comparison the runbook asks for;
//  4. how many METERS the modal stop rule and the continuity track move the
//     rendered position away from the raw v1 ml-gbdt curve, and how big the
//     re-anchor teleport that continuity absorbs actually is.

const BASE = process.env.LAB_URL ?? 'https://tram-lab.acex.sh';
const DURATION_S = Number(process.env.DURATION_S ?? 75);
const POLL_MS = Number(process.env.POLL_MS ?? 2000);
const CONTINUITY_TOL_M = 2;

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`FAIL ${msg}`);
};

function evalTrack(track, tMs) {
  const n = track.length;
  if (n === 0) return NaN;
  if (tMs <= track[0].t) return track[0].s;
  if (tMs >= track[n - 1].t) return track[n - 1].s;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid].t <= tMs) lo = mid;
    else hi = mid;
  }
  const a = track[lo];
  const b = track[hi];
  return a.s + ((b.s - a.s) * (tMs - a.t)) / (b.t - a.t);
}

const pct = (arr, p) => {
  if (arr.length === 0) return NaN;
  const a = [...arr].sort((x, y) => x - y);
  const k = ((a.length - 1) * p) / 100;
  const f = Math.floor(k);
  const c = Math.min(f + 1, a.length - 1);
  return a[f] + (a[c] - a[f]) * (k - f);
};
const fmt = (arr, unit = 'm') =>
  arr.length === 0
    ? 'n=0'
    : `n=${arr.length} p50=${pct(arr, 50).toFixed(2)}${unit} p90=${pct(arr, 90).toFixed(2)}${unit} ` +
      `max=${Math.max(...arr).toFixed(2)}${unit} mean=${(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)}${unit}`;

const get = async (path) => {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
};

// ── per-vehicle contract ─────────────────────────────────────────────────────
const seenBad = new Set();
function checkVehicle(v, bundleAtMs) {
  const id = `${v.key}@${v.emittedAtMs}`;
  if (seenBad.has(id)) return false;
  const bad = (why) => {
    seenBad.add(id);
    fail(`${id}: ${why}`);
    return false;
  };
  for (const name of ['opinion', 'smooth']) {
    const tr = v[name];
    if (!Array.isArray(tr) || tr.length < 2) return bad(`${name} missing/too short`);
    if (tr.length > 24) return bad(`${name} has ${tr.length} > 24 points`);
    for (let i = 1; i < tr.length; i++) {
      if (!(tr[i].t > tr[i - 1].t)) return bad(`${name} t not strictly increasing at ${i}`);
      if (tr[i].s < tr[i - 1].s) return bad(`${name} s decreases at ${i} (${tr[i - 1].s}→${tr[i].s})`);
      if (!Number.isFinite(tr[i].s)) return bad(`${name} non-finite s at ${i}`);
    }
    if (tr[0].t !== v.emittedAtMs) return bad(`${name}[0].t != emittedAtMs`);
    const horizonS = (tr[tr.length - 1].t - v.emittedAtMs) / 1000;
    if (horizonS < 120) return bad(`${name} horizon ${horizonS}s < 120s`);
  }
  if (typeof v.discontinuity !== 'boolean') return bad('discontinuity not boolean');
  if (!(v.anchorMs <= v.emittedAtMs)) return bad('anchorMs after emittedAtMs');
  if (v.emittedAtMs > bundleAtMs + 5000) return bad('emittedAtMs in the future vs bundle atMs');
  if (typeof v.tripId !== 'string' || typeof v.line !== 'string') return bad('missing tripId/line');
  return true;
}

// ── run ──────────────────────────────────────────────────────────────────────
const last = new Map(); // key → last seen vehicle
const gens = new Map(); // key → generations since the first bundle
const contDelta = [];   // |smooth_new(E) − smooth_prev(E)| on non-discontinuity
const contDeltaDisc = [];
const opinionJump = []; // |opinion_new(E) − opinion_prev(E)| — the raw teleport
const modalDelta = [];  // |v1 raw(t) − opinion(t)| where the modal rule bites
const smoothVsOpinion = []; // |opinion(t) − smooth(t)| just after a re-emission
let modalHeld = 0;
let vehiclesSeen = 0;
let bundles = 0;
let transitions = 0;
let discontinuities = 0;
let first = null;
let firstAtMs = 0;
let maxPoints = 0;
let minHorizonS = Infinity;
let v1Points = new Set();
let v1Vehicles = 0;

const t0 = Date.now();
while (Date.now() - t0 < DURATION_S * 1000) {
  const [b, v1] = await Promise.all([get('/api/trajectories/v2'), get('/api/trajectories')]);
  bundles++;
  if (b.protocolVersion !== 2) fail(`protocolVersion ${b.protocolVersion} != 2`);
  for (const f of ['serverNowMs', 'atMs', 'horizonS']) {
    if (typeof b[f] !== 'number') fail(`bundle field ${f} missing`);
  }
  if (b.serverNowMs - b.atMs > 15_000) fail(`bundle stale: serverNow−atMs = ${(b.serverNowMs - b.atMs) / 1000}s`);
  if (!Array.isArray(b.vehicles) || b.vehicles.length === 0) fail('empty v2 vehicles');

  const rawByKey = new Map(v1.vehicles.map((v) => [v.key, v]));
  v1Vehicles = v1.vehicles.length;
  for (const v of v1.vehicles) v1Points.add(v.points.length);

  for (const v of b.vehicles) {
    vehiclesSeen++;
    if (!checkVehicle(v, b.atMs)) continue;
    maxPoints = Math.max(maxPoints, v.opinion.length, v.smooth.length);
    minHorizonS = Math.min(minHorizonS, (v.opinion[v.opinion.length - 1].t - v.emittedAtMs) / 1000);

    // modal stop rule vs the raw v1 ml-gbdt curve (same vehicle, same emission)
    const raw = rawByKey.get(v.key);
    if (raw && raw.points[0].t === v.emittedAtMs) {
      let held = false;
      for (const dt of [10_000, 20_000, 30_000, 60_000]) {
        const t = v.emittedAtMs + dt;
        const d = evalTrack(raw.points, t) - evalTrack(v.opinion, t);
        if (Math.abs(d) > 0.5) modalDelta.push(Math.abs(d));
        if (dt === 20_000 && evalTrack(v.opinion, t) === v.opinion[0].s && Math.abs(d) > 0.5) held = true;
      }
      if (held) modalHeld++;
    }

    const prev = last.get(v.key);
    if (prev && prev.emittedAtMs !== v.emittedAtMs) {
      transitions++;
      gens.set(v.key, (gens.get(v.key) ?? 0) + 1);
      const E = v.emittedAtMs;
      const dSmooth = Math.abs(evalTrack(v.smooth, E) - evalTrack(prev.smooth, E));
      const dOpinion = Math.abs(evalTrack(v.opinion, E) - evalTrack(prev.opinion, E));
      opinionJump.push(dOpinion);
      if (v.discontinuity) {
        discontinuities++;
        contDeltaDisc.push(dSmooth);
      } else {
        contDelta.push(dSmooth);
        if (dSmooth > CONTINUITY_TOL_M) {
          fail(`continuity broken ${v.key}: |Δsmooth| = ${dSmooth.toFixed(2)} m > ${CONTINUITY_TOL_M} m`);
        }
      }
      for (const dt of [0, 10_000, 30_000]) {
        smoothVsOpinion.push(Math.abs(evalTrack(v.opinion, E + dt) - evalTrack(v.smooth, E + dt)));
      }
    }
    last.set(v.key, v);
  }
  if (first === null) {
    first = new Map(b.vehicles.map((v) => [v.key, v]));
    firstAtMs = b.atMs;
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}

// ── the literal two-snapshot test (first bundle vs one ~DURATION_S later) ────
const late = await get('/api/trajectories/v2');
const twoFetchSingleGen = [];
const twoFetchMultiGen = [];
for (const v of late.vehicles) {
  const old = first.get(v.key);
  if (!old || old.emittedAtMs === v.emittedAtMs || v.discontinuity) continue;
  const d = Math.abs(evalTrack(v.smooth, v.emittedAtMs) - evalTrack(old.smooth, v.emittedAtMs));
  if ((gens.get(v.key) ?? 0) <= 1) twoFetchSingleGen.push(d);
  else twoFetchMultiGen.push(d);
}

console.log(`\n── /api/trajectories/v2 contract, ${BASE} ─────────────────────────`);
console.log(`bundles polled        ${bundles} over ${((Date.now() - t0) / 1000).toFixed(0)}s (every ${POLL_MS} ms)`);
console.log(`vehicle-samples       ${vehiclesSeen}, last bundle ${late.vehicles.length} vehicles`);
console.log(`max points/track      ${maxPoints} (cap 24)   min horizon ${minHorizonS}s (floor 120)`);
console.log(`v1 endpoint           ${v1Vehicles} vehicles, points/vehicle = ${[...v1Points].join(',')}`);
console.log(`re-emissions observed ${transitions} (${discontinuities} flagged discontinuity)`);
console.log(`\n── continuity invariant |smooth_new(E) − smooth_prev(E)| ──────────`);
console.log(`non-discontinuity     ${fmt(contDelta)}   [must be ≤ ${CONTINUITY_TOL_M} m]`);
console.log(`discontinuity         ${fmt(contDeltaDisc)}   [teleport is allowed here]`);
console.log(`two-fetch ~${DURATION_S}s apart, 1 generation:  ${fmt(twoFetchSingleGen)}`);
console.log(`two-fetch ~${DURATION_S}s apart, ≥2 generations: ${fmt(twoFetchMultiGen)}  [chained, not comparable]`);
console.log(`\n── what physics-v3 costs/gains, in meters ─────────────────────────`);
console.log(`raw teleport at re-anchor |Δopinion(E)|      ${fmt(opinionJump)}`);
console.log(`   ⇒ absorbed by the smooth track, which moves ≤${CONTINUITY_TOL_M} m at the seam`);
console.log(`modal stop rule vs raw v1 curve             ${fmt(modalDelta)}`);
console.log(`   ⇒ ${modalHeld} vehicle-samples were HELD at the platform at +20 s`);
console.log(`smooth vs opinion after a re-emission       ${fmt(smoothVsOpinion)}`);
console.log(failures === 0 ? '\nCONTRACT OK' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
