// SQLite storage: fix archive, per-fix scores, learned surfaces, rollups.
// One file (WAL) shared read-only with Grafana's sqlite datasource.

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DB_PATH } from './config';

export interface ScoreRow {
  atMs: number;
  key: string;
  line: string;
  routeId: string;
  tripId: string;
  variant: string;
  horizonS: number;
  errM: number;
  absErrM: number;
  latencyS: number;
}

export function openDb(): Database.Database {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS fixes (
      id INTEGER PRIMARY KEY,
      key TEXT NOT NULL,
      reg INTEGER,
      tripId TEXT NOT NULL,
      routeId TEXT NOT NULL,
      line TEXT NOT NULL,
      obsAtMs INTEGER NOT NULL,
      seenAtMs INTEGER NOT NULL,
      shapeDistM REAL NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      bearing REAL,
      delayS INTEGER,
      statePos TEXT,
      nextStopId TEXT,
      nextSeq INTEGER,
      UNIQUE(key, obsAtMs)
    );
    CREATE INDEX IF NOT EXISTS fixes_by_time ON fixes(obsAtMs);
    CREATE INDEX IF NOT EXISTS fixes_by_key_time ON fixes(key, obsAtMs);

    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY,
      atMs INTEGER NOT NULL,
      key TEXT NOT NULL,
      line TEXT NOT NULL,
      routeId TEXT NOT NULL,
      tripId TEXT NOT NULL,
      variant TEXT NOT NULL,
      horizonS REAL NOT NULL,
      errM REAL NOT NULL,
      absErrM REAL NOT NULL,
      latencyS REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scores_by_time ON scores(atMs);
    CREATE INDEX IF NOT EXISTS scores_by_variant_time ON scores(variant, atMs);

    CREATE TABLE IF NOT EXISTS learned_cells (
      tbl TEXT NOT NULL,
      cellKey TEXT NOT NULL,
      mean REAL NOT NULL,
      weight REAL NOT NULL,
      s REAL NOT NULL,
      n INTEGER NOT NULL,
      updatedAtMs INTEGER NOT NULL,
      PRIMARY KEY (tbl, cellKey)
    );

    CREATE TABLE IF NOT EXISTS geometries (
      tripId TEXT PRIMARY KEY,
      shapeId TEXT NOT NULL,
      json TEXT NOT NULL,
      fetchedAtMs INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rollup_minute (
      tsMin INTEGER NOT NULL,
      variant TEXT NOT NULL,
      hbucket TEXT NOT NULL,
      n INTEGER NOT NULL,
      meanAbs REAL NOT NULL,
      p50Abs REAL NOT NULL,
      p90Abs REAL NOT NULL,
      signedMean REAL NOT NULL,
      PRIMARY KEY (tsMin, variant, hbucket)
    );

    CREATE TABLE IF NOT EXISTS rollup_learning (
      tsMin INTEGER PRIMARY KEY,
      segCells INTEGER NOT NULL,
      segShapeCells INTEGER NOT NULL,
      routeCells INTEGER NOT NULL,
      stopDwellCells INTEGER NOT NULL,
      stopReleaseCells INTEGER NOT NULL,
      paceSamples INTEGER NOT NULL,
      dwellSamples INTEGER NOT NULL,
      releaseSamples INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rollup_ingest (
      tsMin INTEGER PRIMARY KEY,
      fixes INTEGER NOT NULL,
      batches INTEGER NOT NULL,
      vehicles INTEGER NOT NULL,
      withGeometry INTEGER NOT NULL,
      geomFetchOk INTEGER NOT NULL,
      geomFetchFail INTEGER NOT NULL,
      avgLatencyS REAL,
      avgFixGapS REAL,
      pollerFleetSize INTEGER,
      pollerRunning INTEGER
    );

    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

    -- Written by lab/ml/service.py after each training run; created here too
    -- so Grafana panels don't error before the first train.
    CREATE TABLE IF NOT EXISTS ml_train_log (
      tsMin INTEGER NOT NULL,
      model TEXT NOT NULL,
      nPairs INTEGER NOT NULL,
      maeHoldout REAL NOT NULL,
      PRIMARY KEY (tsMin, model)
    );
  `);
  // Additive migration (2026-08-11): feed-discontinuity events skipped by the
  // scoring gate, per rollup minute.
  try {
    db.exec('ALTER TABLE rollup_ingest ADD COLUMN discarded INTEGER');
  } catch {
    /* column already exists */
  }
  return db;
}

export class Store {
  readonly db: Database.Database;
  private insFix;
  private insScore;
  private upsertCell;
  private upsertGeom;
  private insRollup;
  private insLearnRollup;
  private insIngestRollup;

  constructor(db: Database.Database) {
    this.db = db;
    this.insFix = db.prepare(`INSERT OR IGNORE INTO fixes
      (key, reg, tripId, routeId, line, obsAtMs, seenAtMs, shapeDistM, lat, lng, bearing, delayS, statePos, nextStopId, nextSeq)
      VALUES (@key, @reg, @tripId, @routeId, @line, @obsAtMs, @seenAtMs, @shapeDistM, @lat, @lng, @bearing, @delayS, @statePos, @nextStopId, @nextSeq)`);
    this.insScore = db.prepare(`INSERT INTO scores
      (atMs, key, line, routeId, tripId, variant, horizonS, errM, absErrM, latencyS)
      VALUES (@atMs, @key, @line, @routeId, @tripId, @variant, @horizonS, @errM, @absErrM, @latencyS)`);
    this.upsertCell = db.prepare(`INSERT INTO learned_cells (tbl, cellKey, mean, weight, s, n, updatedAtMs)
      VALUES (@tbl, @cellKey, @mean, @weight, @s, @n, @updatedAtMs)
      ON CONFLICT(tbl, cellKey) DO UPDATE SET mean=@mean, weight=@weight, s=@s, n=@n, updatedAtMs=@updatedAtMs`);
    this.upsertGeom = db.prepare(`INSERT INTO geometries (tripId, shapeId, json, fetchedAtMs)
      VALUES (@tripId, @shapeId, @json, @fetchedAtMs)
      ON CONFLICT(tripId) DO UPDATE SET shapeId=@shapeId, json=@json, fetchedAtMs=@fetchedAtMs`);
    this.insRollup = db.prepare(`INSERT OR REPLACE INTO rollup_minute
      (tsMin, variant, hbucket, n, meanAbs, p50Abs, p90Abs, signedMean)
      VALUES (@tsMin, @variant, @hbucket, @n, @meanAbs, @p50Abs, @p90Abs, @signedMean)`);
    this.insLearnRollup = db.prepare(`INSERT OR REPLACE INTO rollup_learning
      (tsMin, segCells, segShapeCells, routeCells, stopDwellCells, stopReleaseCells, paceSamples, dwellSamples, releaseSamples)
      VALUES (@tsMin, @segCells, @segShapeCells, @routeCells, @stopDwellCells, @stopReleaseCells, @paceSamples, @dwellSamples, @releaseSamples)`);
    this.insIngestRollup = db.prepare(`INSERT OR REPLACE INTO rollup_ingest
      (tsMin, fixes, batches, vehicles, withGeometry, geomFetchOk, geomFetchFail, avgLatencyS, avgFixGapS, pollerFleetSize, pollerRunning, discarded)
      VALUES (@tsMin, @fixes, @batches, @vehicles, @withGeometry, @geomFetchOk, @geomFetchFail, @avgLatencyS, @avgFixGapS, @pollerFleetSize, @pollerRunning, @discarded)`);
  }

  addFix(row: {
    key: string; reg: number | null; tripId: string; routeId: string; line: string;
    obsAtMs: number; seenAtMs: number; shapeDistM: number; lat: number; lng: number;
    bearing: number | null; delayS: number | null; statePos: string | null;
    nextStopId: string | null; nextSeq: number | null;
  }): void {
    this.insFix.run(row);
  }

  addScore(row: ScoreRow): void {
    this.insScore.run(row);
  }

  saveCell(tbl: string, cellKey: string, c: { mean: number; weight: number; s: number; n: number; updatedAtMs: number }): void {
    this.upsertCell.run({ tbl, cellKey, ...c });
  }

  loadCells(): { tbl: string; cellKey: string; mean: number; weight: number; s: number; n: number; updatedAtMs: number }[] {
    return this.db.prepare('SELECT * FROM learned_cells').all() as never;
  }

  saveGeometry(tripId: string, shapeId: string, json: string, fetchedAtMs: number): void {
    this.upsertGeom.run({ tripId, shapeId, json, fetchedAtMs });
  }

  loadGeometries(): { tripId: string; json: string; fetchedAtMs: number }[] {
    return this.db.prepare('SELECT tripId, json, fetchedAtMs FROM geometries').all() as never;
  }

  writeRollup(rows: { tsMin: number; variant: string; hbucket: string; n: number; meanAbs: number; p50Abs: number; p90Abs: number; signedMean: number }[]): void {
    const tx = this.db.transaction((rs: typeof rows) => rs.forEach((r) => this.insRollup.run(r)));
    tx(rows);
  }

  writeLearningRollup(row: { tsMin: number; segCells: number; segShapeCells: number; routeCells: number; stopDwellCells: number; stopReleaseCells: number; paceSamples: number; dwellSamples: number; releaseSamples: number }): void {
    this.insLearnRollup.run(row);
  }

  writeIngestRollup(row: { tsMin: number; fixes: number; batches: number; vehicles: number; withGeometry: number; geomFetchOk: number; geomFetchFail: number; avgLatencyS: number | null; avgFixGapS: number | null; pollerFleetSize: number | null; pollerRunning: number | null; discarded: number }): void {
    this.insIngestRollup.run(row);
  }

  getMeta(k: string): string | null {
    const r = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined;
    return r?.v ?? null;
  }

  setMeta(k: string, v: string): void {
    this.db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  /** Last-hour per-variant summary for /api/summary and the map header. */
  summarySince(sinceMs: number): { variant: string; n: number; meanAbs: number; p50Abs: number; p90Abs: number }[] {
    const rows = this.db
      .prepare('SELECT variant, absErrM FROM scores WHERE atMs >= ?')
      .all(sinceMs) as { variant: string; absErrM: number }[];
    const by = new Map<string, number[]>();
    for (const r of rows) {
      let a = by.get(r.variant);
      if (!a) by.set(r.variant, (a = []));
      a.push(r.absErrM);
    }
    const out: { variant: string; n: number; meanAbs: number; p50Abs: number; p90Abs: number }[] = [];
    for (const [variant, abs] of by) {
      abs.sort((x, y) => x - y);
      out.push({
        variant,
        n: abs.length,
        meanAbs: round2(abs.reduce((a, b) => a + b, 0) / abs.length),
        p50Abs: round2(pct(abs, 50)),
        p90Abs: round2(pct(abs, 90)),
      });
    }
    return out.sort((a, b) => a.variant.localeCompare(b.variant));
  }
}

export function pct(sortedAbs: number[], p: number): number {
  if (sortedAbs.length === 0) return NaN;
  const k = ((sortedAbs.length - 1) * p) / 100;
  const f = Math.floor(k);
  const c = Math.min(f + 1, sortedAbs.length - 1);
  return sortedAbs[f] + (sortedAbs[c] - sortedAbs[f]) * (k - f);
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
