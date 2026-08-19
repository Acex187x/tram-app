// G12 drill-down probe (diagnostic, 2026-08-19): recomputes the §14.4
// anti-collision gate from SERVED shadow bytes + /api/live fixes + the
// geometry pack, and classifies every same-shape crossing by MECHANISM.
//
//   cd lab && TSX_TSCONFIG_PATH=$PWD/tsconfig.runtime.json \
//     DURATION_S=900 ./node_modules/.bin/tsx scripts/g12-probe.ts
//
// Pairing mirrors check-v2 (which mirrors the generator): ordering from fresh
// fixes, stale fixes fall back to the emitted nowcast, alias pairs (< 15 m)
// excluded. What this adds over the pass/fail gate is CONTEXT per violation:
// magnitude, whether the overlap was already there at the start of the common
// window (inherited) or opened inside it (grown), where on the shape it sits
// (terminus? stop zone?), and whether either curve is standing.

import type { RouteGeometry } from '@/lib/types';
import { evalTrack, type TrackPoint } from '../src/trajectory';

const BASE = process.env.LAB_URL ?? 'https://tram-lab.acex.sh';
const DURATION_S = Number(process.env.DURATION_S ?? 900);
const POLL_MS = 2000;
/** Bytes-side crossing threshold, m (check-v2's own). */
const PEN_TOL_M = 0.5;

interface ShadowVehicle {
  key: string;
  tripId: string;
  line: string;
  anchorMs: number;
  emittedAtMs: number;
  discontinuity: boolean;
  opinion: TrackPoint[];
  smooth: TrackPoint[];
}
interface LiveVehicle {
  key: string;
  line: string;
  fixAgeS: number;
  fixDistM: number;
}

const get = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
};

let tripShape = new Map<string, string>();
let shapes = new Map<string, RouteGeometry>();
async function refreshPack(): Promise<void> {
  const pack = await get<{ shapes: RouteGeometry[]; trips: Record<string, string> }>(
    '/api/geometry-pack',
  );
  shapes = new Map(pack.shapes.map((s) => [s.shapeId, s]));
  tripShape = new Map(Object.entries(pack.trips));
}

/** Distance from s to the nearest platform on the shape, m (Infinity: none). */
function nearestStopM(g: RouteGeometry | undefined, s: number): number {
  if (!g) return Infinity;
  let best = Infinity;
  for (const st of g.stops) {
    const d = Math.abs(st.distM - s);
    if (d < best) best = d;
  }
  return best;
}
/** Distance to the closer end of the shape, m — the terminus proximity. */
function terminusM(g: RouteGeometry | undefined, s: number): number {
  if (!g) return Infinity;
  return Math.min(s, Math.max(0, g.totalM - s));
}
const round1 = (x: number): number => Math.round(x * 10) / 10;

interface Row {
  atMs: number;
  shapeId: string;
  line: string;
  fKey: string;
  lKey: string;
  track: 'opinion' | 'smooth';
  worstM: number;
  atT0M: number;
  cls: 'inherited' | 'grown';
  worstAtS: number;
  ordSepM: number;
  fFixAgeS: number;
  lFixAgeS: number;
  fStanding: boolean;
  lStanding: boolean;
  fNearStopM: number;
  fTerminusM: number;
  fEmitAgeS: number;
  lEmitAgeS: number;
  fDisc: boolean;
  lDisc: boolean;
}

const rows: Row[] = [];
const seen = new Set<string>();
let pairTracks = 0;
let emissionsSeen = 0;
const emitSeen = new Set<string>();

function scan(sb: { serverNowMs: number; vehicles: ShadowVehicle[] }, live: LiveVehicle[]): void {
  const liveByKey = new Map(live.map((l) => [l.key, l]));
  const byShape = new Map<string, { v: ShadowVehicle; ordS: number; lv: LiveVehicle }[]>();
  for (const v of sb.vehicles) {
    const id = `${v.key}@${v.emittedAtMs}`;
    if (!emitSeen.has(id)) {
      emitSeen.add(id);
      emissionsSeen++;
    }
    const lv = liveByKey.get(v.key);
    if (!lv) continue;
    if (Math.abs(lv.fixAgeS - (sb.serverNowMs - v.anchorMs) / 1000) > 4) continue;
    const shapeId = tripShape.get(v.tripId);
    if (!shapeId) continue;
    let arr = byShape.get(shapeId);
    if (!arr) byShape.set(shapeId, (arr = []));
    arr.push({ v, ordS: lv.fixAgeS <= 30 ? lv.fixDistM : v.opinion[0].s, lv });
  }
  for (const [shapeId, arr] of byShape) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => a.ordS - b.ordS);
    const g = shapes.get(shapeId);
    for (let i = 0; i + 1 < arr.length; i++) {
      if (arr[i + 1].ordS - arr[i].ordS < 15) continue;
      const f = arr[i];
      const l = arr[i + 1];
      const id = `${f.v.key}@${f.v.emittedAtMs}|${l.v.key}@${l.v.emittedAtMs}`;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const name of ['opinion', 'smooth'] as const) {
        pairTracks++;
        const ft = f.v[name];
        const lt = l.v[name];
        const t0p = Math.max(ft[0].t, lt[0].t);
        const tEnd = Math.min(ft[ft.length - 1].t, lt[lt.length - 1].t);
        if (!(tEnd > t0p)) continue;
        let worst = -Infinity;
        let worstAt = t0p;
        for (let t = t0p; t <= tEnd; t += 1000) {
          const pen = evalTrack(ft, t) - evalTrack(lt, t);
          if (pen > worst) {
            worst = pen;
            worstAt = t;
          }
        }
        if (worst <= PEN_TOL_M) continue;
        const atT0 = evalTrack(ft, t0p) - evalTrack(lt, t0p);
        const fs = evalTrack(ft, worstAt);
        const span = Math.min(tEnd, t0p + 60_000);
        rows.push({
          atMs: sb.serverNowMs,
          shapeId,
          line: f.v.line,
          fKey: f.v.key,
          lKey: l.v.key,
          track: name,
          worstM: round1(worst),
          atT0M: round1(atT0),
          cls: atT0 > PEN_TOL_M ? 'inherited' : 'grown',
          worstAtS: Math.round((worstAt - t0p) / 1000),
          ordSepM: round1(l.ordS - f.ordS),
          fFixAgeS: f.lv.fixAgeS,
          lFixAgeS: l.lv.fixAgeS,
          fStanding: evalTrack(ft, span) - evalTrack(ft, t0p) < 5,
          lStanding: evalTrack(lt, span) - evalTrack(lt, t0p) < 5,
          fNearStopM: round1(nearestStopM(g, fs)),
          fTerminusM: round1(terminusM(g, fs)),
          fEmitAgeS: Math.round((sb.serverNowMs - f.v.emittedAtMs) / 1000),
          lEmitAgeS: Math.round((sb.serverNowMs - l.v.emittedAtMs) / 1000),
          fDisc: f.v.discontinuity,
          lDisc: l.v.discontinuity,
        });
      }
    }
  }
}

// ── generator-equivalent measure ─────────────────────────────────────────────
// The bytes gate above asks "do the curves cross". The GENERATOR counter asks
// the stricter §14.4 question: does the follower penetrate `leader − gapM`,
// where gapM is the EFFECTIVE gap (`effLeader`): the nominal clearance capped
// by whatever clearance actually existed at the follower's own seam, floored
// at 0. Reconstructed here from bytes so the class split can be measured
// without a deploy: clear0 = leader(t_E) − follower(t_E) at the FOLLOWER's
// emission instant, which is exactly what `effLeader` sees.
const NOMINAL_GAP_M = 3 + 14.1; // QUEUE_GAP_M + a single-set tram length
const genSeen = new Set<string>();
let genPairs = 0;
let genViolSeconds = 0;
let genViolTracks = 0;
const clear0Hist: number[] = [];
const genClass = { inherited: 0, grown: 0 };
let genMaxPen = 0;
const genRows: { fKey: string; lKey: string; line: string; track: string; clear0: number; gap: number; pen0: number; maxPen: number; secs: number; standing: boolean }[] = [];

function scanGenerator(sb: { serverNowMs: number; vehicles: ShadowVehicle[] }, live: LiveVehicle[]): void {
  const liveByKey = new Map(live.map((l) => [l.key, l]));
  const byShape = new Map<string, { v: ShadowVehicle; ordS: number; lv: LiveVehicle }[]>();
  for (const v of sb.vehicles) {
    const lv = liveByKey.get(v.key);
    if (!lv) continue;
    const shapeId = tripShape.get(v.tripId);
    if (!shapeId) continue;
    let arr = byShape.get(shapeId);
    if (!arr) byShape.set(shapeId, (arr = []));
    arr.push({ v, ordS: lv.fixAgeS <= 30 ? lv.fixDistM : v.opinion[0].s, lv });
  }
  for (const arr of byShape.values()) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => a.ordS - b.ordS);
    for (let i = 0; i + 1 < arr.length; i++) {
      if (arr[i + 1].ordS - arr[i].ordS < 15) continue;
      const f = arr[i];
      const l = arr[i + 1];
      const id = `${f.v.key}@${f.v.emittedAtMs}`;
      if (genSeen.has(id)) continue;
      genSeen.add(id);
      const tE = f.v.emittedAtMs;
      for (const name of ['opinion', 'smooth'] as const) {
        const ft = f.v[name];
        const lt = l.v[name];
        genPairs++;
        const clear0 = evalTrack(lt, tE) - evalTrack(ft, tE);
        clear0Hist.push(clear0);
        const gap = Math.min(NOMINAL_GAP_M, Math.max(0, clear0 - 0.5));
        let secs = 0;
        let maxPen = -Infinity;
        const tEnd = ft[ft.length - 1].t;
        for (let t = tE; t <= tEnd; t += 1000) {
          const pen = evalTrack(ft, t) - (evalTrack(lt, t) - gap);
          if (pen > 1.0) secs++;
          if (pen > maxPen) maxPen = pen;
        }
        if (secs === 0) continue;
        genViolTracks++;
        genViolSeconds += secs;
        const pen0 = evalTrack(ft, tE) - (evalTrack(lt, tE) - gap);
        if (pen0 > 1.0) genClass.inherited++;
        else genClass.grown++;
        if (maxPen > genMaxPen) genMaxPen = maxPen;
        genRows.push({
          fKey: f.v.key,
          lKey: l.v.key,
          line: f.v.line,
          track: name,
          clear0: round1(clear0),
          gap: round1(gap),
          pen0: round1(pen0),
          maxPen: round1(maxPen),
          secs,
          standing: evalTrack(ft, Math.min(tEnd, tE + 60_000)) - evalTrack(ft, tE) < 5,
        });
      }
    }
  }
}

function reportGenerator(): void {
  console.log(`\n── generator-equivalent (§14.4 effective-gap) ──────────────`);
  console.log(
    `pair-tracks ${genPairs} · violating tracks ${genViolTracks} · violating seconds ${genViolSeconds} · max pen ${round1(genMaxPen)} m`,
  );
  console.log(`class: inherited(pen>1 already at t_E) ${genClass.inherited} · grown ${genClass.grown}`);
  const c = clear0Hist.slice().sort((a, b) => a - b);
  if (c.length > 0) {
    const q = (k: number): number => round1(c[Math.min(c.length - 1, Math.floor((k / 100) * c.length))]);
    console.log(`clear0 (leader − follower at t_E): p1 ${q(1)} p5 ${q(5)} p50 ${q(50)} p95 ${q(95)} min ${round1(c[0])}`);
    console.log(
      `clear0 < 0.5 (gap floors to 0): ${c.filter((x) => x < 0.5).length} / ${c.length}` +
        ` · clear0 in [−5,−1) (frozen-overlap class): ${c.filter((x) => x >= -5 && x < -1).length}` +
        ` · clear0 < −5 (leader dropped as inverted): ${c.filter((x) => x < -5).length}`,
    );
  }
  if (genRows.length > 0) {
    console.log('worst 15 (generator basis):');
    for (const r of genRows.sort((a, b) => b.maxPen - a.maxPen).slice(0, 15)) {
      console.log(
        `  L${r.line} ${r.fKey}→${r.lKey} ${r.track} clear0 ${r.clear0}m gap ${r.gap}m ` +
          `pen0 ${r.pen0}m max ${r.maxPen}m ${r.secs}s ${r.standing ? 'STANDING' : 'moving'}`,
      );
    }
    const bySecs = new Map<string, number>();
    for (const r of genRows) bySecs.set(`${r.fKey}→${r.lKey}`, (bySecs.get(`${r.fKey}→${r.lKey}`) ?? 0) + r.secs);
    console.log(
      'violating seconds by pair: ' +
        [...bySecs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}:${v}`).join(' '),
    );
    const st = genRows.filter((r) => r.standing).reduce((a, r) => a + r.secs, 0);
    console.log(`violating seconds with a STANDING follower: ${st} / ${genViolSeconds}`);
  }
}

function report(): void {
  const n = rows.length;
  console.log(`\n── G12 bytes-side probe ────────────────────────────────────`);
  console.log(`emissions seen ${emissionsSeen} · pair-tracks judged ${pairTracks} · crossings ${n}`);
  if (n === 0) return;
  const pct = (k: number): number => {
    const s = rows.map((r) => r.worstM).sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((k / 100) * s.length))];
  };
  console.log(
    `worst pen: p50 ${pct(50)} p90 ${pct(90)} p99 ${pct(99)} max ${Math.max(...rows.map((r) => r.worstM))}`,
  );
  const bins = [0.5, 1, 2, 5, 10, 20, 50, 100, Infinity];
  const hist = new Array(bins.length).fill(0);
  for (const r of rows) hist[bins.findIndex((b) => r.worstM <= b)]++;
  console.log('magnitude histogram: ' + bins.map((b, i) => `≤${b}m:${hist[i]}`).join(' '));
  const tally = (f: (r: Row) => string): void => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(f(r), (m.get(f(r)) ?? 0) + 1);
    console.log(
      '  ' +
        [...m.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([k, v]) => `${k}:${v}`)
          .join(' '),
    );
  };
  console.log('by class:');
  tally((r) => r.cls);
  console.log('by track:');
  tally((r) => r.track);
  console.log('by line:');
  tally((r) => `L${r.line}`);
  console.log('by pair:');
  tally((r) => `${r.fKey}→${r.lKey}`);
  console.log('by standing (follower/leader):');
  tally((r) => `${r.fStanding ? 'fS' : 'fM'}/${r.lStanding ? 'lS' : 'lM'}`);
  console.log('by follower position (nearest stop / terminus):');
  tally((r) => `${r.fNearStopM < 50 ? 'stopzone' : 'midleg'}/${r.fTerminusM < 150 ? 'terminus' : 'inline'}`);
  console.log('by ordering separation:');
  tally((r) => (r.ordSepM < 30 ? 'sep<30' : r.ordSepM < 60 ? 'sep30-60' : r.ordSepM < 150 ? 'sep60-150' : 'sep>150'));
  console.log('by fix age (follower/leader):');
  tally((r) => `${r.fFixAgeS <= 30 ? 'fresh' : 'stale'}/${r.lFixAgeS <= 30 ? 'fresh' : 'stale'}`);
  console.log('by emitted age (leader curve older than follower?):');
  tally((r) => (r.lEmitAgeS > r.fEmitAgeS + 3 ? 'leader-older' : r.fEmitAgeS > r.lEmitAgeS + 3 ? 'follower-older' : 'same-cycle'));
  console.log('by disc flags:');
  tally((r) => `${r.fDisc ? 'fD' : '-'}/${r.lDisc ? 'lD' : '-'}`);
  console.log('\nworst 15:');
  for (const r of [...rows].sort((a, b) => b.worstM - a.worstM).slice(0, 15)) {
    console.log(
      `  ${new Date(r.atMs).toISOString().slice(11, 19)} L${r.line} ${r.fKey}→${r.lKey} ${r.track} ` +
        `worst ${r.worstM}m @+${r.worstAtS}s (t0 ${r.atT0M}m, ${r.cls}) sep ${r.ordSepM}m ` +
        `fixAge ${r.fFixAgeS}/${r.lFixAgeS}s emitAge ${r.fEmitAgeS}/${r.lEmitAgeS}s ` +
        `stand ${r.fStanding ? 'F' : '-'}${r.lStanding ? 'L' : '-'} stop ${r.fNearStopM}m term ${r.fTerminusM}m`,
    );
  }
  const gr = rows.filter((r) => r.cls === 'grown');
  if (gr.length > 0) {
    console.log(`\ngrown class (${gr.length}): worst ${Math.max(...gr.map((r) => r.worstM))}m; sample:`);
    for (const r of gr.sort((a, b) => b.worstM - a.worstM).slice(0, 10)) {
      console.log(
        `  L${r.line} ${r.fKey}→${r.lKey} ${r.track} t0 ${r.atT0M}m → ${r.worstM}m @+${r.worstAtS}s ` +
          `sep ${r.ordSepM}m stand ${r.fStanding ? 'F' : '-'}${r.lStanding ? 'L' : '-'} stop ${r.fNearStopM}m`,
      );
    }
  }
}

async function main(): Promise<void> {
  await refreshPack();
  const until = Date.now() + DURATION_S * 1000;
  let lastPack = Date.now();
  while (Date.now() < until) {
    try {
      const [sb, live] = await Promise.all([
        get<{ serverNowMs: number; vehicles: ShadowVehicle[] }>('/api/shadow-trajectories'),
        get<{ vehicles: LiveVehicle[] }>('/api/live'),
      ]);
      scan(sb, live.vehicles);
      scanGenerator(sb, live.vehicles);
    } catch (e) {
      console.log('poll error', e instanceof Error ? e.message : e);
    }
    if (Date.now() - lastPack > 300_000) {
      await refreshPack().catch(() => {});
      lastPack = Date.now();
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  report();
  reportGenerator();
}

void main();
