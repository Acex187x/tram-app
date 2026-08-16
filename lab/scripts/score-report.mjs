// Matched-pair scoring report for the physics-v3 variants.
//
//   docker exec tram-lab node /repo/lab/scripts/score-report.mjs [windowMin]
//
// Every variant is scored on the SAME at-fix probe, but availability differs
// during warm-up, so the honest comparison is the MATCHED subset: events
// (atMs, key) where every compared variant produced a prediction. Because all
// variants share one `actual`, the difference of their signed errors IS the
// distance between the rendered markers — that is how "what modal stops and
// continuity cost, in meters" is measured here rather than assumed.

import Database from 'better-sqlite3';

const WINDOW_MIN = Number(process.argv[2] ?? process.env.WINDOW_MIN ?? 15);
const DB = process.env.LAB_DB ?? '/data/lab.db';
const CORE = ['ml-gbdt', 'ml-mode', 'ml-smooth', 'engine-live'];

const db = new Database(DB, { readonly: true });
const since = Date.now() - WINDOW_MIN * 60_000;

const pct = (a, p) => {
  if (a.length === 0) return NaN;
  const k = ((a.length - 1) * p) / 100;
  const f = Math.floor(k);
  const c = Math.min(f + 1, a.length - 1);
  return a[f] + (a[c] - a[f]) * (k - f);
};
const stats = (errs) => {
  const abs = errs.map(Math.abs).sort((x, y) => x - y);
  return {
    n: errs.length,
    mean: abs.reduce((a, b) => a + b, 0) / abs.length,
    p50: pct(abs, 50),
    p90: pct(abs, 90),
    signed: errs.reduce((a, b) => a + b, 0) / errs.length,
  };
};
const row = (name, s) =>
  `${name.padEnd(14)} n=${String(s.n).padStart(6)}  mean=${s.mean.toFixed(1).padStart(7)} m  ` +
  `p50=${s.p50.toFixed(1).padStart(6)} m  p90=${s.p90.toFixed(1).padStart(7)} m  signed=${s.signed.toFixed(1).padStart(8)} m`;

const rows = db
  .prepare('SELECT atMs, key, variant, errM, horizonS FROM scores WHERE atMs >= ?')
  .all(since);
console.log(`window: last ${WINDOW_MIN} min — ${rows.length} score rows\n`);

// ── all variants, unmatched ─────────────────────────────────────────────────
const byVariant = new Map();
for (const r of rows) {
  let a = byVariant.get(r.variant);
  if (!a) byVariant.set(r.variant, (a = []));
  a.push(r.errM);
}
console.log('── all variants (unmatched) ───────────────────────────────────────');
for (const v of [...byVariant.keys()].sort()) console.log(row(v, stats(byVariant.get(v))));

// ── matched subset ──────────────────────────────────────────────────────────
const events = new Map();
for (const r of rows) {
  const k = `${r.atMs}|${r.key}`;
  let e = events.get(k);
  if (!e) events.set(k, (e = { key: r.key, atMs: r.atMs, horizonS: r.horizonS, v: new Map() }));
  e.v.set(r.variant, r.errM);
}
const matched = [...events.values()].filter((e) => CORE.every((v) => e.v.has(v)));
console.log(`\n── matched subset: events where all of [${CORE.join(', ')}] fired ──`);
console.log(`matched events: ${matched.length} of ${events.size}`);
for (const v of CORE) console.log(row(v, stats(matched.map((e) => e.v.get(v)))));

// ── anchor state split (at_stop is where modal stops act) ───────────────────
// The anchor fix is the one exactly horizonS before the fix that triggered
// scoring. A poll cycle can carry SEVERAL batches, so "second newest fix" is
// not reliable — search the recent fixes for the pair whose gap is horizonS.
const recentFixes = db.prepare(
  'SELECT obsAtMs, statePos FROM fixes WHERE key = ? AND obsAtMs <= ? ORDER BY obsAtMs DESC LIMIT 6',
);
const split = { at_stop: [], moving: [], unknown: [] };
for (const e of matched) {
  const f = recentFixes.all(e.key, e.atMs);
  const gapMs = Math.round(e.horizonS * 1000);
  let anchor = null;
  for (const trigger of f) {
    anchor = f.find((x) => Math.abs(trigger.obsAtMs - x.obsAtMs - gapMs) <= 50) ?? null;
    if (anchor) break;
  }
  split[anchor ? (anchor.statePos === 'at_stop' ? 'at_stop' : 'moving') : 'unknown'].push(e);
}
for (const [state, es] of Object.entries(split)) {
  if (es.length === 0) continue;
  console.log(`\n── matched, anchor fix = ${state} (${es.length} events) ──`);
  for (const v of CORE) console.log(row(v, stats(es.map((e) => e.v.get(v)))));
}

// ── marker-distance readings (same actual ⇒ Δerr = Δrendered position) ──────
const dist = (a, b, es) => {
  const d = es.map((e) => Math.abs(e.v.get(a) - e.v.get(b))).sort((x, y) => x - y);
  return `p50=${pct(d, 50).toFixed(1)} m  p90=${pct(d, 90).toFixed(1)} m  mean=${(d.reduce((x, y) => x + y, 0) / d.length).toFixed(1)} m  max=${d[d.length - 1].toFixed(0)} m`;
};
console.log('\n── how far apart the renderings are, in meters ────────────────────');
for (const [label, es] of [['all matched', matched], ['at_stop anchors', split.at_stop], ['moving anchors', split.moving]]) {
  if (es.length === 0) continue;
  console.log(`${label} (n=${es.length})`);
  console.log(`   modal stops   |ml-mode − ml-gbdt|    ${dist('ml-mode', 'ml-gbdt', es)}`);
  console.log(`   continuity    |ml-smooth − ml-mode|  ${dist('ml-smooth', 'ml-mode', es)}`);
  console.log(`   both          |ml-smooth − ml-gbdt|  ${dist('ml-smooth', 'ml-gbdt', es)}`);
}
