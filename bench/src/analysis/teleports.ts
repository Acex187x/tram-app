// АНАТОМИЯ КЛАССА `teleport` — корреляция каждого скачка jump-watch с событиями
// ленты в причинном окне. НЕ копирует физику: импортирует настоящие модули
// (fixForwardTauMs, renderedDistM, trackFor, evalTrajectory) и НАСТОЯЩИЙ реплей
// (Bench + Detectors), затем пост-фактум классифицирует каждый телепорт.
//
//   TSX_TSCONFIG_PATH=bench/tsconfig.json bench/node_modules/.bin/tsx \
//     bench/src/analysis/teleports.ts sessions/hunt1.jsonl [--json out.jsonl]
//
// Классы механизмов:
//   swap-*     в причинном окне (предыдущий кадр, этот кадр] пришёл trajBatch с
//              этой машиной — скачок на свопе бандла. Подкласс по непрерывности
//              СЕРВЕРНЫХ кривых в точке свопа (старая vs новая эмиссия, оба
//              представления) и по source-переходу (ml→ml, naive→ml, …).
//   fix-*      trajBatch НЕ приходил, пришёл fixBatch — клиентская композиция
//              fixForward. Подкласс по перещёлку τ (off→wind, wind→off, →walk…).
//   naive-*    у машины нет кривых (client-naive dead-reckon от фикса).
//   unexplained ни того ни другого в окне.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Bench, type SessionEvent } from '../harness';
import { Detectors, type Anomaly } from '../detect';
import { parseVehicle, type ParsedVehicle } from '@/lib/physics/bundle';
import { evalTrajectory, trackStartMs, trackEndMs } from '@/lib/physics/evaluator';
import { fixForwardTauMs } from '@/lib/physics/fixForward';
import { catchupVMsFor, renderedDistM, trackFor } from '@/lib/physics/render';

const file = process.argv[2] ?? 'sessions/hunt1.jsonl';
const jsonOut = process.argv.includes('--json')
  ? process.argv[process.argv.indexOf('--json') + 1]
  : null;

const lines = fs
  .readFileSync(path.resolve(__dirname, '..', '..', file), 'utf8')
  .split('\n')
  .filter(Boolean);
const events: SessionEvent[] = lines.map((l) => JSON.parse(l) as SessionEvent);

// ── 1. Таймлайны ленты (независимо от мутируемого стора) ──────────────────────
interface TrajEvt { t: number; v: ParsedVehicle }
interface FixEvt { t: number; s: number; at: number; tripId: string }
const trajTl = new Map<string, TrajEvt[]>();
const fixTl = new Map<string, FixEvt[]>();
const pushTraj = (t: number, raw: unknown) => {
  const v = parseVehicle(raw);
  if (!v) return;
  let a = trajTl.get(v.key);
  if (!a) trajTl.set(v.key, (a = []));
  a.push({ t, v });
};
const pushFix = (t: number, s: { key: string; shapeDistM: number; observedAtMs: number; tripId: string }) => {
  let a = fixTl.get(s.key);
  if (!a) fixTl.set(s.key, (a = []));
  a.push({ t, s: s.shapeDistM, at: s.observedAtMs, tripId: s.tripId });
};
for (const e of events) {
  if (e.kind === 'trajSeed') for (const raw of e.vehicles) pushTraj(e.t, raw);
  else if (e.kind === 'trajBatch') for (const raw of e.batch.changed) pushTraj(e.t, raw);
  else if (e.kind === 'fixSeed') for (const v of e.vehicles) pushFix(e.t, v);
  else if (e.kind === 'fixBatch') for (const v of e.changed) pushFix(e.t, v);
}

// последний элемент таймлайна с t <= upTo (и индекс)
function lastBefore<T extends { t: number }>(arr: T[] | undefined, upTo: number): [T | null, number] {
  if (!arr) return [null, -1];
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= upTo) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return [ans >= 0 ? arr[ans] : null, ans];
}
function inWindow<T extends { t: number }>(arr: T[] | undefined, from: number, to: number): T[] {
  if (!arr) return [];
  return arr.filter((e) => e.t > from && e.t <= to);
}

// ── 2. Настоящий реплей → список телепортов ──────────────────────────────────
const bench = new Bench();
const det = new Detectors();
let virtualMs = events[0].t;
const TICK_MS = 1_000;
const tick = (upToMs: number): void => {
  for (; virtualMs + TICK_MS <= upToMs; virtualMs += TICK_MS) {
    for (const key of bench.keys()) {
      const { diag, state } = bench.snapshot(key, virtualMs);
      if (!diag || !state) continue;
      det.check(key, virtualMs, diag, state.snapshot, bench.geometry(state.snapshot.tripId));
    }
  }
};
for (const e of events) { tick(e.t); bench.feed(e); }
tick(virtualMs + TICK_MS);
const teleports = det.anomalies.filter((a) => a.kind === 'teleport');
console.log(`teleports: ${teleports.length}`);

// ── 3. Классификация ─────────────────────────────────────────────────────────
interface Verdict {
  key: string;
  atMs: number;       // тик обнаружения
  jumpLocalMs: number; // оценка локального момента скачка
  jumpM: number;
  mech: string;
  detail: string;
  a: Anomaly;
  extra?: Record<string, number | null>;
}
const verdicts: Verdict[] = [];
const SEAM_M = 15; // порог «сервер нарушил непрерывность» в точке свопа

for (const a of teleports) {
  const d = a.diag;
  const jumpM = d.lastJumpM ?? 0;
  const jumpLocal = a.atMs - (d.lastJumpAgoS ?? 0) * 1000; // кадр V со скачком
  const off = d.clockOffsetMs; // server = local + off
  const tsNow = jumpLocal + off;        // серверный момент кадра со скачком
  const tsPrev = tsNow - TICK_MS;       // предыдущий кадр
  // ПРИЧИННОЕ ОКНО. Реплей кормит событие ПЕРЕД кадром, если e.t < V+1000:
  // кадр V видит все события с t < V+1000, кадр V−1 — все с t < V. Значит,
  // скачок между ними вызван событиями с t ∈ [V, V+1000). ±100мс на джиттер
  // оценки jumpLocal через lastJumpAgoS.
  const W0 = jumpLocal - 1, W1 = jumpLocal + TICK_MS - 1;

  const trajIn = inWindow(trajTl.get(a.key), W0, W1);
  const fixIn = inWindow(fixTl.get(a.key), W0, W1);
  const [fixNow] = lastBefore(fixTl.get(a.key), jumpLocal + TICK_MS - 1);
  const [fixPrev] = lastBefore(fixTl.get(a.key), jumpLocal - 1);
  const [vehNowE] = lastBefore(trajTl.get(a.key), jumpLocal + TICK_MS - 1);
  const [vehPrevE] = lastBefore(trajTl.get(a.key), jumpLocal - 1);
  const vehNow = vehNowE?.v ?? null;
  const vehPrev = vehPrevE?.v ?? null;

  let mech = 'unexplained';
  let detail = '';

  if (trajIn.length > 0 && vehNow) {
    // ── своп бандла в окне: кадр V−1 рисовал vehPrev, кадр V рисует vehNow ──
    const newV = vehNow;
    const oldV = vehPrev;
    const srcFlip = `${oldV?.source ?? '∅'}→${newV.source ?? '?'}`;
    if (oldV && oldV.tripId === newV.tripId) {
      // разложение скачка: серверный шов кривых + перещёлк клиентского шима
      const oldTrack = trackFor(oldV, 'smooth');
      const newTrack = trackFor(newV, 'smooth');
      const rawOldPrev = renderedDistM(oldTrack, tsPrev, catchupVMsFor('smooth'), NaN, NaN, oldV.anchorMs);
      const rawOldNow = renderedDistM(oldTrack, tsNow, catchupVMsFor('smooth'), NaN, NaN, oldV.anchorMs);
      const rawNewNow = renderedDistM(newTrack, tsNow, catchupVMsFor('smooth'), NaN, NaN, newV.anchorMs);
      const curveSeam = rawNewNow - rawOldNow; // сервер: новая эмиссия vs старая в один момент
      const fp = fixPrev ?? { s: Number.NaN, at: Number.NaN };
      const fn = fixNow ?? { s: Number.NaN, at: Number.NaN };
      const shimOld = renderedDistM(oldTrack, tsPrev, catchupVMsFor('smooth'), fp.s, fp.at, oldV.anchorMs) - rawOldPrev;
      const shimNew = renderedDistM(newTrack, tsNow, catchupVMsFor('smooth'), fn.s, fn.at, newV.anchorMs) - rawNewNow;
      const shimSeam = shimNew - shimOld; // клиент: сколько добавки шима исчезло/появилось
      const sanctioned = trajIn.some((e) => e.v.discontinuity);
      const serverBroke = Math.abs(curveSeam) >= Math.abs(shimSeam) && Math.abs(curveSeam) >= SEAM_M;
      // fused-ось: насколько anchorS новой эмиссии разошёлся с shapeDistM
      // ленты для ТОГО ЖЕ фикса (anchorMs == observedAtMs) — сервер целился
      // не в ту ось, по которой клиентский шим ведёт маркер.
      const axisGapM =
        Number.isFinite(newV.anchorS) && fixNow && fixNow.at === newV.anchorMs
          ? newV.anchorS - fixNow.s
          : null;
      mech = sanctioned
        ? `swap-sanctioned(${srcFlip})`
        : serverBroke
          ? `swap-server-seam(${srcFlip})`
          : `swap-shim-reset(${srcFlip})`;
      detail =
        `swap srcFlip=${srcFlip} curveSeam=${curveSeam.toFixed(1)}м shim ${shimOld.toFixed(0)}→${shimNew.toFixed(0)}м ` +
        `axisGap=${axisGapM?.toFixed(1) ?? '—'}м fixInWin=${fixIn.length > 0} ` +
        `disc=${sanctioned} jump=${jumpM.toFixed(1)}м shim@детект=${d.shimBranch} эмиссий_в_окне=${trajIn.length}`;
    } else {
      mech = `swap-first-curve(${srcFlip})`;
      detail = `первая кривая/смена трипа в свопе, jump=${jumpM.toFixed(1)}м`;
    }
  } else if (vehNow && fixIn.length > 0 && fixNow && fixPrev) {
    // ── фикс без свопа: клиентская композиция fixForward ──
    const track = trackFor(vehNow, 'smooth');
    const tauPrev = fixForwardTauMs(track, fixPrev.s, fixPrev.at, vehNow.anchorMs);
    const tauNow = fixForwardTauMs(track, fixNow.s, fixNow.at, vehNow.anchorMs);
    const br = (t: number) => (t === 0 ? 'off' : t === Number.POSITIVE_INFINITY ? 'walk' : 'wind');
    const flip = `${br(tauPrev)}→${br(tauNow)}`;
    const rPrev = renderedDistM(track, tsPrev, catchupVMsFor('smooth'), fixPrev.s, fixPrev.at, vehNow.anchorMs);
    const rNow = renderedDistM(track, tsNow, catchupVMsFor('smooth'), fixNow.s, fixNow.at, vehNow.anchorMs);
    const allowS = (tsNow - trackStartMs(track)) / 1000; // возраст датума допуска
    const fixDelta = fixNow.s - fixPrev.s;
    mech = `fix-${flip}`;
    if (flip === 'off→wind' || flip === 'off→walk') mech = `fix-shim-on(${br(tauNow)})`;
    else if (flip === 'wind→off' || flip === 'walk→off') mech = 'fix-shim-off';
    else if (fixDelta < -10) mech = 'fix-axis-retreat';
    detail =
      `τ ${flip} (${(tauPrev / 1000).toFixed(1)}→${(tauNow / 1000).toFixed(1)}с) ` +
      `Δfix=${fixDelta.toFixed(1)}м rend ${rPrev.toFixed(0)}→${rNow.toFixed(0)} ` +
      `allowance=${(allowS * 2).toFixed(0)}м(датум ${allowS.toFixed(0)}с) jump=${jumpM.toFixed(1)}м`;
  } else if (!vehNow) {
    mech = fixIn.length > 0 ? 'naive-fix' : 'naive-tick';
    detail = `client-naive: Δfix=${fixPrev && fixNow ? (fixNow.s - fixPrev.s).toFixed(1) : '?'}м jump=${jumpM.toFixed(1)}м`;
  } else {
    // ни свопа, ни фикса — чистый тик по той же кривой с тем же фиксом
    const track = trackFor(vehNow, 'smooth');
    const endMs = trackEndMs(track);
    detail =
      `тик без событий: горизонт ${(endMs - tsNow) / 1000 > 0 ? 'жив' : 'кончился'} ` +
      `shim=${d.shimBranch} jump=${jumpM.toFixed(1)}м`;
  }
  const extra: Record<string, number | null> = {};
  const mAxis = detail.match(/axisGap=(-?\d+\.?\d*)м/);
  if (mAxis) extra.axisGapM = Number(mAxis[1]);
  const mAllow = detail.match(/allowance=(\d+)м/);
  if (mAllow) extra.allowanceM = Number(mAllow[1]);
  const mFixIn = detail.match(/fixInWin=(true|false)/);
  if (mFixIn) extra.fixInWin = mFixIn[1] === 'true' ? 1 : 0;
  verdicts.push({ key: a.key, atMs: a.atMs, jumpLocalMs: jumpLocal, jumpM, mech, detail, a, extra });
}

// ── 4. Отчёт ─────────────────────────────────────────────────────────────────
const q = (arr: number[], p: number) => {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const group = new Map<string, Verdict[]>();
for (const v of verdicts) {
  const g = group.get(v.mech) ?? [];
  g.push(v);
  group.set(v.mech, g);
}
console.log('\n== механизмы ==');
for (const [mech, g] of [...group.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const mags = g.map((v) => Math.abs(v.jumpM));
  const fwd = g.filter((v) => v.jumpM > 0).length;
  const ax = g.map((v) => v.extra?.axisGapM).filter((x): x is number => x != null);
  const al = g.map((v) => v.extra?.allowanceM).filter((x): x is number => x != null);
  const fw = g.map((v) => v.extra?.fixInWin).filter((x): x is number => x != null);
  let tail = '';
  if (ax.length > 0)
    tail += ` axisGap[p50=${q(ax, 0.5).toFixed(0)} p10=${q(ax, 0.1).toFixed(0)} p90=${q(ax, 0.9).toFixed(0)}]`;
  if (al.length > 0) tail += ` allowance[p50=${q(al, 0.5).toFixed(0)}м]`;
  if (fw.length > 0) tail += ` fixInWin=${((100 * fw.reduce((a2, b2) => a2 + b2, 0)) / fw.length).toFixed(0)}%`;
  console.log(
    `${mech}: ${g.length} (${((100 * g.length) / verdicts.length).toFixed(1)}%) ` +
      `fwd=${fwd} bwd=${g.length - fwd} |p50|=${q(mags, 0.5).toFixed(1)} |p90|=${q(mags, 0.9).toFixed(1)} max=${Math.max(...mags).toFixed(1)}${tail}`,
  );
}
console.log('\n== примеры по топ-механизмам ==');
for (const [mech, g] of [...group.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 6)) {
  const ex = [...g].sort((a, b) => Math.abs(b.jumpM) - Math.abs(a.jumpM)).slice(0, 3);
  console.log(`-- ${mech}`);
  for (const v of ex) {
    console.log(
      `   ${v.key} @${new Date(v.jumpLocalMs).toISOString().slice(11, 19)} ` +
        `jump=${v.jumpM.toFixed(1)}м  ${v.detail}`,
    );
  }
}
// сводки для п.1 задачи
const mags = verdicts.map((v) => Math.abs(v.jumpM));
const fwdAll = verdicts.filter((v) => v.jumpM > 0);
console.log(
  `\nвсего: fwd=${fwdAll.length} bwd=${verdicts.length - fwdAll.length} ` +
    `|p50|=${q(mags, 0.5).toFixed(1)} |p90|=${q(mags, 0.9).toFixed(1)} max=${Math.max(...mags).toFixed(1)}`,
);
const perKey = new Map<string, number>();
for (const v of verdicts) perKey.set(v.key, (perKey.get(v.key) ?? 0) + 1);
console.log('топ-10 машин:', [...perKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10));
// перекрёстка механизм × shimBranch на детекте
const cross = new Map<string, number>();
for (const v of verdicts) {
  const k = `${v.mech} × shim=${v.a.diag.shimBranch}/${v.a.diag.renderSource}`;
  cross.set(k, (cross.get(k) ?? 0) + 1);
}
console.log('\n== механизм × диагноз на детекте (топ-20) ==');
for (const [k, n] of [...cross.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${n}\t${k}`);

if (jsonOut) {
  fs.writeFileSync(
    path.resolve(__dirname, '..', '..', jsonOut),
    verdicts.map((v) => JSON.stringify({ key: v.key, jumpLocalMs: v.jumpLocalMs, jumpM: v.jumpM, mech: v.mech, detail: v.detail })).join('\n'),
  );
  console.log(`verdicts → ${jsonOut}`);
}
