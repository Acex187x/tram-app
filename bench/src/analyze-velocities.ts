/** Assess real, same-emission internal velocities before optional-v rollout.
 * No velocities are inferred: points must match the public wire exactly.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { packTrack } from '@/lib/physics/bundle';
import { evalTrajectory, crossingTimeMs, type PreparedTrack } from '@/lib/physics/evaluator';
const rows = readFileSync(process.argv[2], 'utf8')
  .split('\n')
  .flatMap((l) => {
    try {
      return [JSON.parse(l).value];
    } catch {
      return [];
    }
  });
const seen = new Set<string>();
const jumps = [[] as number[], [] as number[]];
const differences: number[] = [];
const pairs: { linear: Float64Array; cubic: Float64Array }[] = [];
let tracks = 0,
  segments = 0,
  eligible = 0;
const velocity = (track: Float64Array, t: number) =>
  (evalTrajectory(track, t + 0.1) - evalTrajectory(track, t - 0.1)) * 5000;
for (const r of rows)
  for (const name of ['smooth', 'opinion']) {
    const id = `${r.key}:${r.emittedAtMs}:${name}`;
    if (seen.has(id) || !r[name]?.points || !r[name]?.v) continue;
    seen.add(id);
    const p = r[name].points,
      v = r[name].v;
    if (p.length !== v.length) continue;
    const linear = packTrack(p),
      cubic = packTrack(p.map((k: any, i: number) => ({ ...k, v: v[i] }))) as PreparedTrack;
    tracks++;
    segments += p.length - 1;
    const h = cubic.hermite;
    if (h) for (let i = 0; i < h.length; i += 3) if (Number.isFinite(h[i])) eligible++;
    for (let i = 1; i < p.length - 1; i++) {
      const t = p[i].t;
      jumps[0].push(Math.abs(velocity(linear, t + 1) - velocity(linear, t - 1)));
      jumps[1].push(Math.abs(velocity(cubic, t + 1) - velocity(cubic, t - 1)));
    }
    for (let t = p[0].t; t <= p.at(-1).t; t += 250)
      differences.push(Math.abs(evalTrajectory(linear, t) - evalTrajectory(cubic, t)));
    pairs.push({ linear, cubic });
  }
const q = (a: number[]) => {
  a.sort((a, b) => a - b);
  return Object.fromEntries(
    [0.5, 0.9, 0.99, 1].map((p) => [p, a[Math.min(a.length - 1, Math.floor(p * a.length))] ?? 0]),
  );
};
const cpu: any = {};
for (const mode of ['linear', 'cubic'] as const) {
  const start = performance.now();
  let checksum = 0;
  for (let i = 0; i < 100000; i++) {
    const tr = pairs[i % pairs.length][mode],
      t = tr[0] + ((tr[tr.length - 2] - tr[0]) * (i % 997)) / 997;
    checksum += evalTrajectory(tr, t);
  }
  cpu[mode + '100kEvalMs'] = performance.now() - start;
  const inverseStart = performance.now();
  for (let i = 0; i < 100000; i++) {
    const tr = pairs[i % pairs.length][mode];
    checksum += crossingTimeMs(tr, tr[1] + ((tr[tr.length - 1] - tr[1]) * (i % 997)) / 997);
  }
  cpu[mode + '100kInverseMs'] = performance.now() - inverseStart;
  cpu[mode + 'ChecksumFinite'] = Number.isFinite(checksum);
}
console.log(
  JSON.stringify(
    {
      tracks,
      segments,
      eligible,
      eligibleRatio: eligible / segments,
      linearKnotSpeedJumpMs: q(jumps[0]),
      cubicKnotSpeedJumpMs: q(jumps[1]),
      linearJumpsOver2: jumps[0].filter((v) => v > 2).length,
      cubicJumpsOver2: jumps[1].filter((v) => v > 2).length,
      positionDifferenceFromLinearM: q(differences),
      cpu,
      caveat:
        'Actual internal velocities on identical real emitted track knots. Position difference is not ground-truth error. Ineligible spans retain linear, so mixed joins may still step.',
    },
    null,
    2,
  ),
);
