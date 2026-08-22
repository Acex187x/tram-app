// ХАРНЕСС — телефон без телефона.
//
// ЕДИНЫЙ ИСТОЧНИК ПРАВДЫ: этот файл НЕ реализует физику. Он собирает ровно те
// же классы, что исполняет приложение — TrajectoryStore (fold Convex-ленты,
// часы) и TramFleet (наивный фолбек, jump-watch, adaptTram → renderTram →
// fixForward) из src/lib/physics — и кормит их теми же входами, что получает
// телефон. Всё время передаётся ПАРАМЕТРОМ (доктрина physics-v3: ни одного
// Date.now() в горячем пути), поэтому реплей записанной сессии детерминирован:
// одна запись + один и тот же код = одни и те же пиксели, что были на экране.
//
// Если бенч не воспроизводит поведение телефона — это баг ХАРНЕССА (не тот
// вход), либо код физики нечист (читает реальное время/глобальное состояние);
// и то и другое — находка.

import { TramFleet } from '@/lib/physics/fleet';
import { TrajectoryStore } from '@/lib/physics/trajectoryStore';
import type { TrajectoryBatchWire, TrajectoryMetaWire } from '@/lib/physics/convexSource';
import type { PhysicsDebugInfo, RouteGeometry, TramPublicState, TramSnapshot } from '@/lib/types';
import { servedToRouteGeometry, type ServedGeometry } from '@/lib/golemio/gtfs';

// Как в lab/src/run.ts: реестр моделей тянет .tsx-паки иконок, которые чужды
// node-only tsconfig — реестр подключается через require, минуя typecheck.
/* eslint-disable @typescript-eslint/no-require-imports */
const { getModelSpec, regNumberToModelId } =
  require('@/lib/fleet/registry') as typeof import('@/lib/fleet/registry');
/* eslint-enable @typescript-eslint/no-require-imports */

/** Одно записанное событие сессии (bench/sessions/*.jsonl, по строке на событие). */
export type SessionEvent =
  | { t: number; kind: 'fixSeed'; vehicles: TramSnapshot[] }
  | { t: number; kind: 'fixBatch'; changed: TramSnapshot[]; removed?: string[] }
  | { t: number; kind: 'trajSeed'; vehicles: unknown[]; meta: TrajectoryMetaWire | null }
  | { t: number; kind: 'trajBatch'; batch: TrajectoryBatchWire; serverNowMs: number }
  | { t: number; kind: 'trajMeta'; meta: TrajectoryMetaWire }
  | { t: number; kind: 'geometry'; tripId: string; served: ServedGeometry & { stops?: unknown } };

export class Bench {
  /** Convex-транспорт выключен: события сессии кормятся прямо в sink-методы. */
  readonly store = new TrajectoryStore();
  readonly fleet = new TramFleet({
    resolveModel: (s) => getModelSpec(regNumberToModelId(s.registrationNumber)),
    trajectories: this.store,
  });

  private readonly geoms = new Map<string, RouteGeometry>();
  private readonly fleetMap = new Map<string, TramSnapshot>();
  private fleetDirty = false;

  /** Ключи, замеченные в фикс-ленте (для «прогнать всех»). */
  keys(): string[] {
    return [...this.fleetMap.keys()];
  }

  geometry(tripId: string): RouteGeometry | undefined {
    return this.geoms.get(tripId);
  }

  /** Скормить одно событие сессии — рекордер и реплеер зовут только это. */
  feed(e: SessionEvent): void {
    switch (e.kind) {
      case 'geometry': {
        try {
          const g = servedToRouteGeometry(e.served, e.t);
          if (g) this.geoms.set(e.tripId, g);
        } catch {
          // кривая геометрия = трамвай без маршрута, как и на телефоне
        }
        // Телефон переингещивает флот на geometry-landed событиях
        // (tramData.onGeometryLoaded) — харнесс обязан делать то же, иначе
        // первые ~40 с реплея флот живёт без маршрутов, которых у телефона
        // в этот момент уже нет причин не иметь.
        this.fleetDirty = true;
        break;
      }
      case 'fixSeed': {
        this.fleetMap.clear();
        for (const v of e.vehicles) this.fleetMap.set(v.key, v);
        this.fleetDirty = true;
        break;
      }
      case 'fixBatch': {
        // Тот же фолд, что RemoteFeed.onBatches: changed поверх, removed прочь,
        // затем ingest МЕРДЖЕНОГО ПОЛНОГО списка (контракт рантайма).
        for (const v of e.changed) this.fleetMap.set(v.key, v);
        for (const k of e.removed ?? []) this.fleetMap.delete(k);
        this.fleetDirty = true;
        break;
      }
      case 'trajSeed':
        this.store.seedConvex(e.vehicles, e.meta, e.t);
        break;
      case 'trajBatch':
        this.store.foldConvex(e.batch, e.serverNowMs, e.t);
        break;
      case 'trajMeta':
        this.store.noteConvexMeta(e.meta, e.t);
        break;
    }
    if (this.fleetDirty) {
      this.fleet.ingest([...this.fleetMap.values()], (tripId) => this.geoms.get(tripId));
      this.fleetDirty = false;
    }
  }

  /**
   * Снимок одного трамвая на виртуальный момент `localNowMs` — ровно то, что
   * телефон нарисовал бы и показал бы в дебаг-панели в этот момент.
   */
  snapshot(
    key: string,
    localNowMs: number,
  ): { diag: PhysicsDebugInfo | undefined; state: TramPublicState | undefined } {
    return {
      diag: this.fleet.getDiagnostics(key, localNowMs),
      state: this.fleet.getState(key, localNowMs),
    };
  }
}
