// ЖИВОЙ СИМУЛЯТОР-ВОТЧЕР — бенч, который работает ВСЕГДА.
//
// Крутится сервисом рядом с движком: подписан на те же Convex-потоки, что
// телефон, ведёт настоящий клиентский код (harness) в реальном времени и на
// каждый секундный тик судит ОБА режима рендера (fixed И smooth) детекторами
// полевых жалоб. Плюс детектор КОНТРАКТА, который глазами не поймать:
// у каждой пришедшей эмиссии anchorS сверяется с осью фикса, на который она
// ссылается по anchorMs — разъехавшиеся поля (кейс 8459@03:52) всплывают
// в ту же секунду, а не через скриншот владельца.
//
// Выход:
//   /data/bench/anomalies.jsonl        — все аномалии (дозапись)
//   /data/bench/windows/<ts>-<key>.jsonl — кольцевое окно событий (15 мин) на
//                                        момент аномалии: готовая сессия для
//                                        replay.ts — «что за хуйня было в
//                                        03:52» больше не вопрос
//   lab.db bench_anomalies             — минутные счётчики для Grafana

import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { Bench, type SessionEvent } from './harness';
import { Detectors, type Anomaly } from './detect';
import { fixes, traj, fetchServedGeometry } from './streams';

const OUT_DIR = process.env.BENCH_OUT ?? '/data/bench';
const DB_PATH = process.env.LAB_DB ?? '/data/lab.db';
const RING_MS = 15 * 60_000;
const WINDOW_COOLDOWN_MS = 60_000;
/** Свежие сработки контракт-детектора на ключ (антиспам). */
const ANCHOR_MISMATCH_TOL_M = 40;

fs.mkdirSync(path.join(OUT_DIR, 'windows'), { recursive: true });
const anomaliesOut = fs.createWriteStream(path.join(OUT_DIR, 'anomalies.jsonl'), { flags: 'a' });

const db = new Database(DB_PATH);
db.pragma('busy_timeout = 15000');
db.exec(`CREATE TABLE IF NOT EXISTS bench_anomalies (
  atMs INTEGER NOT NULL,
  kind TEXT NOT NULL,
  mode TEXT NOT NULL,
  key TEXT NOT NULL,
  detail TEXT NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_bench_anomalies_at ON bench_anomalies(atMs)');
const insertAnomaly = db.prepare(
  'INSERT INTO bench_anomalies (atMs, kind, mode, key, detail) VALUES (?, ?, ?, ?, ?)',
);

const bench = new Bench();
const detFixed = new Detectors();
const detSmooth = new Detectors();
const ring: SessionEvent[] = [];
/** key+obsAtMs → ось фикса, для контракт-детектора (окно 10 мин). */
const fixAxis = new Map<string, number>();
const fixAxisAt = new Map<string, number>();
let lastWindowDumpMs = 0;
const contractReported = new Set<string>();

function feed(e: SessionEvent): void {
  ring.push(e);
  const cutoff = Date.now() - RING_MS;
  while (ring.length > 0 && ring[0].t < cutoff) ring.shift();
  bench.feed(e);
}

function rememberFixes(changed: { key: string; observedAtMs: number; shapeDistM: number }[]): void {
  const now = Date.now();
  for (const v of changed) {
    const k = `${v.key}|${v.observedAtMs}`;
    fixAxis.set(k, v.shapeDistM);
    fixAxisAt.set(k, now);
  }
  if (fixAxis.size > 20_000) {
    const cutoff = now - 10 * 60_000;
    for (const [k, at] of fixAxisAt) {
      if (at < cutoff) {
        fixAxis.delete(k);
        fixAxisAt.delete(k);
      }
    }
  }
}

/** Контракт: anchorS эмиссии обязан совпадать с осью фикса её anchorMs. */
function checkEmissionContract(batch: {
  changed: { key?: unknown; anchorMs?: unknown; anchorS?: unknown; source?: unknown }[];
}): void {
  for (const v of batch.changed) {
    if (typeof v.key !== 'string' || typeof v.anchorMs !== 'number') continue;
    if (typeof v.anchorS !== 'number') continue;
    const axis = fixAxis.get(`${v.key}|${v.anchorMs}`);
    if (axis === undefined) continue; // фикс старше окна — не судим
    const d = v.anchorS - axis;
    if (Math.abs(d) <= ANCHOR_MISMATCH_TOL_M) continue;
    const id = `${v.key}|${v.anchorMs}`;
    if (contractReported.has(id)) continue;
    contractReported.add(id);
    if (contractReported.size > 5_000) contractReported.clear();
    report(
      {
        kind: 'anchor-mismatch',
        key: v.key,
        atMs: Date.now(),
        detail: `эмиссия (source=${String(v.source)}) ссылается на фикс anchorMs=${v.anchorMs}, но anchorS=${(v.anchorS as number).toFixed(0)} при оси фикса ${axis.toFixed(0)} (Δ${d.toFixed(0)}м)`,
        diag: undefined as never,
      },
      'wire',
    );
  }
}

function report(a: Anomaly, mode: string): void {
  const line = JSON.stringify({ ...a, mode });
  anomaliesOut.write(line + '\n');
  console.log(`[watch] ${mode} ${a.kind} ${a.key}: ${a.detail}`);
  try {
    insertAnomaly.run(a.atMs, a.kind, mode, a.key, a.detail);
  } catch (e) {
    console.error('sqlite write failed:', e instanceof Error ? e.message : e);
  }
  // Окно для реплея — не чаще раза в минуту (иначе шторм зальёт диск).
  const now = Date.now();
  if (now - lastWindowDumpMs > WINDOW_COOLDOWN_MS) {
    lastWindowDumpMs = now;
    const file = path.join(
      OUT_DIR,
      'windows',
      `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${a.key}-${a.kind}.jsonl`,
    );
    fs.writeFileSync(file, ring.map((e) => JSON.stringify(e)).join('\n'));
    console.log(`[watch] окно сохранено: ${file} (${ring.length} событий)`);
  }
}

async function main(): Promise<void> {
  console.log('[watch] живой симулятор стартует…');
  const seenTrips = new Set<string>();
  const geometryFor = async (tripId: string): Promise<void> => {
    if (seenTrips.has(tripId)) return;
    seenTrips.add(tripId);
    const served = await fetchServedGeometry(tripId);
    if (served) feed({ t: Date.now(), kind: 'geometry', tripId, served: served as never });
  };

  const ff = await fixes.fullFleet();
  feed({ t: Date.now(), kind: 'fixSeed', vehicles: ff.vehicles });
  rememberFixes(ff.vehicles);
  let fixCursor = ff.seq;
  for (const v of ff.vehicles) await geometryFor(v.tripId);

  const ts = await traj.fullSet();
  feed({ t: Date.now(), kind: 'trajSeed', vehicles: ts.vehicles, meta: ts.meta });
  let trajCursor = ts.seq;
  console.log(`[watch] засеян: флот ${ff.vehicles.length}, кривых ${ts.vehicles.length}`);

  // ── поллинг потоков (2 с) ──
  setInterval(() => {
    void (async () => {
      try {
        const fb = await fixes.since(fixCursor);
        for (const b of fb.batches) {
          if (b.seq <= fixCursor) continue;
          fixCursor = b.seq;
          feed({ t: Date.now(), kind: 'fixBatch', changed: b.changed, removed: b.removed });
          rememberFixes(b.changed);
          for (const v of b.changed) await geometryFor(v.tripId);
        }
        const tb = await traj.since(trajCursor);
        for (const b of tb.batches) {
          if (b.seq <= trajCursor) continue;
          trajCursor = b.seq;
          feed({ t: Date.now(), kind: 'trajBatch', batch: b, serverNowMs: tb.serverNowMs });
          checkEmissionContract(b as never);
        }
      } catch (e) {
        console.error('[watch] poll error:', e instanceof Error ? e.message : e);
      }
    })();
  }, 2_000);

  // ── секундный судья, ОБА режима ──
  setInterval(() => {
    const now = Date.now();
    for (const key of bench.keys()) {
      for (const [mode, det] of [
        ['fixed', detFixed],
        ['smooth', detSmooth],
      ] as const) {
        const diag = bench.fleet.getDiagnostics(key, now, mode);
        const state = bench.fleet.getState(key, now, mode);
        if (!diag || !state) continue;
        const before = det.anomalies.length;
        det.check(key, now, diag, state.snapshot, bench.geometry(state.snapshot.tripId));
        for (let i = before; i < det.anomalies.length; i++) report(det.anomalies[i], mode);
      }
    }
    // Не копим дампы бесконечно в памяти.
    if (detFixed.anomalies.length > 10_000) detFixed.anomalies.length = 0;
    if (detSmooth.anomalies.length > 10_000) detSmooth.anomalies.length = 0;
  }, 1_000);
}

void main();
