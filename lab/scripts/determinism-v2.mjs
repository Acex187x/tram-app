// Determinism gate for physics-v3 (docs/research/physics-v3-protocol.md §3):
// two clients with the same bundle must render the SAME tram at the same
// instant, to the bit.
//
//   node lab/scripts/determinism-v2.mjs fetch [n]     # byte-identity of the
//        cached response across n rapid fetches; saves the bundle to /tmp
//   node lab/scripts/determinism-v2.mjs eval <file>   # pure re-eval digest
//        (20 vehicles × 3 timestamps, both tracks) — run twice, diff the output
//
// `eval` prints a sha256 over the raw IEEE-754 doubles, so any 1-ulp
// difference between two runs (or two processes) changes the digest.

import crypto from 'crypto';
import fs from 'fs';

const BASE = process.env.LAB_URL ?? 'https://tram-lab.acex.sh';
const BUNDLE = '/tmp/v2-bundle.json';

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

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const mode = process.argv[2] ?? 'fetch';

if (mode === 'fetch') {
  const n = Number(process.argv[3] ?? 8);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const t = Date.now();
    const body = await (await fetch(`${BASE}/api/trajectories/v2`)).text();
    rows.push({ i, dtMs: Date.now() - t, atMs: t, bytes: body.length, hash: sha(body), body });
  }
  const span = rows[rows.length - 1].atMs - rows[0].atMs;
  const distinct = new Set(rows.map((r) => r.hash));
  console.log(`${n} fetches spanning ${span} ms (cache TTL is 2000 ms)`);
  for (const r of rows) {
    console.log(`  #${r.i} +${r.atMs - rows[0].atMs}ms  ${r.bytes} bytes  ${r.hash.slice(0, 16)}…`);
  }
  const pairs = rows.slice(1).filter((r, i) => r.hash === rows[i].hash).length;
  console.log(`distinct bodies: ${distinct.size}   identical consecutive pairs: ${pairs}/${n - 1}`);
  const ok = distinct.size <= 2 && pairs >= 1;
  console.log(ok
    ? `OK — repeated fetches inside the TTL window are byte-identical (${distinct.size - 1} cache rollover(s) seen)`
    : 'FAIL — responses are not stable inside the cache window');
  fs.writeFileSync(BUNDLE, rows[rows.length - 1].body);
  console.log(`bundle saved to ${BUNDLE}`);
  process.exit(ok ? 0 : 1);
}

if (mode === 'eval') {
  const file = process.argv[3] ?? BUNDLE;
  const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Deterministic selection: sort by key, take 20; timestamps derived from the
  // bundle itself so the script has no wall-clock input at all.
  const vehicles = [...bundle.vehicles].sort((a, b) => (a.key < b.key ? -1 : 1)).slice(0, 20);
  const out = new Float64Array(vehicles.length * 6);
  const lines = [];
  vehicles.forEach((v, i) => {
    const ts = [v.emittedAtMs + 7_333, v.emittedAtMs + 41_777, v.emittedAtMs + 113_111];
    ts.forEach((t, j) => {
      out[i * 6 + j * 2] = evalTrack(v.opinion, t);
      out[i * 6 + j * 2 + 1] = evalTrack(v.smooth, t);
    });
    lines.push(
      `${v.key} ${ts.map((t, j) => `${out[i * 6 + j * 2]}/${out[i * 6 + j * 2 + 1]}`).join(' ')}`,
    );
  });
  console.log(lines.join('\n'));
  console.log(`vehicles=${vehicles.length} samples=${out.length}`);
  console.log(`digest ${sha(Buffer.from(out.buffer, out.byteOffset, out.byteLength))}`);
  process.exit(0);
}

console.log('usage: determinism-v2.mjs fetch [n] | eval <file>');
process.exit(2);
