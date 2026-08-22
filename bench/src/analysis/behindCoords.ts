// АНАЛИЗ hunt1: разложение behind-coords/walk-episode на подклассы
//   a) кривая позади ОСИ фикса (сервер отстал)
//   b) кривая на оси, но ось позади КООРДИНАТ (residual ось-vs-коорд)
//   c) кривая ДЕРЖИТ (модальный/jam холд, скорость 0) при уехавших координатах
//
// TSX_TSCONFIG_PATH=bench/tsconfig.json bench/node_modules/.bin/tsx \
//   bench/src/analysis/behindCoords.ts [--events] [--case KEY@HH:MM:SS]

import * as fs from 'node:fs';
import * as path from 'node:path';
import { projectDistanceOnPolyline, servedToRouteGeometry } from '@/lib/golemio/gtfs';
import type { PhysicsDebugInfo, RouteGeometry, TramSnapshot } from '@/lib/types';
import type { SessionEvent } from '../harness';

const SESS = path.resolve(__dirname, '..', '..', 'sessions', 'hunt1.jsonl');
// ВАЖНО: replay.ts --key K перезаписывает hunt1.anomalies.jsonl результатами
// одного ключа — для анализа держите полный дамп отдельно (ANOM_FILE=...).
const ANOM =
  process.env.ANOM_FILE ??
  path.resolve(__dirname, '..', '..', 'sessions', 'hunt1.anomalies.jsonl');
const showEvents = process.argv.includes('--events');

const hhmmss = (ms: number): string => new Date(ms).toISOString().slice(11, 19);

const haversineM = (a: [number, number], b: [number, number]): number => {
  const R = 6371000;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const la = (a[1] * Math.PI) / 180;
  const lb = (b[1] * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// ── сессия: фиксы по ключу + геометрии по трипу ──────────────────────────────
const geoms = new Map<string, RouteGeometry>();
const fixesByKey = new Map<string, { t: number; snap: TramSnapshot }[]>();
for (const line of fs.readFileSync(SESS, 'utf8').split('\n')) {
  if (!line) continue;
  const e = JSON.parse(line) as SessionEvent;
  if (e.kind === 'geometry') {
    try {
      const g = (servedToRouteGeometry as unknown as (s: unknown, n: number) => RouteGeometry)(
        e.served,
        e.t,
      );
      if (g) geoms.set(e.tripId, g);
    } catch {
      /* как в харнессе */
    }
  } else if (e.kind === 'fixSeed' || e.kind === 'fixBatch') {
    const vs = e.kind === 'fixSeed' ? e.vehicles : e.changed;
    for (const v of vs) {
      let arr = fixesByKey.get(v.key);
      if (!arr) fixesByKey.set(v.key, (arr = []));
      const last = arr[arr.length - 1];
      if (!last || last.snap.observedAtMs !== v.observedAtMs || last.snap.tripId !== v.tripId)
        arr.push({ t: e.t, snap: v });
    }
  }
}

// ── петлевые трипы: точки полилинии ближе 35 м при |ΔcumDist| > 250 м ────────
const loopTrips = new Map<string, { iM: number; jM: number; gapM: number }>();
for (const [tripId, g] of geoms) {
  const n = g.coordinates.length;
  outer: for (let i = 0; i < n; i += 2) {
    for (let j = i + 1; j < n; j += 2) {
      if (g.cumDistM[j] - g.cumDistM[i] <= 250) continue;
      if (haversineM(g.coordinates[i], g.coordinates[j]) < 35) {
        loopTrips.set(tripId, {
          iM: g.cumDistM[i],
          jM: g.cumDistM[j],
          gapM: g.cumDistM[j] - g.cumDistM[i],
        });
        break outer;
      }
    }
  }
}

// Неоднозначна ли проекция КОНКРЕТНОЙ точки: есть ли вершина полилинии в 35 м
// от координат фикса с |cumDist − sProj| > 250 м.
const ambiguousAt = (g: RouteGeometry, coord: [number, number], sProj: number): boolean => {
  for (let i = 0; i < g.coordinates.length; i++) {
    if (Math.abs(g.cumDistM[i] - sProj) <= 250) continue;
    if (haversineM(g.coordinates[i], coord) < 35) return true;
  }
  return false;
};

// ── события ──────────────────────────────────────────────────────────────────
interface Anom {
  kind: string;
  key: string;
  atMs: number;
  detail: string;
  diag: PhysicsDebugInfo;
}
const anoms = fs
  .readFileSync(ANOM, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Anom)
  .filter((a) => a.kind === 'behind-coords' || a.kind === 'walk-episode');

interface Row {
  a: Anom;
  cls: 'a' | 'b' | 'c';
  sub: string;
  gapM: number;
  residM: number; // sCoord − obsDistM (ось позади координат)
  axisGapM: number; // obsDistM − simDistM (кривая позади оси)
  coordMoveM: number; // движение сырых координат в окне [-60с, +30с]
  axisMoveM: number;
  tripId: string;
  loop: boolean;
  amb: boolean;
  fusedByEngine: boolean;
}
const rows: Row[] = [];
let skipped = 0;

for (const a of anoms) {
  const d = a.diag;
  const fixes = fixesByKey.get(a.key) ?? [];
  // фикс, который видел детектор: с тем же observedAtMs, свежайший к atMs
  let fix: { t: number; snap: TramSnapshot } | null = null;
  for (const f of fixes) {
    if (f.t <= a.atMs + 500 && f.snap.observedAtMs === d.obsAtMs) fix = f;
  }
  if (!fix) for (const f of fixes) if (f.t <= a.atMs + 500) fix = f;
  const geom = fix ? geoms.get(fix.snap.tripId) : undefined;
  if (!fix || !geom) {
    skipped++;
    continue;
  }
  const snap = fix.snap;
  const sCoord = projectDistanceOnPolyline(snap.coordinates, geom.coordinates, geom.cumDistM);
  const gapM = sCoord - d.simDistM;
  const residM = sCoord - d.obsDistM;
  const axisGapM = d.obsDistM - d.simDistM;

  // движение координат/оси в окне вокруг события
  const win = fixes.filter(
    (f) => f.snap.observedAtMs >= a.atMs - 60_000 && f.snap.observedAtMs <= a.atMs + 30_000,
  );
  let coordMoveM = 0;
  for (let i = 1; i < win.length; i++)
    coordMoveM += haversineM(win[i - 1].snap.coordinates, win[i].snap.coordinates);
  const axisMoveM =
    win.length >= 2 ? win[win.length - 1].snap.shapeDistM - win[0].snap.shapeDistM : 0;

  const loop = loopTrips.has(snap.tripId);
  const amb = ambiguousAt(geom, snap.coordinates, sCoord);
  // Движок уже фьюзит ось: якорь опубликованной кривой = obs + residual.
  const fusedByEngine =
    d.anchorFixS != null && Math.abs(d.anchorFixS - d.obsDistM - residM) < 12;

  let cls: Row['cls'];
  let sub: string;
  if (residM >= Math.max(40, gapM / 2)) {
    cls = 'b';
    sub =
      residM > 250
        ? 'b:>250м-потолок'
        : amb
          ? 'b:петля-неоднозначно'
          : d.statePosition === 'at_stop'
            ? 'b:at_stop-на-оси'
            : 'b:30..250м-в-воротах';
  } else if (d.simSpeedKmh <= 1) {
    cls = 'c';
    const holdType =
      d.statePosition === 'at_stop' || d.phase === 'dwell'
        ? 'modal-at_stop'
        : d.pastHorizon
          ? 'frozen-horizon'
          : 'jam/other';
    sub = `c:${holdType}${coordMoveM >= 40 ? '+координаты-едут' : '+координаты-стоят'}`;
  } else {
    cls = 'a';
    sub =
      d.shimBranch === 'walk'
        ? 'a:walk-догоняет'
        : (d.anchorLagS ?? 0) > 10
          ? 'a:anchorLag'
          : (d.emissionAgeS ?? 0) > 60
            ? 'a:старая-эмиссия'
            : 'a:кривая-медленнее';
  }
  rows.push({ a, cls, sub, gapM, residM, axisGapM, coordMoveM, axisMoveM, tripId: snap.tripId, loop, amb, fusedByEngine });
}

// ── отчёт ────────────────────────────────────────────────────────────────────
const total = rows.length;
const byCls = new Map<string, Row[]>();
for (const r of rows) {
  const k = r.cls;
  byCls.set(k, [...(byCls.get(k) ?? []), r]);
}
console.log(`events=${anoms.length} classified=${total} skipped=${skipped}`);
for (const [cls, rs] of [...byCls.entries()].sort()) {
  console.log(`\nПОДКЛАСС ${cls}: ${rs.length} (${((100 * rs.length) / total).toFixed(0)}%)`);
  const bySub = new Map<string, number>();
  for (const r of rs) bySub.set(r.sub, (bySub.get(r.sub) ?? 0) + 1);
  for (const [s, n] of [...bySub.entries()].sort((x, y) => y[1] - x[1]))
    console.log(`  ${s}: ${n}`);
  const med = (xs: number[]): number => xs.sort((p, q) => p - q)[Math.floor(xs.length / 2)] ?? 0;
  console.log(
    `  медианы: gap=${med(rs.map((r) => r.gapM)).toFixed(0)}м resid=${med(rs.map((r) => r.residM)).toFixed(0)}м ` +
      `axisGap=${med(rs.map((r) => r.axisGapM)).toFixed(0)}м coordMove=${med(rs.map((r) => r.coordMoveM)).toFixed(0)}м ` +
      `fixAge=${med(rs.map((r) => r.a.diag.fixAgeS)).toFixed(0)}с anchorLag=${med(rs.map((r) => r.a.diag.anchorLagS ?? 0)).toFixed(0)}с ` +
      `emissionAge=${med(rs.map((r) => r.a.diag.emissionAgeS ?? 0)).toFixed(0)}с`,
  );
}

// подкласс b: распределение residual
const bs = byCls.get('b') ?? [];
if (bs.length) {
  const bands: [string, (r: number) => boolean][] = [
    ['≤15м', (r) => r <= 15],
    ['15–30м (поймал бы порог 15)', (r) => r > 15 && r <= 30],
    ['30–250м (в воротах фьюза, но не съелось)', (r) => r > 30 && r <= 250],
    ['>250м (над потолком)', (r) => r > 250],
  ];
  console.log(`\nb: residual распределение (${bs.length} событий):`);
  for (const [name, f] of bands)
    console.log(`  ${name}: ${bs.filter((r) => f(r.residM)).length}`);
  console.log(
    `  на петлевых трипах: ${bs.filter((r) => r.loop).length}; ` +
      `проекция фикса неоднозначна (вершина <35м при ΔcumDist>250м): ${bs.filter((r) => r.amb).length}; ` +
      `at_stop: ${bs.filter((r) => r.a.diag.statePosition === 'at_stop').length}; ` +
      `движок УЖЕ сфьюзил ось (anchorFixS = obs+resid): ${bs.filter((r) => r.fusedByEngine).length} — ` +
      `эти residual уже не в рендер-пути, их держит continuity-лаг (класс a)`,
  );
}

// подкласс c: чем держит и ехали ли координаты
const cs = byCls.get('c') ?? [];
if (cs.length) {
  console.log(
    `\nc: modal(at_stop/dwell)=${cs.filter((r) => r.sub.includes('modal')).length} ` +
      `frozen-horizon=${cs.filter((r) => r.sub.includes('frozen')).length} ` +
      `jam/other=${cs.filter((r) => r.sub.includes('jam')).length}; ` +
      `координаты реально ехали (≥40м/окно): ${cs.filter((r) => r.coordMoveM >= 40).length}/${cs.length}`,
  );
}

console.log(
  `\nПЕТЛЕВЫЕ ТРИПЫ (все в сессии): ${[...loopTrips.keys()].length}` +
    (loopTrips.size
      ? '\n' +
        [...loopTrips.entries()]
          .map(([t, l]) => `  ${t} (${l.iM.toFixed(0)}м ↔ ${l.jM.toFixed(0)}м, Δ${l.gapM.toFixed(0)}м)`)
          .join('\n')
      : ''),
);
const evTrips = new Set(rows.map((r) => r.tripId));
console.log(`петлевые среди трипов событий: ${[...evTrips].filter((t) => loopTrips.has(t)).join(', ') || '—'}`);

if (showEvents) {
  console.log('');
  for (const r of rows) {
    const d = r.a.diag;
    console.log(
      `[${r.cls}|${r.sub}] ${r.a.kind} ${r.a.key}@${hhmmss(r.a.atMs)} trip=${r.tripId}${r.loop ? '(петля)' : ''} ` +
        `gap=${r.gapM.toFixed(0)} resid=${r.residM.toFixed(0)} axisGap=${r.axisGapM.toFixed(0)} ` +
        `v=${d.simSpeedKmh.toFixed(0)} src=${d.renderSource} shim=${d.shimBranch} state=${d.statePosition} ` +
        `phase=${d.phase} fixAge=${d.fixAgeS.toFixed(0)}с anchorLag=${(d.anchorLagS ?? 0).toFixed(0)}с ` +
        `emisAge=${(d.emissionAgeS ?? 0).toFixed(0)}с coordMove=${r.coordMoveM.toFixed(0)}м axisMove=${r.axisMoveM.toFixed(0)}м ` +
        `pastHor=${d.pastHorizon}`,
    );
  }
}
