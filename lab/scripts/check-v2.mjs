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
//  4. the KINEMATIC LIMITS (protocol §Kinematic limits) on every segment of
//     every published track — implied speed ≤ 17.0 m/s, client-observable
//     acceleration inside +1.35/−1.45 m/s². Any violation fails the run;
//  5. how many METERS the modal stop rule and the continuity track move the
//     rendered position away from the raw v1 ml-gbdt curve, how big the
//     re-anchor teleport that continuity absorbs actually is, and how fast the
//     smooth track actually drives when it is closing a catch-up gap;
//  6. the curvegen-v3 SHADOW bundle (GET /api/shadow-trajectories) against the
//     same wire contract + kinematics PLUS the design's perceptual gates
//     (docs/research/curvegen-v3-design.md §8), computed here INDEPENDENTLY
//     from served bytes: G2 jerk p99 ≤ 0.9 with 0 samples > 1.0, G3 accel
//     sign-flip rates, G5 catch-up latency from observed re-emissions, G6
//     oscillation after convergence, G8 discontinuity honesty, G9 seams.
//     Percentile gates need n ≥ a floor to bind; below it they print advisory.

const BASE = process.env.LAB_URL ?? 'https://tram-lab.acex.sh';
const DURATION_S = Number(process.env.DURATION_S ?? 75);
const POLL_MS = Number(process.env.POLL_MS ?? 2000);
const CONTINUITY_TOL_M = 2;

// Wire-level tolerances from lab/src/config.ts — the physical limits are
// V_MAX 16.7 m/s and +1.3/−1.4 m/s²; the slack absorbs cm/ms rounding.
const V_MAX_GATE = 17.0;
const A_ACC_GATE = 1.35;
const A_BRK_GATE = 1.45;
/** A re-emission whose smooth track starts at least this far from the opinion
 *  counts as a CATCH-UP EPISODE — the thing that used to happen at impossible
 *  speed (owner field report, build 13). */
const CATCHUP_MIN_M = 20;

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

// ── kinematic limits (protocol §Kinematic limits) ────────────────────────────
// A client only ever draws straight lines between knots, so the physical
// quantities that EXIST for it are the per-segment mean speed and the change
// of that speed from one segment to the next — a central difference, because
// segment i's mean speed is its midpoint instantaneous speed.
function readRealism(track) {
  const speeds = [];
  const dts = [];
  for (let i = 1; i < track.length; i++) {
    const dtS = (track[i].t - track[i - 1].t) / 1000;
    dts.push(dtS);
    speeds.push(dtS > 0 ? (track[i].s - track[i - 1].s) / dtS : 0);
  }
  const accels = [];
  for (let i = 1; i < speeds.length; i++) {
    const span = (dts[i - 1] + dts[i]) / 2;
    accels.push(span > 0 ? (speeds[i] - speeds[i - 1]) / span : 0);
  }
  return { speeds, accels };
}

const realism = {
  tracks: 0,
  segments: 0,
  violations: 0,
  speedViolations: 0,
  accelViolations: 0,
  allSpeeds: [],
  allAccels: [],
  worst: [],
};
const realismSeen = new Set();

function checkRealism(v, name) {
  const id = `${v.key}@${v.emittedAtMs}:${name}`;
  if (realismSeen.has(id)) return; // each emission is polled many times
  realismSeen.add(id);
  const { speeds, accels } = readRealism(v[name]);
  realism.tracks++;
  realism.segments += speeds.length;
  for (const s of speeds) realism.allSpeeds.push(s);
  for (const a of accels) realism.allAccels.push(a);
  const offend = (kind, value, limit) => {
    realism.violations++;
    if (kind === 'speed') realism.speedViolations++;
    else realism.accelViolations++;
    realism.worst.push({ id, kind, value, limit, excess: Math.abs(value - limit) });
    realism.worst.sort((a, b) => b.excess - a.excess);
    if (realism.worst.length > 5) realism.worst.length = 5;
    fail(`${id}: ${kind} ${value.toFixed(3)} outside limit ${limit}`);
  };
  for (const s of speeds) if (s > V_MAX_GATE) offend('speed', s, V_MAX_GATE);
  for (const a of accels) {
    if (a > A_ACC_GATE) offend('accel', a, A_ACC_GATE);
    else if (a < -A_BRK_GATE) offend('accel', a, -A_BRK_GATE);
  }
}

// ── per-vehicle contract ─────────────────────────────────────────────────────
const seenBad = new Set();
function checkVehicle(v, bundleAtMs, idPrefix = '') {
  const id = `${idPrefix}${v.key}@${v.emittedAtMs}`;
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

// ── curvegen-v3 shadow gates (independent wire math — no imports) ────────────
const J_GATE = 0.9;
const FLIP_DEADBAND = 0.2;
const CONV_TOL_M = 15;

/** Wire-observable jerk: Δ of consecutive central-difference accels ÷ the
 *  time between their centres (each accel centred at the mean of its two
 *  segment midpoints). Same reading as lab/src/realism.ts readJerk. */
function readJerkWire(track) {
  const speeds = [];
  const mids = [];
  for (let i = 1; i < track.length; i++) {
    const dtS = (track[i].t - track[i - 1].t) / 1000;
    speeds.push(dtS > 0 ? (track[i].s - track[i - 1].s) / dtS : 0);
    mids.push((track[i].t + track[i - 1].t) / 2);
  }
  const accels = [];
  const centres = [];
  for (let i = 1; i < speeds.length; i++) {
    const spanS = (mids[i] - mids[i - 1]) / 1000;
    if (spanS <= 0) continue;
    accels.push((speeds[i] - speeds[i - 1]) / spanS);
    centres.push((mids[i] + mids[i - 1]) / 2);
  }
  const jerks = [];
  for (let i = 1; i < accels.length; i++) {
    const dtS = (centres[i] - centres[i - 1]) / 1000;
    if (dtS > 0) jerks.push((accels[i] - accels[i - 1]) / dtS);
  }
  return jerks;
}

/** G3: accel sign flips (deadband; |a| ≤ deadband phases don't reset). */
function readFlipsWire(track) {
  const { accels } = readRealism(track);
  let flips = 0;
  let sign = 0;
  for (const a of accels) {
    if (a > FLIP_DEADBAND) {
      if (sign < 0) flips++;
      sign = 1;
    } else if (a < -FLIP_DEADBAND) {
      if (sign > 0) flips++;
      sign = -1;
    }
  }
  const minutes = track.length >= 2 ? (track[track.length - 1].t - track[0].t) / 60_000 : 0;
  return { flips, minutes };
}

const sh = {
  bundles: 0,
  vehicles: 0,
  realism: { tracks: 0, segments: 0, violations: 0, allSpeeds: [], allAccels: [] },
  seen: new Set(),
  last: new Map(),
  jerks: [],
  jerkOver1: 0,
  flipsTotal: 0,
  flipMinutes: 0,
  flipRates: [],
  fixTrans: 0,
  fixDisc: 0,
  ageTrans: 0,
  ageDisc: 0,
  contDelta: [],
  convNear: [],
  convFar: [],
  unconverged: 0,
  aheadRepaid: [],
  aheadUnconverged: 0,
  osc: [],
  dips: 0,
  dipTracks: 0,
  maxPoints: 0,
  minHorizonS: Infinity,
};

function checkShadowVehicle(v, bundleAtMs) {
  const id = `sh:${v.key}@${v.emittedAtMs}`;
  if (sh.seen.has(id)) return; // dense polling sees each emission many times
  sh.seen.add(id);
  sh.vehicles++;
  if (!checkVehicle(v, bundleAtMs, 'sh:')) return;
  for (const name of ['opinion', 'smooth']) {
    const tr = v[name];
    sh.maxPoints = Math.max(sh.maxPoints, tr.length);
    sh.minHorizonS = Math.min(sh.minHorizonS, (tr[tr.length - 1].t - v.emittedAtMs) / 1000);
    const { speeds, accels } = readRealism(tr);
    sh.realism.tracks++;
    sh.realism.segments += speeds.length;
    for (const s of speeds) {
      sh.realism.allSpeeds.push(s);
      if (s > V_MAX_GATE) {
        sh.realism.violations++;
        fail(`${id}: shadow speed ${s.toFixed(3)} > ${V_MAX_GATE}`);
      }
    }
    for (const a of accels) {
      sh.realism.allAccels.push(a);
      if (a > A_ACC_GATE || a < -A_BRK_GATE) {
        sh.realism.violations++;
        fail(`${id}: shadow accel ${a.toFixed(3)} outside [−${A_BRK_GATE}, +${A_ACC_GATE}]`);
      }
    }
    for (const j of readJerkWire(tr)) {
      const aj = Math.abs(j);
      sh.jerks.push(aj);
      if (aj > 1.0) {
        sh.jerkOver1++;
        fail(`${id}: shadow jerk ${aj.toFixed(3)} > 1.0 m/s³ (G2 hard clause)`);
      }
    }
    const f = readFlipsWire(tr);
    sh.flipsTotal += f.flips;
    sh.flipMinutes += f.minutes;
    if (f.minutes > 0.5) sh.flipRates.push(f.flips / f.minutes);
    // Advisory raw dip rate (G7 needs generator context; bytes only see this).
    const spd = speeds;
    sh.dipTracks++;
    for (let k = 1; k < spd.length - 1; k++) {
      if (spd[k] > 0.05 && spd[k] <= spd[k - 1] - 1 && spd[k] <= spd[k + 1] - 1) sh.dips++;
    }
  }

  const prev = sh.last.get(v.key);
  if (prev && prev.emittedAtMs !== v.emittedAtMs) {
    const E = v.emittedAtMs;
    const kind = prev.anchorMs !== v.anchorMs ? 'fix' : 'age';
    if (kind === 'fix') {
      sh.fixTrans++;
      if (v.discontinuity) sh.fixDisc++;
    } else {
      sh.ageTrans++;
      if (v.discontinuity) {
        sh.ageDisc++;
        fail(`sh:${v.key}: age-driven re-emission flagged discontinuity (G8 age ≈ 0)`);
      }
    }
    if (!v.discontinuity) {
      const d = Math.abs(evalTrack(v.smooth, E) - evalTrack(prev.smooth, E));
      sh.contDelta.push(d);
      if (d > CONTINUITY_TOL_M) {
        fail(`sh:${v.key}: shadow continuity broken |Δsmooth| = ${d.toFixed(2)} m (G9)`);
      }
      if (kind === 'fix') {
        // Direction split: gSigned > 0 = smooth BEHIND the fresh opinion (the
        // catch-up mechanism the G5 gates target). gSigned < 0 = smooth AHEAD
        // — repaid at the next platform hold BY DESIGN (§6), tracked
        // separately and not gated.
        const gSigned = evalTrack(v.opinion, E) - evalTrack(v.smooth, E);
        const gap = Math.abs(gSigned);
        if (gap >= 20) {
          const horizonS = Math.round((v.opinion[v.opinion.length - 1].t - E) / 1000);
          let convS = null;
          for (let dt = 0; dt <= horizonS; dt++) {
            const t = E + dt * 1000;
            if (Math.abs(evalTrack(v.smooth, t) - evalTrack(v.opinion, t)) < CONV_TOL_M) {
              convS = dt;
              break;
            }
          }
          if (gSigned < 0) {
            if (convS === null) sh.aheadUnconverged++;
            else sh.aheadRepaid.push(convS);
          } else {
            if (convS === null) sh.unconverged++;
            else if (gap > 120) sh.convFar.push(convS);
            else sh.convNear.push(convS);
            if (convS !== null) {
              let sign = 0;
              let osc = 0;
              for (let dt = convS; dt <= horizonS; dt++) {
                const d2 = evalTrack(v.smooth, E + dt * 1000) - evalTrack(v.opinion, E + dt * 1000);
                if (d2 > 2) {
                  if (sign < 0) osc++;
                  sign = 1;
                } else if (d2 < -2) {
                  if (sign > 0) osc++;
                  sign = -1;
                }
              }
              sh.osc.push(osc);
            }
          }
        }
      }
    }
  }
  sh.last.set(v.key, v);
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
const catchupGap = [];   // |smooth − opinion| at a re-emission, ≥ CATCHUP_MIN_M
const catchupSpeed = []; // fastest the smooth track drives in the next 30 s

/** Fastest per-segment implied speed of a track inside a time window. */
function maxSpeedWithin(track, tFrom, tTo) {
  let m = 0;
  for (let i = 1; i < track.length; i++) {
    if (track[i].t <= tFrom || track[i - 1].t >= tTo) continue;
    const dtS = (track[i].t - track[i - 1].t) / 1000;
    if (dtS > 0) m = Math.max(m, (track[i].s - track[i - 1].s) / dtS);
  }
  return m;
}

const t0 = Date.now();
while (Date.now() - t0 < DURATION_S * 1000) {
  const [b, v1, sb] = await Promise.all([
    get('/api/trajectories/v2'),
    get('/api/trajectories'),
    get('/api/shadow-trajectories').catch(() => null),
  ]);
  bundles++;
  if (sb !== null) {
    sh.bundles++;
    if (sb.shadow !== true) fail('shadow bundle missing shadow:true');
    if (Array.isArray(sb.vehicles)) {
      for (const v of sb.vehicles) checkShadowVehicle(v, sb.atMs);
    } else {
      fail('shadow bundle has no vehicles array');
    }
  }
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
    checkRealism(v, 'opinion');
    checkRealism(v, 'smooth');
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
      // A catch-up episode: the smooth track is emitted with a real gap to the
      // opinion and has to DRIVE it off. How fast does it actually go?
      const gap = Math.abs(evalTrack(v.opinion, E) - evalTrack(v.smooth, E));
      if (!v.discontinuity && gap >= CATCHUP_MIN_M) {
        catchupGap.push(gap);
        catchupSpeed.push(maxSpeedWithin(v.smooth, E, E + 30_000));
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
console.log(`\n── kinematic limits (protocol §Kinematic limits) ──────────────────`);
console.log(`tracks measured       ${realism.tracks} (${realism.segments} segments), each emission once`);
console.log(`VIOLATIONS            ${realism.violations}  [speed ${realism.speedViolations}, accel ${realism.accelViolations}]  ` +
  `— limits v ≤ ${V_MAX_GATE} m/s, a ∈ [−${A_BRK_GATE}, +${A_ACC_GATE}] m/s²`);
if (realism.worst.length > 0) {
  console.log('worst offenders:');
  for (const w of realism.worst) console.log(`   ${w.id}  ${w.kind} ${w.value.toFixed(3)} (limit ${w.limit}, excess ${w.excess.toFixed(3)})`);
}
const dist = (arr, unit) =>
  arr.length === 0 ? 'n=0' :
  `n=${arr.length} p01=${pct(arr, 1).toFixed(2)} p50=${pct(arr, 50).toFixed(2)} p90=${pct(arr, 90).toFixed(2)} ` +
  `p99=${pct(arr, 99).toFixed(2)} min=${Math.min(...arr).toFixed(2)} max=${Math.max(...arr).toFixed(2)} ${unit}`;
console.log(`per-segment speed     ${dist(realism.allSpeeds, 'm/s')}`);
console.log(`between-segment accel ${dist(realism.allAccels, 'm/s²')}`);

console.log(`\n── catch-up: how fast does smooth actually drive to converge? ─────`);
console.log(`episodes (gap ≥ ${CATCHUP_MIN_M} m)  ${catchupGap.length}`);
console.log(`gap at emission       ${fmt(catchupGap)}`);
console.log(`peak smooth speed in the next 30 s   ${dist(catchupSpeed, 'm/s')}`);
console.log(`   ⇒ hard ceiling is V_MAX 16.7 m/s; before 2026-08-16 this was unbounded`);

console.log(`\n── what physics-v3 costs/gains, in meters ─────────────────────────`);
console.log(`raw teleport at re-anchor |Δopinion(E)|      ${fmt(opinionJump)}`);
console.log(`   ⇒ absorbed by the smooth track, which moves ≤${CONTINUITY_TOL_M} m at the seam`);
console.log(`modal stop rule vs raw v1 curve             ${fmt(modalDelta)}`);
console.log(`   ⇒ ${modalHeld} vehicle-samples were HELD at the platform at +20 s`);
console.log(`smooth vs opinion after a re-emission       ${fmt(smoothVsOpinion)}`);

// ── curvegen-v3 shadow (design §8 gates, independent from served bytes) ──────
console.log(`\n── SHADOW /api/shadow-trajectories — curvegen-v3 gates ────────────`);
if (sh.bundles === 0) {
  fail('shadow endpoint unreachable for the whole run');
} else {
  const gate = (name, n, minN, ok, detail) => {
    if (n < minN) console.log(`  ~  ${name}: n=${n} < ${minN} — advisory only (${detail})`);
    else if (ok) console.log(`  ok ${name}: ${detail}`);
    else fail(`${name}: ${detail}`);
  };
  console.log(`bundles ${sh.bundles}, emissions measured ${sh.vehicles}, tracks ${sh.realism.tracks} ` +
    `(${sh.realism.segments} segments), max points ${sh.maxPoints}, min horizon ${sh.minHorizonS}s`);
  console.log(`G1 kinematics: ${sh.realism.violations} violations`);
  console.log(`   speed ${dist(sh.realism.allSpeeds, 'm/s')}`);
  console.log(`   accel ${dist(sh.realism.allAccels, 'm/s²')}`);
  const jp50 = pct(sh.jerks, 50);
  const jp99 = pct(sh.jerks, 99);
  const jmax = sh.jerks.length > 0 ? Math.max(...sh.jerks) : 0;
  console.log(`G2 |jerk| n=${sh.jerks.length} p50=${jp50.toFixed(3)} p99=${jp99.toFixed(3)} ` +
    `max=${jmax.toFixed(3)} m/s³, >1.0: ${sh.jerkOver1}`);
  gate('G2 jerk p99 ≤ 0.9', sh.jerks.length, 50, jp99 <= J_GATE, `p99 = ${jp99.toFixed(3)} m/s³`);
  const fleetFlips = sh.flipMinutes > 0 ? sh.flipsTotal / sh.flipMinutes : 0;
  const flipP95 = pct(sh.flipRates, 95);
  gate('G3 fleet flip rate ≤ 2.0/min', Math.round(sh.flipMinutes), 30, fleetFlips <= 2.0,
    `${fleetFlips.toFixed(2)}/min over ${sh.flipMinutes.toFixed(0)} track-min`);
  gate('G3 per-track flips p95 ≤ 3.0/min', sh.flipRates.length, 20, flipP95 <= 3.0,
    `p95 = ${flipP95.toFixed(2)}/min (n=${sh.flipRates.length})`);
  console.log(`G5 catch-up latency (smooth BEHIND) near(20–120 m) ${fmt(sh.convNear, 's')}`);
  console.log(`                    far(120 m–T_disc) ${fmt(sh.convFar, 's')}   unconverged-in-horizon: ${sh.unconverged}`);
  console.log(`ahead-repaid (§6, absorbed at the next hold — not gated) ${fmt(sh.aheadRepaid, 's')}  unconverged: ${sh.aheadUnconverged}`);
  gate('G5 near p50 ≤ 12 s', sh.convNear.length, 10, pct(sh.convNear, 50) <= 12,
    `p50 = ${pct(sh.convNear, 50).toFixed(1)}s`);
  gate('G5 near p90 ≤ 28 s', sh.convNear.length, 10, pct(sh.convNear, 90) <= 28,
    `p90 = ${pct(sh.convNear, 90).toFixed(1)}s`);
  gate('G5 far p90 ≤ 60 s', sh.convFar.length, 5, pct(sh.convFar, 90) <= 60,
    `p90 = ${pct(sh.convFar, 90).toFixed(1)}s`);
  gate('G6 oscillation p95 ≤ 1', sh.osc.length, 10, pct(sh.osc, 95) <= 1,
    `p95 = ${sh.osc.length > 0 ? pct(sh.osc, 95).toFixed(1) : '—'} (max ${sh.osc.length > 0 ? Math.max(...sh.osc) : 0})`);
  const discRate = sh.fixTrans > 0 ? (100 * sh.fixDisc) / sh.fixTrans : 0;
  gate('G8 fix-driven discontinuity ≤ 5 %', sh.fixTrans, 20, discRate <= 5,
    `${discRate.toFixed(1)} % (${sh.fixDisc}/${sh.fixTrans}); age-driven ${sh.ageDisc}/${sh.ageTrans}`);
  console.log(`G9 seams |Δsmooth(E)| ${fmt(sh.contDelta)}  [≤ ${CONTINUITY_TOL_M} m, violations fail inline]`);
  console.log(`advisory raw dip-rate (G7 without generator context): ${sh.dips} dips / ${sh.dipTracks} tracks`);
}

console.log(failures === 0 ? '\nCONTRACT OK' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
