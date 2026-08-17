// Matched comparison of the curvegen-v3 SHADOW variants against the published
// tracks: only events where EVERY listed variant scored (same key, same at-fix
// instant) enter the stats — the same matched-n discipline score-report.mjs
// applies to the published set, extended to ml-drive/ml-drive-smooth.
//
//   docker exec -w /repo/lab tram-lab node scripts/matched-report.mjs 30
//   docker exec -w /repo/lab tram-lab node scripts/matched-report.mjs 30 1786957000000
//
// argv[2] = window minutes (default 30); argv[3] = optional hard floor on atMs
// (report only rows AFTER this instant — the post-restart window discipline).

import Database from 'better-sqlite3';

const windowMin = Number(process.argv[2] ?? 30);
const floorMs = process.argv[3] ? Number(process.argv[3]) : 0;
const db = new Database(process.env.LAB_DB ?? '/data/lab.db', { readonly: true });

const VARIANTS = ['ml-gbdt', 'ml-mode', 'ml-smooth', 'ml-drive', 'ml-drive-smooth'];
const sinceMs = Math.max(Date.now() - windowMin * 60_000, floorMs);

const rows = db
  .prepare(
    `SELECT atMs, key, variant, errM, absErrM FROM scores
     WHERE atMs >= ? AND variant IN (${VARIANTS.map(() => '?').join(',')})`,
  )
  .all(sinceMs, ...VARIANTS);

const events = new Map(); // atMs|key → {variant → {errM, absErrM}}
for (const r of rows) {
  const id = `${r.atMs}|${r.key}`;
  let e = events.get(id);
  if (!e) {
    e = {};
    events.set(id, e);
  }
  e[r.variant] = r;
}

const matched = [...events.values()].filter((e) => VARIANTS.every((v) => e[v]));
console.log(
  `window: last ${windowMin} min (rows since ${new Date(sinceMs).toISOString()})` +
    ` — ${events.size} events, ${matched.length} matched on [${VARIANTS.join(', ')}]`,
);

const pct = (arr, p) => {
  if (arr.length === 0) return NaN;
  const a = [...arr].sort((x, y) => x - y);
  const k = ((a.length - 1) * p) / 100;
  const f = Math.floor(k);
  return a[f] + (a[Math.min(f + 1, a.length - 1)] - a[f]) * (k - f);
};

for (const v of VARIANTS) {
  const abs = matched.map((e) => e[v].absErrM);
  const signed = matched.map((e) => e[v].errM);
  const mean = abs.reduce((a, b) => a + b, 0) / (abs.length || 1);
  const sMean = signed.reduce((a, b) => a + b, 0) / (signed.length || 1);
  console.log(
    `${v.padEnd(16)} n=${String(abs.length).padStart(6)}  mean=${mean.toFixed(1).padStart(7)} m` +
      `  p50=${pct(abs, 50).toFixed(1).padStart(7)} m  p90=${pct(abs, 90).toFixed(1).padStart(7)} m` +
      `  signed=${sMean.toFixed(1).padStart(7)} m`,
  );
}
