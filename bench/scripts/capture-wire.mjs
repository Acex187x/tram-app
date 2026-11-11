#!/usr/bin/env node
// Capture a public Convex wire recording in the format bench/src/replay-wire.ts reads.
// Subscribes exactly like the app (fullFleet/fullSet seed, batchesSince cursors
// re-armed every 8 batches, meta heartbeat, clock:now nonce probes) and saves the
// served geometry pack (merged from start + end polls) next to it.
// Public data only: no admin key, no ride GPS.
// Usage: node bench/scripts/capture-wire.mjs <out-prefix> [seconds=330] [url]
import { ConvexClient } from "convex/browser";
import { makeFunctionReference as ref } from "convex/server";
import { createWriteStream, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const [prefix, secondsArg = "330", url = "https://tram-api.acex.sh"] = process.argv.slice(2);
if (!prefix) throw new Error("usage: capture-wire.mjs <out-prefix> [seconds] [url]");
const site = url.replace("tram-api", "tram-site");
const rows = [];
const push = (path, value, extra = {}) =>
  rows.push({ receivedAtMs: Date.now(), path, value, ...extra });
const client = new ConvexClient(url);
const q = {
  fullFleet: ref("stream:fullFleet"),
  fleetBatches: ref("stream:batchesSince"),
  fullSet: ref("trajectories:fullSet"),
  trajBatches: ref("trajectories:batchesSince"),
  meta: ref("trajectories:meta"),
  clock: ref("clock:now"),
};
const pack = async () => (await fetch(`${site}/geometry-pack`)).json();
const firstPack = await pack();

function cursor(query, start) {
  let seq = start, n = 0, unsub = null;
  const arm = () => {
    unsub?.();
    n = 0;
    unsub = client.onUpdate(query, { sinceSeq: seq }, (r) => {
      push(query === q.fleetBatches ? "stream:batchesSince" : "trajectories:batchesSince", r);
      for (const b of r.batches) if (b.seq > seq) { seq = b.seq; n++; }
      if (n >= 8) arm();
    });
  };
  arm();
  return () => unsub?.();
}
const fleet = await client.query(q.fullFleet, {});
push("stream:fullFleet", fleet);
const set = await client.query(q.fullSet, {});
push("trajectories:fullSet", set);
const stops = [
  cursor(q.fleetBatches, fleet.seq ?? 0),
  cursor(q.trajBatches, set.seq ?? 0),
  client.onUpdate(q.meta, {}, (m) => m && push("trajectories:meta", m)),
];
const probe = async () => {
  const sentAtMs = Date.now();
  const r = await client.query(q.clock, { nonce: `cap-${sentAtMs}-${Math.random()}` });
  push("clock:now", r, { sentAtMs });
};
await probe();
const clockTimer = setInterval(() => probe().catch(() => {}), 30_000);
await new Promise((r) => setTimeout(r, Number(secondsArg) * 1000));
clearInterval(clockTimer);
for (const s of stops) s();
const lastPack = await pack().catch(() => null);
await client.close();
const shapes = new Map(firstPack.shapes.map((s) => [s.shapeId, s]));
const trips = { ...(lastPack?.trips ?? {}), ...(firstPack.trips ?? {}) };
// The served pack maps trips to geometryKey; the replay resolves by shapeId.
const byKey = new Map([...shapes.values()].map((s) => [s.geometryKey ?? s.shapeId, s.shapeId]));
for (const [trip, key] of Object.entries(trips)) trips[trip] = byKey.get(key) ?? key;
for (const s of lastPack?.shapes ?? []) if (!shapes.has(s.shapeId)) shapes.set(s.shapeId, s);
writeFileSync(`${prefix}-wire.jsonl.gz`, gzipSync(rows.map((r) => JSON.stringify(r)).join("\n") + "\n"));
writeFileSync(`${prefix}-geometry.json.gz`, gzipSync(JSON.stringify({ atMs: firstPack.atMs, shapes: [...shapes.values()], trips })));
const counts = {};
for (const r of rows) counts[r.path] = (counts[r.path] ?? 0) + 1;
console.log(JSON.stringify({ prefix, seconds: Number(secondsArg), counts, shapes: shapes.size, trips: Object.keys(trips).length }));
process.exit(0);
