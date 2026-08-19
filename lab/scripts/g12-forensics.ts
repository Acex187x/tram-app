// G12 forensics (diagnostic, 2026-08-19): for every same-shape byte-level
// crossing, dump the FULL state of both vehicles — trip ids, shapes, fix ages
// and positions, curve positions, and how far each curve sits past its own
// anchor fix. The aggregate probe (g12-probe.ts) says the crossings cluster on
// line 9 with stale fixes; this says WHY, per event.
//
//   cd lab && TSX_TSCONFIG_PATH=$PWD/tsconfig.runtime.json \
//     DURATION_S=900 ./node_modules/.bin/tsx scripts/g12-forensics.ts

import type { RouteGeometry } from '@/lib/types';
import { evalTrack, type TrackPoint } from '../src/trajectory';

const BASE = process.env.LAB_URL ?? 'https://tram-lab.acex.sh';
const DURATION_S = Number(process.env.DURATION_S ?? 900);

interface SV {
  key: string;
  tripId: string;
  line: string;
  anchorMs: number;
  emittedAtMs: number;
  discontinuity: boolean;
  opinion: TrackPoint[];
  smooth: TrackPoint[];
}
interface LV {
  key: string;
  line: string;
  fixAgeS: number;
  fixDistM: number;
  engineDistM?: number;
}

const get = async <T>(p: string): Promise<T> => {
  const r = await fetch(`${BASE}${p}`);
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return (await r.json()) as T;
};

let tripShape = new Map<string, string>();
let shapes = new Map<string, RouteGeometry>();
async function pack(): Promise<void> {
  const p = await get<{ shapes: RouteGeometry[]; trips: Record<string, string> }>(
    '/api/geometry-pack',
  );
  shapes = new Map(p.shapes.map((s) => [s.shapeId, s]));
  tripShape = new Map(Object.entries(p.trips));
}

const r1 = (x: number): string => x.toFixed(1);
const seen = new Set<string>();
let events = 0;
const tally = new Map<string, number>();
const bump = (k: string): void => tally.set(k, (tally.get(k) ?? 0) + 1);

function scan(sb: { serverNowMs: number; vehicles: SV[] }, live: LV[]): void {
  const L = new Map(live.map((l) => [l.key, l]));
  const now = sb.serverNowMs;
  const byShape = new Map<string, { v: SV; l: LV; ordS: number }[]>();
  for (const v of sb.vehicles) {
    const l = L.get(v.key);
    if (!l) continue;
    if (Math.abs(l.fixAgeS - (now - v.anchorMs) / 1000) > 4) continue;
    const sh = tripShape.get(v.tripId);
    if (!sh) continue;
    let a = byShape.get(sh);
    if (!a) byShape.set(sh, (a = []));
    a.push({ v, l, ordS: l.fixDistM });
  }
  for (const [sh, arr] of byShape) {
    if (arr.length < 2) continue;
    arr.sort((x, y) => x.ordS - y.ordS);
    const g = shapes.get(sh);
    for (let i = 0; i + 1 < arr.length; i++) {
      if (arr[i + 1].ordS - arr[i].ordS < 15) continue;
      const f = arr[i];
      const l = arr[i + 1];
      for (const name of ['opinion', 'smooth'] as const) {
        const ft = f.v[name];
        const lt = l.v[name];
        const t0 = Math.max(ft[0].t, lt[0].t);
        const tE = Math.min(ft[ft.length - 1].t, lt[lt.length - 1].t);
        if (!(tE > t0)) continue;
        let worst = 0;
        for (let t = t0; t <= tE; t += 2000) {
          const p = evalTrack(ft, t) - evalTrack(lt, t);
          if (p > worst) worst = p;
        }
        if (worst <= 0.5) continue;
        const id = `${f.v.key}@${f.v.emittedAtMs}|${l.v.key}@${l.v.emittedAtMs}|${name}`;
        if (seen.has(id)) continue;
        seen.add(id);
        events++;
        const fAhead = evalTrack(ft, now) - f.l.fixDistM;
        const lAhead = evalTrack(lt, now) - l.l.fixDistM;
        // Classification: which side's projection is doing the crossing?
        bump(`shape:${sh}`);
        bump(f.v.tripId === l.v.tripId ? 'sameTrip' : 'diffTrip');
        bump(`termZone:${g && Math.min(evalTrack(ft, now), g.totalM - evalTrack(ft, now)) < 200 ? 'yes' : 'no'}`);
        bump(
          fAhead > lAhead + 100
            ? 'follower-projects-far-more'
            : lAhead > fAhead + 100
              ? 'leader-projects-far-more'
              : 'comparable-projection',
        );
        bump(`fixAge:${f.l.fixAgeS <= 30 ? 'F' : 'S'}${l.l.fixAgeS <= 30 ? 'F' : 'S'}`);
        console.log(
          `[${new Date(now).toISOString().slice(11, 19)}] ${name} ${f.v.key}→${l.v.key} ` +
            `by ${r1(worst)} m  shape ${sh}\n` +
            `    follower ${f.v.key} L${f.v.line} trip ${f.v.tripId} fix ${r1(f.l.fixDistM)}@${f.l.fixAgeS}s ` +
            `curve ${r1(evalTrack(ft, now))} (+${r1(fAhead)} past fix) engine ${f.l.engineDistM === undefined ? '?' : r1(f.l.engineDistM)} ` +
            `emitAge ${Math.round((now - f.v.emittedAtMs) / 1000)}s disc ${f.v.discontinuity}\n` +
            `    leader   ${l.v.key} L${l.v.line} trip ${l.v.tripId} fix ${r1(l.l.fixDistM)}@${l.l.fixAgeS}s ` +
            `curve ${r1(evalTrack(lt, now))} (+${r1(lAhead)} past fix) engine ${l.l.engineDistM === undefined ? '?' : r1(l.l.engineDistM)} ` +
            `emitAge ${Math.round((now - l.v.emittedAtMs) / 1000)}s disc ${l.v.discontinuity}`,
        );
      }
    }
  }
}

async function main(): Promise<void> {
  await pack();
  const until = Date.now() + DURATION_S * 1000;
  let lastPack = Date.now();
  while (Date.now() < until) {
    try {
      const [sb, lv] = await Promise.all([
        get<{ serverNowMs: number; vehicles: SV[] }>('/api/shadow-trajectories'),
        get<{ vehicles: LV[] }>('/api/live'),
      ]);
      scan(sb, lv.vehicles);
    } catch (e) {
      console.log('err', e instanceof Error ? e.message : e);
    }
    if (Date.now() - lastPack > 300_000) {
      await pack().catch(() => {});
      lastPack = Date.now();
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`\n── forensics summary: ${events} crossing events ──`);
  for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
}

void main();
