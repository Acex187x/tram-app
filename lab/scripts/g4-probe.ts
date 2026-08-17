// One-off G4 drill-down probe (diagnostic, 2026-08-17): recomputes the G4
// curve gate from SERVED shadow bytes + the geometry pack, and classifies every
// violating segment by mechanism — is it the FIRST segment(s) after a seam
// (seam-inherited speed above the local curve envelope), or an interior chord
// lerping across a protected dip?
//
//   cd lab && TSX_TSCONFIG_PATH=$PWD/tsconfig.runtime.json \
//     DURATION_S=600 ./node_modules/.bin/tsx scripts/g4-probe.ts
//
// Wire math + the imported curve-envelope profile only (sanctioned by design
// §8: offline checkers may import the speed profile for curve checks).

import type { RouteGeometry } from '@/lib/types';
import { curveEnvAt, driveProfileFor } from '../src/drive';
import { evalTrack, type TrackPoint } from '../src/trajectory';

const BASE = process.env.LAB_URL ?? 'https://tram-lab.acex.sh';
const DURATION_S = Number(process.env.DURATION_S ?? 600);
const POLL_MS = 2000;

interface ShadowVehicle {
  key: string;
  tripId: string;
  anchorMs: number;
  emittedAtMs: number;
  discontinuity: boolean;
  opinion: TrackPoint[];
  smooth: TrackPoint[];
}

const get = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
};

let geoms = new Map<string, RouteGeometry>(); // tripId → geometry
async function refreshPack(): Promise<void> {
  const pack = await get<{ shapes: RouteGeometry[]; trips: Record<string, string> }>(
    '/api/geometry-pack',
  );
  const byShape = new Map(pack.shapes.map((s) => [s.shapeId, s]));
  const m = new Map<string, RouteGeometry>();
  for (const [tripId, shapeId] of Object.entries(pack.trips)) {
    const g = byShape.get(shapeId);
    if (g) m.set(tripId, g);
  }
  geoms = m;
}

const seen = new Set<string>();
const last = new Map<string, ShadowVehicle>();
let emissions = 0;
let tracks = 0;
let segments = 0;
let violations = 0;
const byClass = { seg1: 0, seg2: 0, interior: 0 };
const byTrack = { opinion: 0, smooth: 0 };
let seamHot = 0; // violating first-segs where prev chord speed at E already exceeded env(seam pos)
let newAnchor = 0; // violating emissions whose anchor advanced (fix re-emission)

function checkTrack(
  v: ShadowVehicle,
  name: 'opinion' | 'smooth',
  geom: RouteGeometry,
  prev: ShadowVehicle | undefined,
): void {
  const tr = v[name];
  const profile = driveProfileFor(geom);
  tracks++;
  for (let i = 1; i < tr.length; i++) {
    const dtS = (tr[i].t - tr[i - 1].t) / 1000;
    if (dtS <= 0) continue;
    segments++;
    const vSeg = (tr[i].s - tr[i - 1].s) / dtS;
    const midS = (tr[i].s + tr[i - 1].s) / 2;
    const cap = curveEnvAt(profile, geom, midS);
    if (vSeg <= cap * 1.05 + 0.3) continue;
    violations++;
    byTrack[name]++;
    if (i === 1) byClass.seg1++;
    else if (i === 2) byClass.seg2++;
    else byClass.interior++;
    let seamNote = '';
    if (i <= 2 && prev) {
      const E = v.emittedAtMs;
      // chord speed of the PREVIOUS emission's same track at E, and the raw
      // envelope at the seam position — was the inherited state already hot?
      const pTr = prev[name];
      let k = 1;
      while (k < pTr.length - 1 && pTr[k].t < E) k++;
      const pdt = (pTr[k].t - pTr[k - 1].t) / 1000;
      const chord = pdt > 0 ? (pTr[k].s - pTr[k - 1].s) / pdt : 0;
      const seamS = evalTrack(v[name], E);
      const envSeam = curveEnvAt(profile, geom, seamS);
      if (chord > envSeam) seamHot++;
      if (prev.anchorMs !== v.anchorMs) newAnchor++;
      seamNote = ` prevChord@E=${chord.toFixed(2)} envSeam=${envSeam.toFixed(2)} anchor=${prev.anchorMs !== v.anchorMs ? 'fix' : 'age'} disc=${v.discontinuity}`;
    }
    console.log(
      `G4 ${v.key} ${name} seg#${i}/${tr.length - 1} t+${((tr[i - 1].t - v.emittedAtMs) / 1000).toFixed(0)}s ` +
        `vSeg=${vSeg.toFixed(2)} cap=${cap.toFixed(2)} mid=${midS.toFixed(0)}m${seamNote}`,
    );
  }
}

async function main(): Promise<void> {
  await refreshPack();
  const t0 = Date.now();
  let lastPack = t0;
  while (Date.now() - t0 < DURATION_S * 1000) {
    if (Date.now() - lastPack > 120_000) {
      await refreshPack().catch(() => {});
      lastPack = Date.now();
    }
    const b = await get<{ vehicles: ShadowVehicle[] }>('/api/shadow-trajectories').catch(
      () => null,
    );
    if (b !== null && Array.isArray(b.vehicles)) {
      for (const v of b.vehicles) {
        const id = `${v.key}@${v.emittedAtMs}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const geom = geoms.get(v.tripId);
        const prev = last.get(v.key);
        if (geom) {
          emissions++;
          checkTrack(v, 'opinion', geom, prev);
          checkTrack(v, 'smooth', geom, prev);
        }
        last.set(v.key, v);
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  console.log(
    `\nprobe done: ${emissions} emissions, ${tracks} tracks, ${segments} segments, ` +
      `${violations} G4 violations (opinion ${byTrack.opinion} / smooth ${byTrack.smooth}; ` +
      `seg1 ${byClass.seg1}, seg2 ${byClass.seg2}, interior ${byClass.interior}; ` +
      `seam-hot ${seamHot}, fix-anchored ${newAnchor})`,
  );
}

void main();
