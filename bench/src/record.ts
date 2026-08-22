// РЕКОРДЕР: пишет живую сессию (фиксы + профили + геометрии, с реальными
// временами приёма) в bench/sessions/<name>.jsonl. Реплеер потом прогоняет её
// через настоящий клиентский код детерминированно.
//
//   npx tsx bench/src/record.ts <minutes> [name]

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fixes, traj, fetchServedGeometry } from './streams';
import type { SessionEvent } from './harness';

const minutes = Number(process.argv[2] ?? 20);
const name = process.argv[3] ?? `session-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const file = path.join(__dirname, '..', 'sessions', `${name}.jsonl`);
const out = fs.createWriteStream(file, { flags: 'w' });
const write = (e: SessionEvent) => out.write(JSON.stringify(e) + '\n');

async function main(): Promise<void> {
  const endAt = Date.now() + minutes * 60_000;
  const seenTrips = new Set<string>();

  const recordGeometry = async (tripId: string): Promise<void> => {
    if (seenTrips.has(tripId)) return;
    seenTrips.add(tripId);
    const served = await fetchServedGeometry(tripId);
    if (served) write({ t: Date.now(), kind: 'geometry', tripId, served: served as never });
  };

  // ── сиды ──
  const ff = await fixes.fullFleet();
  write({ t: Date.now(), kind: 'fixSeed', vehicles: ff.vehicles });
  let fixCursor = ff.seq;
  for (const v of ff.vehicles) await recordGeometry(v.tripId);

  const ts = await traj.fullSet();
  write({ t: Date.now(), kind: 'trajSeed', vehicles: ts.vehicles, meta: ts.meta });
  let trajCursor = ts.seq;

  let events = 0;
  console.log(`recording ${minutes} min → ${file}`);

  // ── поллинг раз в 2 с (как публикует бекенд) ──
  while (Date.now() < endAt) {
    try {
      const fb = await fixes.since(fixCursor);
      for (const b of fb.batches) {
        if (b.seq <= fixCursor) continue;
        fixCursor = b.seq;
        write({ t: Date.now(), kind: 'fixBatch', changed: b.changed, removed: b.removed });
        events++;
        for (const v of b.changed) await recordGeometry(v.tripId);
      }
      const tb = await traj.since(trajCursor);
      for (const b of tb.batches) {
        if (b.seq <= trajCursor) continue;
        trajCursor = b.seq;
        write({ t: Date.now(), kind: 'trajBatch', batch: b, serverNowMs: tb.serverNowMs });
        events++;
      }
      const m = await traj.meta();
      if (m) write({ t: Date.now(), kind: 'trajMeta', meta: m });
    } catch (e) {
      console.error('poll error (continuing):', e instanceof Error ? e.message : e);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  out.end();
  console.log(`done: ${events} batches, trips ${seenTrips.size}, file ${file}`);
}

void main();
