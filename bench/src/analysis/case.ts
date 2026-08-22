// Таймлайн одной машины: сырые фиксы vs trajBatch-эмиссии (якорь, opinion[0],
// smooth[0]) — видно, откатывается ли серверная кривая к пришедшему at_stop
// фиксу или держится впереди.
//
//   ... tsx bench/src/analysis/case.ts <key> [fromHH:MM:SS] [toHH:MM:SS]

import * as fs from 'node:fs';
import * as path from 'node:path';

const key = process.argv[2];
const from = process.argv[3] ?? '00:00:00';
const to = process.argv[4] ?? '23:59:59';
const ROOT = path.resolve(__dirname, '..', '..');
const hms = (ms: number) => new Date(ms).toISOString().slice(11, 19);

const rows: { t: number; line: string }[] = [];
for (const l of fs.readFileSync(path.join(ROOT, 'sessions/hunt1.jsonl'), 'utf8').split('\n')) {
  if (!l) continue;
  const ev = JSON.parse(l);
  if (ev.kind === 'fixSeed' || ev.kind === 'fixBatch') {
    for (const v of ev.vehicles ?? ev.changed ?? []) {
      if (v.key !== key) continue;
      rows.push({
        t: ev.t,
        line:
          `FIX  obs=${hms(v.observedAtMs)} s=${v.shapeDistM} state=${v.statePosition} ` +
          `last=${v.lastStopId} next=${v.nextStopId} delay=${v.delaySeconds} trip=${v.tripId}`,
      });
    }
  } else if (ev.kind === 'trajSeed' || ev.kind === 'trajBatch') {
    for (const v of ev.vehicles ?? ev.batch?.changed ?? []) {
      if (v.key !== key) continue;
      const op = v.opinion ?? [];
      const sm = v.smooth ?? [];
      const at = (p: { s: number; t: number }[], dtS: number) => {
        // значение кривой через dtS секунд после эмиссии (линейная интерполяция)
        const t0 = v.emittedAtMs + dtS * 1000;
        for (let i = 0; i < p.length - 1; i++)
          if (p[i].t <= t0 && t0 <= p[i + 1].t)
            return p[i].s + ((p[i + 1].s - p[i].s) * (t0 - p[i].t)) / (p[i + 1].t - p[i].t);
        return p.length ? p[p.length - 1].s : NaN;
      };
      rows.push({
        t: ev.t,
        line:
          `TRAJ emit=${hms(v.emittedAtMs)} anchor=${v.anchorS}@${hms(v.anchorMs)} ` +
          `op0=${op[0]?.s?.toFixed(0)} op30s=${at(op, 30).toFixed(0)} op60s=${at(op, 60).toFixed(0)} ` +
          `sm0=${sm[0]?.s?.toFixed(0)} src=${v.source} disc=${v.discontinuity}`,
      });
    }
  }
}
for (const r of rows.sort((a, b) => a.t - b.t)) {
  const t = hms(r.t);
  if (t >= from && t <= to) console.log(`${t} ${r.line}`);
}
