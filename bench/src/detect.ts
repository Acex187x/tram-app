// ДЕТЕКТОРЫ — формализованные жалобы владельца. Каждая аномалия = класс из
// полевых скриншотов, пойманный числом, с полным дампом диагностики на момент
// срабатывания. Реплеер зовёт check() на каждый виртуальный тик (1 Гц).

import type { PhysicsDebugInfo, RouteGeometry, TramSnapshot } from '@/lib/types';
import { projectDistanceOnPolyline } from '@/lib/golemio/gtfs';

export interface Anomaly {
  kind:
    | 'teleport' // скачок маркера, не объяснимый ездой (jump-watch самой физики)
    | 'stand-mid-road' // стоит вне остановки, хотя координаты фикса уехали вперёд
    | 'behind-coords' // маркер устойчиво позади координат свежайшего фикса
    | 'stand-at-wrong-spot' // at_stop, но маркер далеко от заявленной остановки
    | 'walk-episode'; // τ=∞: фикс за горизонтом профиля
  key: string;
  atMs: number;
  detail: string;
  diag: PhysicsDebugInfo;
}

interface Track {
  standSinceMs: number;
  standAtM: number;
  behindSinceMs: number;
  walkSinceMs: number;
  lastJumpAtMs: number;
  prevSource: PhysicsDebugInfo['renderSource'] | null;
  reported: Set<string>;
}

export class Detectors {
  private tracks = new Map<string, Track>();
  readonly anomalies: Anomaly[] = [];
  private firstTickMs = 0;

  /** Устойчивости, чтобы не спамить: стояние ≥10с, позади ≥15с, walk ≥5с. */
  check(
    key: string,
    nowMs: number,
    diag: PhysicsDebugInfo,
    snap: TramSnapshot,
    geom: RouteGeometry | undefined,
  ): void {
    if (this.firstTickMs === 0) this.firstTickMs = nowMs;
    let tr = this.tracks.get(key);
    if (!tr) {
      tr = {
        standSinceMs: 0,
        standAtM: 0,
        behindSinceMs: 0,
        walkSinceMs: 0,
        lastJumpAtMs: 0,
        prevSource: null,
        reported: new Set(),
      };
      this.tracks.set(key, tr);
    }
    // Прогрев: первые 45 с реплей (как и телефон при холодном старте) честно
    // прыгает с сырых фиксов на первые кривые и доигрывает сид геометрий —
    // это не полевые аномалии. Глушим ВСЕ детекторы, не только телепорты.
    const warmupOver = nowMs - this.firstTickMs > 45_000;
    if (!warmupOver) {
      tr.prevSource = diag.renderSource;
      return;
    }
    const sourceSwitched = tr.prevSource !== null && tr.prevSource !== diag.renderSource;
    tr.prevSource = diag.renderSource;
    const once = (id: string, a: Omit<Anomaly, 'key' | 'atMs' | 'diag'>) => {
      if (tr!.reported.has(id)) return;
      tr!.reported.add(id);
      this.anomalies.push({ ...a, key, atMs: nowMs, diag });
    };

    // 1) телепорт — jump-watch физики (то, что видит панель). Прыжок в момент
    // смены источника (сырой фикс → первая кривая) — переход, не телепорт.
    if (
      warmupOver &&
      !sourceSwitched &&
      diag.lastJumpM != null &&
      diag.lastJumpAgoS != null &&
      diag.lastJumpAgoS < 3 &&
      nowMs - tr.lastJumpAtMs > 5_000
    ) {
      tr.lastJumpAtMs = nowMs;
      this.anomalies.push({
        kind: 'teleport',
        key,
        atMs: nowMs,
        detail: `скачок ${diag.lastJumpM.toFixed(0)}м (режим ${diag.shimBranch}, источник ${diag.renderSource})`,
        diag,
      });
    }

    // Координатное представление свежайшего фикса на оси (как в девтулсах).
    const sCoord =
      geom != null
        ? projectDistanceOnPolyline(
            [snap.coordinates[0], snap.coordinates[1]],
            geom.coordinates,
            geom.cumDistM,
          )
        : null;

    // 2) стоит посреди дороги, хотя координаты уехали.
    const standing = diag.simSpeedKmh <= 1;
    if (standing) {
      if (tr.standSinceMs === 0) {
        tr.standSinceMs = nowMs;
        tr.standAtM = diag.simDistM;
      }
      const standS = (nowMs - tr.standSinceMs) / 1000;
      const nearStopM =
        geom?.stops.reduce(
          (m, st) => Math.min(m, Math.abs(st.distM - diag.simDistM)),
          Infinity,
        ) ?? Infinity;
      // Честный рендер очереди (маркер на оси фикса, координаты смещены) —
      // данные города, не аномалия: требуем расхождения маркера с ОСЬЮ.
      if (
        standS >= 10 &&
        nearStopM > 40 &&
        sCoord != null &&
        sCoord - diag.simDistM > 60 &&
        Math.abs(diag.simDistM - snap.shapeDistM) > 40 &&
        diag.fixAgeS < 30
      ) {
        once(`smr-${Math.round(tr.standSinceMs / 1000)}`, {
          kind: 'stand-mid-road',
          detail: `стоит ${standS.toFixed(0)}с в ${nearStopM.toFixed(0)}м от остановки, координаты фикса на ${(sCoord - diag.simDistM).toFixed(0)}м впереди`,
        });
      }
      // 4) at_stop, но маркер не у заявленной остановки.
      // «Заявленная остановка» — только lastStopId: nextStopId у at_stop
      // фикса это остановка ВПЕРЕДИ, стоять не у неё — норма подъезда.
      // …и только когда МАРКЕР расходится с ОБОИМИ представлениями фикса:
      // трамвай, честно нарисованный на своём фиксе в очереди за 120 м до
      // платформы — это данные города, не аномалия рендера.
      const offAxisM = Math.abs(diag.simDistM - snap.shapeDistM);
      const offCoordM = sCoord != null ? Math.abs(diag.simDistM - sCoord) : Infinity;
      // …и только при СВЕЖЕМ фиксе: судить прогноз по фиксу 100+ секундной
      // давности нельзя — hunt3 показал, что «маркер не у остановки» при
      // молчащем фиде это ML, правильно уехавший вперёд (следующий фикс
      // подтверждал предсказанное место).
      if (
        standS >= 10 &&
        snap.statePosition === 'at_stop' &&
        geom &&
        snap.lastStopId &&
        offAxisM > 40 &&
        offCoordM > 40 &&
        diag.fixAgeS < 30
      ) {
        const claimed = geom.stops.find((st) => st.stopId === snap.lastStopId);
        if (claimed && Math.abs(claimed.distM - diag.simDistM) > 60) {
          once(`wrong-${Math.round(tr.standSinceMs / 1000)}`, {
            kind: 'stand-at-wrong-spot',
            detail: `feed=at_stop(${claimed.name}@${claimed.distM.toFixed(0)}м), маркер на ${diag.simDistM.toFixed(0)}м (Δ${(diag.simDistM - claimed.distM).toFixed(0)}м), ось фикса ${snap.shapeDistM.toFixed(0)}м, коорд-ось ${diag.fixCoordVsAxisM?.toFixed(0) ?? '—'}м`,
          });
        }
      }
    } else {
      tr.standSinceMs = 0;
    }

    // 3) маркер устойчиво позади координат фикса.
    if (sCoord != null && sCoord - diag.simDistM > 80) {
      if (tr.behindSinceMs === 0) tr.behindSinceMs = nowMs;
      if ((nowMs - tr.behindSinceMs) / 1000 >= 15) {
        once(`beh-${Math.round(tr.behindSinceMs / 1000)}`, {
          kind: 'behind-coords',
          detail: `маркер ${diag.simDistM.toFixed(0)}м, координаты фикса ${sCoord.toFixed(0)}м (позади на ${(sCoord - diag.simDistM).toFixed(0)}м уже ${((nowMs - tr.behindSinceMs) / 1000).toFixed(0)}с; фиксу ${diag.fixAgeS.toFixed(0)}с)`,
        });
      }
    } else {
      tr.behindSinceMs = 0;
    }

    // 5) τ=∞ эпизоды.
    if (diag.shimBranch === 'walk') {
      if (tr.walkSinceMs === 0) tr.walkSinceMs = nowMs;
      if ((nowMs - tr.walkSinceMs) / 1000 >= 5) {
        once(`walk-${Math.round(tr.walkSinceMs / 1000)}`, {
          kind: 'walk-episode',
          detail: `фикс за горизонтом ≥5с, дойти ${diag.walkRemainingM?.toFixed(0) ?? '?'}м`,
        });
      }
    } else {
      tr.walkSinceMs = 0;
    }
  }
}
