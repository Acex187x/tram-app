/** Pure, bounded diagnostics. A displayed hold is evidence about the renderer,
 * never proof that the real vehicle stopped. No live fleet getters here. */
import type { PhysicsDebugInfo } from '@/lib/types';
import { evalTrajectory, trackEndMs, trackStartMs } from '@/lib/physics/evaluator';

export const HISTORY_MS = 60_000;
export const HISTORY_LIMIT = 61;
export const DEBUG_SAMPLE_MS = 1_000;
export interface MotionSample {
  atMs: number;
  tripId: string;
  mode: 'smooth' | 'fixed';
  renderedM: number;
  speedKmh: number;
  deltaM: number | null;
  fixAgeS: number;
  emissionAgeS: number | null;
}
export interface FuturePoint { seconds: number; distanceM: number }

/** Never draw the end-clamp as a forecast beyond the available horizon. */
export function sampleFuture(track: Float64Array | undefined, nowMs: number): FuturePoint[] {
  if (!track || track.length < 4 || nowMs < trackStartMs(track) || nowMs >= trackEndMs(track)) return [];
  const end = Math.min(nowMs + 60_000, trackEndMs(track));
  const out: FuturePoint[] = [];
  for (let t = nowMs; t < end; t += 5_000) out.push({ seconds: (t - nowMs) / 1000, distanceM: evalTrajectory(track, t) });
  out.push({ seconds: (end - nowMs) / 1000, distanceM: evalTrajectory(track, end) });
  return out;
}

export function appendSample(history: readonly MotionSample[], sample: MotionSample): MotionSample[] {
  const last = history[history.length - 1];
  // A different trip/mode/clock epoch is a different distance axis.
  if (last && (last.tripId !== sample.tripId || last.mode !== sample.mode || sample.atMs <= last.atMs)) return [sample];
  return [...history.filter((p) => p.atMs >= sample.atMs - HISTORY_MS), sample].slice(-HISTORY_LIMIT);
}

export function sampledSpeed(history: readonly MotionSample[]): number | null {
  if (history.length < 2) return null;
  const a = history[history.length - 2], b = history[history.length - 1];
  const dt = (b.atMs - a.atMs) / 1000;
  // Do not average across suspension or a paused inspector.
  return dt > 0 && dt <= 2.5 ? (b.renderedM - a.renderedM) / dt * 3.6 : null;
}

export function standDuration(history: readonly MotionSample[]): number {
  if (history.length < 2) return 0;
  const last = history[history.length - 1];
  let first = last;
  for (let i = history.length - 2; i >= 0; i--) {
    const p = history[i];
    if (first.atMs - p.atMs > 2_500 || Math.abs(p.renderedM - last.renderedM) > 0.5) break;
    first = p;
  }
  return (last.atMs - first.atMs) / 1000;
}

export interface Diagnosis { title: string; detail: string; level: 'ok' | 'notice' | 'warning' }
export function geometryEvidence(d: PhysicsDebugInfo): Diagnosis {
  if (d.geometryCoherence === 'invalid') return {
    title: 'Фикс противоречит маршруту',
    detail: 'Обе остановки фикса отсутствуют в геометрии, а GPS далеко от указанной точки оси. Маршрут и профили исключены: маркер показывает последние GPS-координаты без протяжки. Это не подтверждает остановку трамвая.',
    level: 'warning',
  };
  if (d.geometryCoherence === 'valid') return {
    title: 'Противоречие не выявлено',
    detail: 'Проверка остановок и координат не нашла сильного противоречия. Это не гарантия точности GPS или выбранного пути.',
    level: 'ok',
  };
  const reasons: Record<string, string> = {
    'missing-geometry': 'Геометрия маршрута ещё недоступна.',
    'missing-stop-ids': 'Недостаточно идентификаторов остановок для проверки.',
    'nonfinite-position': 'Координаты или расстояние фикса не позволяют выполнить проверку.',
  };
  return { title: 'Согласованность неизвестна', detail: reasons[d.geometryCoherenceReason ?? ''] ?? 'Результат проверки не сообщён.', level: 'notice' };
}
export function diagnose(d: PhysicsDebugInfo, history: readonly MotionSample[], future: readonly FuturePoint[]): Diagnosis {
  if (d.geometryCoherence === 'invalid') return geometryEvidence(d);
  if (!d.hasGeometry) return { title: 'Маршрут ещё не загружен', detail: 'На карте доступны только координаты последнего наблюдения.', level: 'warning' };
  if (!d.hasTrajectory) return { title: d.renderSource === 'client-naive' ? 'Движение без серверного профиля' : 'Нет профиля движения', detail: 'Проверьте рейс, поступление профиля и возраст фикса. Наличие линии маршрута само по себе не задаёт движение.', level: 'warning' };
  if (d.pastHorizon) return { title: d.simSpeedKmh > 0.5 ? 'Горизонт исчерпан · докатывание' : 'Горизонт исчерпан · маркер удерживается', detail: 'Будущего профиля нет. Докатывание — ограниченное отображение, а не новый прогноз.', level: 'warning' };
  if (d.renderGuardActive && d.simSpeedKmh <= 0.5 && d.renderGuardGapM < -0.5) return { title: 'Маркер ждёт отставшую цель', detail: 'Ограничитель не допускает обратного движения: новая цель позади маркера. Проверьте разрыв и изменение цели в истории.', level: 'notice' };
  const stopped = standDuration(history);
  const futureMove = future.length > 1 ? future[future.length - 1].distanceM - future[0].distanceM : null;
  if (stopped >= 5 && futureMove != null && futureMove > 5) return { title: `Маркер неподвижен ${Math.round(stopped)} с · путь впереди есть`, detail: 'Профиль обещает движение позже. Сравните текущий участок профиля, поправку по фиксу и ограничитель отображения; это ещё не доказательство бага.', level: 'warning' };
  if (d.simSpeedKmh <= 0.5) return { title: 'Маркер удерживается', detail: d.phase === 'terminal' ? 'Профиль достиг конца рейса. Реальное положение проверяется новым фиксом.' : d.phase === 'dwell' ? 'В текущем профиле стоянка. Причина реальной остановки по этим данным неизвестна.' : 'Текущий профиль или клиентская поправка не дают движения. Причина требует сравнения ниже.', level: 'notice' };
  if (d.connection !== 'live') return { title: 'Движение по сохранённому профилю', detail: 'Лента запаздывает; движение само по себе не подтверждает свежесть данных.', level: 'warning' };
  return { title: 'Маркер движется', detail: 'Сравнивайте плавность с возрастом наблюдения и разрывом профилей. FIXED — мнение модели, не измеренная истина.', level: 'ok' };
}

export function formatNumber(value: number | null | undefined, digits = 0, sign = false): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${sign && value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}
