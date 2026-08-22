// РЕПЛЕЕР: детерминированный прогон записанной сессии через НАСТОЯЩИЙ
// клиентский код (см. harness.ts) на виртуальных часах.
//
//   npx tsx bench/src/replay.ts sessions/<name>.jsonl [--key 9369] [--dump]
//
// Выход: сводка аномалий по классам + bench/sessions/<name>.anomalies.jsonl
// (полные дампы PhysicsDebugInfo на момент срабатывания). --key ограничивает
// прогон одним трамваем и печатает его посекундную телеметрию (--dump).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Bench, type SessionEvent } from './harness';
import { Detectors } from './detect';

const file = process.argv[2];
if (!file) throw new Error('usage: replay.ts sessions/<name>.jsonl [--key K] [--dump]');
const onlyKey = process.argv.includes('--key')
  ? process.argv[process.argv.indexOf('--key') + 1]
  : null;
const dump = process.argv.includes('--dump');

const lines = fs
  .readFileSync(path.resolve(__dirname, '..', file), 'utf8')
  .split('\n')
  .filter(Boolean);
const events: SessionEvent[] = lines.map((l) => JSON.parse(l) as SessionEvent);

const bench = new Bench();
const det = new Detectors();

let virtualMs = events[0].t;
let ticks = 0;
const TICK_MS = 1_000;

const tick = (upToMs: number): void => {
  for (; virtualMs + TICK_MS <= upToMs; virtualMs += TICK_MS) {
    ticks++;
    const keys = onlyKey ? [onlyKey] : bench.keys();
    for (const key of keys) {
      const { diag, state } = bench.snapshot(key, virtualMs);
      if (!diag || !state) continue;
      det.check(key, virtualMs, diag, state.snapshot, bench.geometry(state.snapshot.tripId));
      if (dump && onlyKey) {
        console.log(
          `${new Date(virtualMs).toISOString().slice(11, 19)} s=${diag.simDistM.toFixed(0)} ` +
            `v=${diag.simSpeedKmh.toFixed(0)}км/ч src=${diag.renderSource} shim=${diag.shimBranch} ` +
            `τ=${diag.tauS?.toFixed(1) ?? '—'} fix=${diag.obsDistM.toFixed(0)}(${diag.fixAgeS.toFixed(0)}с) ` +
            `к−о=${diag.fixCoordVsAxisM?.toFixed(0) ?? '—'} Δтчк=${diag.deltaM?.toFixed(0) ?? '—'} ` +
            `якорь=${diag.anchorFixS?.toFixed(0) ?? '—'}(${diag.anchorAgeS?.toFixed(0) ?? '—'}с) ` +
            `jump=${diag.lastJumpM?.toFixed(0) ?? '—'}`,
        );
      }
    }
  }
};

for (const e of events) {
  tick(e.t);
  bench.feed(e);
}
tick(virtualMs + TICK_MS);

// ── отчёт ──
const byKind = new Map<string, number>();
for (const a of det.anomalies) byKind.set(a.kind, (byKind.get(a.kind) ?? 0) + 1);
console.log(`\nticks=${ticks} vehicles=${bench.keys().length} anomalies=${det.anomalies.length}`);
for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);

const worst = det.anomalies.slice(0, 30);
for (const a of worst) {
  console.log(
    `  [${a.kind}] ${a.key} @${new Date(a.atMs).toISOString().slice(11, 19)} — ${a.detail}`,
  );
}
const outFile = path.resolve(__dirname, '..', file.replace(/\.jsonl$/, '.anomalies.jsonl'));
fs.writeFileSync(outFile, det.anomalies.map((a) => JSON.stringify(a)).join('\n'));
console.log(`full dumps → ${outFile}`);
