// THE CLIENT-PATH REPLAY — the measurement no lab gate makes.
//
// Every gate in this lab scores the SERVED curve. None of them evaluate what a
// phone actually draws, which is the served curve PLUS the client's fix-forward
// shim (src/lib/physics/fixForward.ts), read at a bundle age of up to ~7 s. That
// gap is why three sessions of green gates coexisted with an owner reporting
// trams that stall and fly backwards.
//
// This script closes it from the outside: it polls the two feeds a phone polls,
// at the cadences a phone uses (bundle 5 s, Convex fleet 2 s), renders every
// vehicle at 4 Hz under several rules, and counts the three things the owner
// actually complains about —
//
//   backSteps   the marker jumped BACKWARD («летает за фикс»), attributed to
//               a new fix, a new bundle, or both, because the fix for each is
//               in a different place;
//   stall%      the marker stood still while the served curve says the tram is
//               moving («стоит посреди перегона») — this is what build 16's
//               max(curve, fix) clamp cost, measured at 2.5–3.0 %;
//   behind%     the marker rendered behind the newest AVL fix.
//
//   node lab/scripts/client-path-replay.mjs [runMs]
//
// Findings it produced on 2026-08-19 (gen=v3, 4 min, ~280 vehicles), which are
// the evidence behind build 17 and the §14.7 amendment: fix updates cause
// essentially no backward steps (0–1); 796 of 809 happen at the BUNDLE SWAP,
// because the server's seam floor referenced the unshifted previous curve while
// the phone had already wound it forward. Re-run after any change to either
// side of the shim — this is the only number that describes the screen.
//
// Requires the app's node_modules (the Convex browser client); paths below are
// resolved from this file, so run it from anywhere in the checkout.
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'),
);
const { ConvexHttpClient } = require('convex/browser');

const RUN_MS = Number(process.argv[2] ?? 240_000);
const cx = new ConvexHttpClient('https://tram-api.acex.sh');

const evalT = (pts, t) => {
  if (!pts || pts.length === 0) return NaN;
  if (t <= pts[0].t) return pts[0].s;
  if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].s;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].t <= t) lo = m; else hi = m; }
  const a = pts[lo], b = pts[hi];
  return a.s + ((b.s - a.s) * (t - a.t)) / (b.t - a.t);
};
const crossT = (pts, sTarget) => {
  const n = pts.length;
  if (n === 0) return NaN;
  if (sTarget <= pts[0].s) return pts[0].t;
  if (sTarget > pts[n - 1].s) return NaN;
  let lo = 1, hi = n - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m].s >= sTarget) hi = m; else lo = m + 1; }
  const a = pts[hi - 1], b = pts[hi];
  const ds = b.s - a.s;
  return ds <= 0 ? b.t : a.t + ((b.t - a.t) * (sTarget - a.s)) / ds;
};

let bundle = null, fleet = new Map();
async function pollBundle() {
  try {
    const b = await (await fetch('https://tram-lab.acex.sh/api/trajectories/v2?gen=v3')).json();
    bundle = new Map(b.vehicles.map(v => [v.key, v]));
  } catch {}
}
async function pollFleet() {
  try { for (const v of (await cx.query('stream:fullFleet', {})).vehicles) fleet.set(v.key, v); } catch {}
}

// variants: cap on tau (ms). Infinity = uncapped, 0 = raw curve.
const CAPS = [0, 5_000, 10_000, 20_000, Infinity];
const name = c => (c === 0 ? 'raw' : c === Infinity ? 'ts-uncapped' : `ts-cap${c / 1000}s`);
const acc = new Map(CAPS.map(c => [c, {
  samples: 0, back: 0, backFix: 0, backSwap: 0, backBoth: 0, backM: [],
  stallMs: 0, movingMs: 0, behind: 0, behindM: [],
}]));
const st = new Map();

function tick() {
  if (!bundle) return;
  const t = Date.now();
  for (const [key, v] of bundle) {
    const fix = fleet.get(key);
    if (!fix || fix.tripId !== v.tripId) continue;
    const curveMoving = evalT(v.opinion, t + 500) - evalT(v.opinion, t - 500) > 0.5;
    const newer = !Number.isFinite(v.anchorMs) || fix.observedAtMs > v.anchorMs;
    let tau0 = 0;
    if (newer && fix.shapeDistM > evalT(v.opinion, fix.observedAtMs)) {
      const reach = crossT(v.opinion, fix.shapeDistM);
      tau0 = Number.isFinite(reach) ? Math.max(0, reach - fix.observedAtMs) : Infinity;
    }
    for (const cap of CAPS) {
      const a = acc.get(cap);
      let s;
      if (cap === 0) s = evalT(v.opinion, t);
      else if (tau0 === Infinity) s = Math.max(evalT(v.opinion, t), fix.shapeDistM);
      else s = evalT(v.opinion, t + Math.min(tau0, cap));
      if (!Number.isFinite(s)) continue;
      a.samples++;
      if (s < fix.shapeDistM - 1 && t >= fix.observedAtMs) { a.behind++; a.behindM.push(fix.shapeDistM - s); }
      const id = `${cap}|${key}`;
      const p = st.get(id);
      if (p && t - p.t < 2_000) {
        const ds = s - p.s;
        if (curveMoving) { a.movingMs += t - p.t; if (Math.abs(ds) < 0.05) a.stallMs += t - p.t; }
        if (ds < -0.5) {
          a.back++; a.backM.push(-ds);
          const fixChanged = p.fixAt !== fix.observedAtMs;
          const curveChanged = p.emit !== v.emittedAtMs;
          if (fixChanged && curveChanged) a.backBoth++;
          else if (fixChanged) a.backFix++;
          else if (curveChanged) a.backSwap++;
        }
      }
      st.set(id, { s, t, fixAt: fix.observedAtMs, emit: v.emittedAtMs });
    }
  }
}

const q = (arr, p) => (arr.length ? arr.slice().sort((x, y) => x - y)[Math.floor(arr.length * p)] : 0);
await Promise.all([pollBundle(), pollFleet()]);
const iv = [setInterval(pollBundle, 5_000), setInterval(pollFleet, 2_000), setInterval(tick, 250)];
setTimeout(() => {
  iv.forEach(clearInterval);
  console.log(`\n=== backward-step attribution, gen=v3, ${(RUN_MS / 1000) | 0}s ===`);
  console.log('variant        back   byFix  bySwap  byBoth   backM p50/p90   stall%  behind%  behind p90');
  for (const cap of CAPS) {
    const a = acc.get(cap);
    console.log(
      name(cap).padEnd(14),
      String(a.back).padStart(5), String(a.backFix).padStart(7), String(a.backSwap).padStart(7),
      String(a.backBoth).padStart(7),
      `   ${q(a.backM, .5).toFixed(1)}/${q(a.backM, .9).toFixed(1)}`.padEnd(16),
      `${(100 * a.stallMs / (a.movingMs || 1)).toFixed(1)}%`.padStart(7),
      `${(100 * a.behind / a.samples).toFixed(1)}%`.padStart(8),
      `${q(a.behindM, .9).toFixed(1)}m`.padStart(11),
    );
  }
  process.exit(0);
}, RUN_MS);
