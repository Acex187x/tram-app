// Классификация stand-at-wrong-spot по Δ (маркер − заявленная остановка) и
// проверка гипотезы (а): для at_stop фиксов ось Golemio прибита к остановке,
// координаты шумят, а fused-якорь (anchorS в trajBatch) уехал к координатам.
//
//   TSX_TSCONFIG_PATH=bench/tsconfig.json bench/node_modules/.bin/tsx \
//     bench/src/analysis/standwrong.ts

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PhysicsDebugInfo, TramSnapshot } from '@/lib/types';
import { projectDistanceOnPolyline } from '@/lib/golemio/gtfs';

interface Anom {
  kind: string;
  detail: string;
  key: string;
  atMs: number;
  diag: PhysicsDebugInfo;
}

const ROOT = path.resolve(__dirname, '..', '..');
const anoms: Anom[] = fs
  .readFileSync(path.join(ROOT, 'sessions/hunt1.anomalies.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Anom)
  .filter((a) => a.kind === 'stand-at-wrong-spot');

// Заявленная остановка — из detail: "feed=at_stop(Name@1234м)".
const claimedOf = (a: Anom): number => {
  const m = a.detail.match(/@(-?\d+(?:\.\d+)?)м\)/);
  if (!m) throw new Error(`no claimed dist in: ${a.detail}`);
  return Number(m[1]);
};

// Сессия: сырые фиксы и trajBatch-якоря по машинам + геометрии по tripId.
type Fix = TramSnapshot & { _atMs: number };
const fixesByKey = new Map<string, Fix[]>();
const trajByKey = new Map<
  string,
  { atMs: number; anchorMs: number; anchorS: number; opinion0: number; source: string }[]
>();
const geomByTrip = new Map<
  string,
  { coordinates: [number, number][]; cumDistM: number[]; stops: { stopId: string; distM: number; name: string }[] }
>();

const sess = fs.readFileSync(path.join(ROOT, 'sessions/hunt1.jsonl'), 'utf8').split('\n');
for (const line of sess) {
  if (!line) continue;
  const ev = JSON.parse(line);
  if (ev.kind === 'geometry' && ev.served) geomByTrip.set(ev.tripId, ev.served);
  else if (ev.kind === 'fixSeed' || ev.kind === 'fixBatch') {
    const vehicles: TramSnapshot[] = ev.vehicles ?? ev.changed ?? ev.batch?.changed ?? [];
    for (const v of vehicles) {
      let arr = fixesByKey.get(v.key);
      if (!arr) fixesByKey.set(v.key, (arr = []));
      arr.push({ ...v, _atMs: ev.t });
    }
  } else if (ev.kind === 'trajBatch' || ev.kind === 'trajSeed') {
    const vehicles = ev.batch?.changed ?? ev.vehicles ?? [];
    for (const v of vehicles) {
      let arr = trajByKey.get(v.key);
      if (!arr) trajByKey.set(v.key, (arr = []));
      arr.push({
        atMs: ev.t,
        anchorMs: v.anchorMs,
        anchorS: v.anchorS,
        opinion0: v.opinion?.[0]?.s ?? NaN,
        source: v.source,
      });
    }
  }
}

// ── подклассы ──
const NEG: Anom[] = [];
const MID: Anom[] = [];
const POS: Anom[] = [];
for (const a of anoms) {
  const d = a.diag.simDistM - claimedOf(a);
  (d < -40 ? NEG : d <= 40 ? MID : POS).push(a);
}
const pct = (n: number) => `${((100 * n) / anoms.length).toFixed(0)}%`;
console.log(`total=${anoms.length} uniqKeys=${new Set(anoms.map((a) => a.key)).size}`);
console.log(`Δ<-40: ${NEG.length} (${pct(NEG.length)}) uniq=${new Set(NEG.map((a) => a.key)).size}`);
console.log(`|Δ|<=40: ${MID.length} (${pct(MID.length)})`);
console.log(`Δ>+40: ${POS.length} (${pct(POS.length)}) uniq=${new Set(POS.map((a) => a.key)).size}`);

// ── гипотеза (а) на Δ<0: сырой фикс — ось РОВНО на остановке? якорь уехал к координатам? ──
const stats = {
  axisAtStop: 0, // |shapeDistM фикса − остановка| ≤ 2 м
  axisAtStopAnchorToCoord: 0, // и якорь ушёл к коорд-проекции (>30 м от оси, ≤30 м от коорд)
  axisAtStopMarkerNearAnchor: 0,
  axisNotAtStop: 0,
  noData: 0,
};
const perCase: string[] = [];
for (const a of NEG) {
  const claimed = claimedOf(a);
  const fixes = fixesByKey.get(a.key) ?? [];
  // фикс, на котором стоит диагноз (совпадает по observedAtMs)
  const fix = fixes.filter((f) => f.observedAtMs === a.diag.obsAtMs && f._atMs <= a.atMs).pop()
    ?? fixes.filter((f) => f._atMs <= a.atMs).pop();
  const geom = fix ? geomByTrip.get(fix.tripId) : undefined;
  if (!fix || !geom) {
    stats.noData++;
    continue;
  }
  const sCoord = projectDistanceOnPolyline(
    [fix.coordinates[0], fix.coordinates[1]],
    geom.coordinates,
    geom.cumDistM,
  );
  const axisDelta = fix.shapeDistM - claimed;
  const anchorS = a.diag.anchorFixS;
  // trajBatch-якорь этой машины для этого фикса (по anchorMs)
  const served = (trajByKey.get(a.key) ?? []).filter(
    (t) => t.anchorMs === fix.observedAtMs,
  ).pop();
  const anchor = served?.anchorS ?? anchorS;
  const axisExact = Math.abs(axisDelta) <= 2;
  if (axisExact) {
    stats.axisAtStop++;
    const anchorFromAxis = anchor != null ? Math.abs(anchor - fix.shapeDistM) : NaN;
    const anchorFromCoord = anchor != null ? Math.abs(anchor - sCoord) : NaN;
    if (anchorFromAxis > 30 && anchorFromCoord <= 30) stats.axisAtStopAnchorToCoord++;
    if (anchor != null && Math.abs(a.diag.simDistM - anchor) <= 30)
      stats.axisAtStopMarkerNearAnchor++;
  } else stats.axisNotAtStop++;
  perCase.push(
    `${a.key}@${new Date(a.atMs).toISOString().slice(11, 19)} Δ=${(a.diag.simDistM - claimed).toFixed(0)} ` +
      `stop=${claimed.toFixed(0)} fixAxis=${fix.shapeDistM.toFixed(0)}(${axisExact ? 'РОВНО' : (axisDelta > 0 ? '+' : '') + axisDelta.toFixed(0)}) ` +
      `coordProj=${sCoord.toFixed(0)} servedAnchor=${anchor?.toFixed(0) ?? '—'}(src=${served?.source ?? '?'}) ` +
      `marker=${a.diag.simDistM.toFixed(0)} fixAge=${a.diag.fixAgeS.toFixed(0)}с`,
  );
}
console.log('\n— Δ<-40, гипотеза (а) —');
console.log(stats);

// Сводка по НЕ-точным (ось фикса не на остановке): куда смотрит маркер и
// прибьётся ли ось к остановке СЛЕДУЮЩИМ фиксом.
const sum = {
  axisDeltas: [] as number[],
  markerNearCoord: 0,
  markerNearAxis: 0,
  anchorNearCoord: 0,
  anchorNearAxis: 0,
  laterFixAxisExact: 0,
  laterChecked: 0,
};
for (const a of NEG) {
  const claimed = claimedOf(a);
  const fixes = fixesByKey.get(a.key) ?? [];
  const fix = fixes.filter((f) => f.observedAtMs === a.diag.obsAtMs && f._atMs <= a.atMs).pop()
    ?? fixes.filter((f) => f._atMs <= a.atMs).pop();
  const geom = fix ? geomByTrip.get(fix.tripId) : undefined;
  if (!fix || !geom) continue;
  const sCoord = projectDistanceOnPolyline(
    [fix.coordinates[0], fix.coordinates[1]],
    geom.coordinates,
    geom.cumDistM,
  );
  const axisDelta = fix.shapeDistM - claimed;
  sum.axisDeltas.push(axisDelta);
  if (Math.abs(a.diag.simDistM - sCoord) <= 15) sum.markerNearCoord++;
  if (Math.abs(a.diag.simDistM - fix.shapeDistM) <= 15) sum.markerNearAxis++;
  const anchor = a.diag.anchorFixS;
  if (anchor != null && Math.abs(anchor - sCoord) <= 15) sum.anchorNearCoord++;
  if (anchor != null && Math.abs(anchor - fix.shapeDistM) <= 15) sum.anchorNearAxis++;
  if (Math.abs(axisDelta) > 2) {
    // следующий фикс той же поездки в течение 90с — ось прибилась к остановке?
    const later = fixes.filter(
      (f) => f.observedAtMs > fix.observedAtMs && f.observedAtMs <= fix.observedAtMs + 90_000 && f.tripId === fix.tripId,
    );
    sum.laterChecked++;
    if (later.some((f) => Math.abs(f.shapeDistM - claimed) <= 2)) sum.laterFixAxisExact++;
  }
}
sum.axisDeltas.sort((x, y) => x - y);
const q = (p: number) => sum.axisDeltas[Math.floor(p * (sum.axisDeltas.length - 1))]?.toFixed(0);
console.log(
  `axisDelta(фикс−остановка) p10=${q(0.1)} p50=${q(0.5)} p90=${q(0.9)}; ` +
    `markerNearCoord=${sum.markerNearCoord} markerNearAxis=${sum.markerNearAxis} ` +
    `anchorNearCoord=${sum.anchorNearCoord} anchorNearAxis=${sum.anchorNearAxis}; ` +
    `у не-точных ось прибилась следующим фиксом: ${sum.laterFixAxisExact}/${sum.laterChecked}`,
);
for (const l of perCase) console.log('  ' + l);

// ── Δ>+40: сводка кейсов для посекундного разбора ──
console.log('\n— Δ>+40 кейсы —');
for (const a of POS) {
  const claimed = claimedOf(a);
  console.log(
    `  ${a.key}@${new Date(a.atMs).toISOString().slice(11, 19)} Δ=+${(a.diag.simDistM - claimed).toFixed(0)} ` +
      `stop=${claimed.toFixed(0)} marker=${a.diag.simDistM.toFixed(0)} fixAxis=${a.diag.obsDistM.toFixed(0)} ` +
      `anchor=${a.diag.anchorFixS?.toFixed(0)} fixAge=${a.diag.fixAgeS.toFixed(0)}с src=${a.diag.renderSource} ` +
      `shim=${a.diag.shimBranch} phase=${a.diag.phase} horizonLeft=${a.diag.horizonLeftS?.toFixed(0)} jump=${a.diag.lastJumpM?.toFixed(0)}/${a.diag.lastJumpAgoS?.toFixed(0)}с`,
  );
}
