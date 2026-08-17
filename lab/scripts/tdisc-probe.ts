// T_disc threshold selector (diagnostic, 2026-08-17): from served shadow
// bytes, record every fix re-emission's seam gap |opinion(E) − smooth(E)| and
// its CARRY — the integral of |smooth − opinion| over this emission's horizon,
// i.e. what driving the gap off (instead of teleporting) costs the at-instant
// metric. Prints, for candidate flat thresholds T, the would-be flag rate and
// the share of total carry a teleport-at-T would delete — the data behind the
// §7 DISC_FLOOR tuning deviation.
//
//   cd lab && TSX_TSCONFIG_PATH=$PWD/tsconfig.runtime.json \
//     DURATION_S=900 ./node_modules/.bin/tsx scripts/tdisc-probe.ts

import { evalTrack, type TrackPoint } from '../src/trajectory';

const BASE = process.env.LAB_URL ?? 'https://tram-lab.acex.sh';
const DURATION_S = Number(process.env.DURATION_S ?? 900);

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
/** One episode: seam gap (m) + carry integral (m·s) over the horizon. */
const eps: { gap: number; carry: number }[] = [];
let fixTrans = 0;
let alreadyFlagged = 0;

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
        if (prev.anchorMs === v.anchorMs) continue; // fix-driven only
        fixTrans++;
        if (v.discontinuity) {
          alreadyFlagged++;
          continue;
        }
        const E = v.emittedAtMs;
        const gap = Math.abs(evalTrack(v.opinion, E) - evalTrack(v.smooth, E));
        const horizonS = Math.round((v.opinion[v.opinion.length - 1].t - E) / 1000);
        let carry = 0;
        for (let dt = 0; dt <= horizonS; dt++) {
          carry += Math.abs(evalTrack(v.smooth, E + dt * 1000) - evalTrack(v.opinion, E + dt * 1000));
        }
        eps.push({ gap, carry });
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  eps.sort((a, b) => a.gap - b.gap);
  const totalCarry = eps.reduce((s, e) => s + e.carry, 0);
  console.log(
    `fix re-emissions ${fixTrans} (${alreadyFlagged} already flagged = ` +
      `${((100 * alreadyFlagged) / Math.max(1, fixTrans)).toFixed(2)} %), episodes ${eps.length}, ` +
      `total carry ${(totalCarry / 1000).toFixed(0)} km·s`,
  );
  const pctGap = (p: number): number => eps[Math.floor(((eps.length - 1) * p) / 100)]?.gap ?? NaN;
  console.log(
    `gap CDF: p50=${pctGap(50).toFixed(0)} p90=${pctGap(90).toFixed(0)} p95=${pctGap(95).toFixed(0)} ` +
      `p97=${pctGap(97).toFixed(0)} p98=${pctGap(98).toFixed(0)} p99=${pctGap(99).toFixed(0)} m`,
  );
  for (const T of [150, 180, 200, 250, 300, 350]) {
    const over = eps.filter((e) => e.gap > T);
    const carryOver = over.reduce((s, e) => s + e.carry, 0);
    const rate = (100 * (over.length + alreadyFlagged)) / Math.max(1, fixTrans);
    console.log(
      `T=${String(T).padStart(3)} m: would-flag ${over.length} (+${alreadyFlagged} existing) = ` +
        `${rate.toFixed(2)} % of fix re-emissions; deletes ${((100 * carryOver) / Math.max(1, totalCarry)).toFixed(0)} % of carry`,
    );
  }
}

void main();
