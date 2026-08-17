// One-off G5 episode classifier (diagnostic, 2026-08-17): from served shadow
// bytes, split BEHIND catch-up episodes by their start state — a standing
// smooth pays the jerk-limited spin-up (≈ Δv/A + A/J before any surplus
// exists), which the design §6 latency math never modelled. Reports the
// standing share and per-class convergence latency.
//
//   cd lab && TSX_TSCONFIG_PATH=$PWD/tsconfig.runtime.json \
//     DURATION_S=1500 ./node_modules/.bin/tsx scripts/g5-probe.ts

import { evalTrack, type TrackPoint } from '../src/trajectory';

const BASE = process.env.LAB_URL ?? 'https://tram-lab.acex.sh';
const DURATION_S = Number(process.env.DURATION_S ?? 1500);

interface ShadowVehicle {
  key: string;
  anchorMs: number;
  emittedAtMs: number;
  discontinuity: boolean;
  opinion: TrackPoint[];
  smooth: TrackPoint[];
}

const get = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
};

const seen = new Set<string>();
const last = new Map<string, ShadowVehicle>();
const moving: number[] = [];
const standing: number[] = [];
let movingUnconv = 0;
let standingUnconv = 0;

const pct = (arr: number[], p: number): number => {
  if (arr.length === 0) return NaN;
  const a = [...arr].sort((x, y) => x - y);
  const k = ((a.length - 1) * p) / 100;
  const f = Math.floor(k);
  return a[f] + (a[Math.min(f + 1, a.length - 1)] - a[f]) * (k - f);
};

async function main(): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < DURATION_S * 1000) {
    const b = await get<{ vehicles: ShadowVehicle[] }>('/api/shadow-trajectories').catch(
      () => null,
    );
    if (b !== null && Array.isArray(b.vehicles)) {
      for (const v of b.vehicles) {
        const id = `${v.key}@${v.emittedAtMs}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const prev = last.get(v.key);
        last.set(v.key, v);
        if (!prev || prev.emittedAtMs === v.emittedAtMs) continue;
        if (prev.anchorMs === v.anchorMs || v.discontinuity) continue;
        const E = v.emittedAtMs;
        const gSigned = evalTrack(v.opinion, E) - evalTrack(v.smooth, E);
        if (gSigned < 20 || gSigned > 120) continue; // BEHIND, near band only
        // Start state: first emitted smooth segment's chord speed.
        const s = v.smooth;
        const dt0 = (s[1].t - s[0].t) / 1000;
        const v0 = dt0 > 0 ? (s[1].s - s[0].s) / dt0 : 0;
        const horizonS = Math.round((v.opinion[v.opinion.length - 1].t - E) / 1000);
        let convS: number | null = null;
        for (let dt = 0; dt <= horizonS; dt++) {
          if (Math.abs(evalTrack(v.smooth, E + dt * 1000) - evalTrack(v.opinion, E + dt * 1000)) < 15) {
            convS = dt;
            break;
          }
        }
        const bucket = v0 < 1.0 ? standing : moving;
        if (convS === null) {
          if (v0 < 1.0) standingUnconv++;
          else movingUnconv++;
        } else bucket.push(convS);
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  const fmt = (a: number[], unc: number): string =>
    `n=${a.length} p50=${pct(a, 50).toFixed(1)}s p90=${pct(a, 90).toFixed(1)}s unconv=${unc}`;
  console.log(`near-band BEHIND episodes by start state:`);
  console.log(`  standing start (v0 < 1 m/s): ${fmt(standing, standingUnconv)}`);
  console.log(`  moving start:                ${fmt(moving, movingUnconv)}`);
  const total = standing.length + moving.length + standingUnconv + movingUnconv;
  console.log(
    `  standing share: ${(((standing.length + standingUnconv) / Math.max(1, total)) * 100).toFixed(0)} %`,
  );
}

void main();
