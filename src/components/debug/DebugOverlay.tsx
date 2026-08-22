// ДЕБАГ-ОВЕРЛЕЙ — живая техническая панель физики для трамвая, за которым ты
// следуешь (Settings ▸ Developer ▸ Debug mode). Нарочно не стилизована под
// приложение: плотные моноширинные строки, много сырых чисел — инструмент для
// оценки физики изнутри настоящего трамвая.
//
// СЛОВАРЬ (согласован с владельцем 2026-08-21) — все подписи ниже строго из него:
//   фикс             сырое наблюдение из городского фида («трамвай был в X в T»)
//   ML-прогноз       ответ ml-gbdt: 13 точек «где будет трамвай через 0…120 с»
//   опорный фикс     фикс, ОТ которого посчитан текущий ML-прогноз
//   профиль движения прогноз, превращённый в реалистичную кривую (fixed / smooth)
//   пересчёт прогноза один выпуск профиля сервером (по новому фиксу или старости)
//   слепая зона      сколько секунд НОВЫХ фиксов профиль ещё не видел
//   поправка по фиксу клиентская доводка: профиль промотан вперёд до свежего фикса
//   последний телепорт скачок маркера, который не объясняется ездой
//   наивный прогноз  замена ML простой физикой (сервер) / протяжка (клиент)
//   данные с БД      что движок сам знает про этот трамвай (его карточка)
//   последний апдейт от Convex — свежесть всей ленты профилей
//
// КАДЕНС — 10 Гц, но ТОЛЬКО в живой панели (`DebugLive`), санкционированное
// исключение из перф-инварианта ≤1 Гц: числовому тексту дисплейная частота не
// нужна, а панель размонтируется при сворачивании и освобождает GPS и таймер.
//
// Источники данных:
//   • fleet.getDiagnostics(key) — вся клиентская физика: источник движения,
//     состояние поправки по фиксу, оба профиля, свежесть всего;
//   • fleet.getState(key)       — следующая остановка, опоздание, сырой фикс;
//   • runtime.physicsHealth     — здоровье ленты Convex (машины, ошибки);
//   • /api/vehicle/:key/debug   — ДАННЫЕ С БД: что движок сам знает про этот
//     трамвай (его фиксы, чем посчитан профиль, дошёл ли он до Convex);
//   • OnlineLocator             — твой GPS, спроецированный на маршрут =
//     истинное положение (ты физически едешь в этом трамвае).
//
// Разности со знаком: ПЛЮС = нарисованный трамвай ВПЕРЕДИ настоящего.
import { createContext, useContext, useEffect, useState } from 'react';
import Constants from 'expo-constants';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getRuntime, useTramState } from '@/hooks/tramData';
import type { TrajectoryHealth } from '@/lib/physics/trajectoryStore';
import { Fonts } from '@/constants/theme';
import {
  projectOnlineDistAt,
  projectOnlineFix,
  useOnlineLocator,
  type OnlineFix,
  type OnlineLocator,
  type OnlineProjection,
} from '@/lib/motionlog';
import type { PhysicsDebugInfo, TramPublicState } from '@/lib/types';
import { useServerDebug } from './serverDebug';
import { useSelectionStore } from '@/stores/selection';
import { useSettingsStore } from '@/stores/settings';

const MONO = Fonts?.mono ?? 'monospace';
/** Достаточно для числовой диагностики, ~в 6 раз меньше React-коммитов, чем 60 Гц. */
export const DEBUG_LIVE_INTERVAL_MS = 100;

// ── форматирование ───────────────────────────────────────────────────────────

function num(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

/** Со знаком (ведущий + у неотрицательных) — для разностей, где знак и есть смысл. */
function signed(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(digits);
}

// ── живой снимок (пересобирается на 10 Гц) ───────────────────────────────────

interface DebugSnapshot {
  nowMs: number;
  dbg: PhysicsDebugInfo | undefined;
  state: TramPublicState | undefined;
  /** Здоровье ленты профилей (одно на весь флот). */
  health: TrajectoryHealth;
  fix: OnlineFix | null;
  proj: OnlineProjection | null;
  /** Фильтрованное GPS-положение, дотянутое вперёд до текущего момента. */
  realDistM: number | null;
  /** Сырой GPS на маршруте (без дотяжки). */
  realRawDistM: number | null;
  /** Метры до следующей остановки впереди нарисованной точки. */
  nextStopDistM: number | null;
  watchActive: boolean;
  watchError: string | null;
}

/** Прочитать всё свежее для `key` на текущий момент. Чистая функция (без записей). */
function buildSnapshot(key: string | null, locator: OnlineLocator): DebugSnapshot {
  const nowMs = Date.now();
  const runtime = getRuntime();
  const fleet = runtime.fleet;
  const dbg = key ? fleet.getDiagnostics(key, nowMs) : undefined;
  const state = key ? fleet.getState(key, nowMs) : undefined;
  const geometry = key ? fleet.getGeometry(key) : undefined;
  const fix = locator.latest();
  const proj = fix ? projectOnlineFix(fix, geometry) : null;
  const baseReal = proj ? (proj.fDistM ?? proj.gpsDistM) : null;
  const realDistM = projectOnlineDistAt(baseReal, fix, nowMs);
  const realRawDistM = proj ? proj.gpsDistM : null;

  let nextStopDistM: number | null = null;
  if (geometry && dbg) {
    for (const st of geometry.stops) {
      if (st.distM > dbg.simDistM + 0.5) {
        nextStopDistM = st.distM - dbg.simDistM;
        break;
      }
    }
  }
  return {
    nowMs,
    dbg,
    state,
    health: runtime.physicsHealth,
    fix,
    proj,
    realDistM,
    realRawDistM,
    nextStopDistM,
    watchActive: locator.active(),
    watchError: locator.error(),
  };
}

// ── словесные состояния ──────────────────────────────────────────────────────

/** Человеческий заголовок. Замороженные состояния ПЕРВЫМИ: стоящий из-за
 *  кончившихся данных трамвай нельзя перепутать со стоящим на остановке. */
function phaseLabel(d: PhysicsDebugInfo): string {
  if (!d.hasGeometry) return 'НЕТ ГЕОМЕТРИИ (точка без маршрута)';
  if (d.renderSource === 'client-naive') return 'НЕТ ПРОФИЛЯ — клиентская протяжка';
  if (!d.hasTrajectory) return 'НЕТ ПРОФИЛЯ — замер на последнем фиксе';
  // Фикс за горизонтом профиля: НЕ заморозка — smooth идёт к фиксу пешком,
  // fixed прибит к нему — но именно это состояние твоего бага.
  if (d.shimBranch === 'walk') return 'ФИКС ЗА ГОРИЗОНТОМ — идём к нему (τ=∞)';
  if (d.pastHorizon) return 'ЗА ГОРИЗОНТОМ — замер (данных дальше нет)';
  switch (d.phase) {
    case 'terminal':
      return 'НА КОНЕЧНОЙ (рейс закончен)';
    case 'dwell':
      return 'СТОИТ НА ОСТАНОВКЕ';
    case 'cruise':
      return d.mode === 'smooth' ? 'ЕДЕТ (профиль smooth)' : 'ЕДЕТ (профиль fixed)';
    default:
      return 'НЕТ ФАЗЫ (нет геометрии)';
  }
}

/** Всё примечательное про этот трамвай прямо сейчас, самое срочное первым. */
function activeNotes(d: PhysicsDebugInfo): string[] {
  const out: string[] = [];
  if (d.connection !== 'live') out.push(d.connection === 'offline' ? 'ОФЛАЙН' : 'ЗАДЕРЖКА ЛЕНТЫ');
  if (d.renderSource === 'curve-naive' && d.emissionAgeS != null && d.emissionAgeS > 6) {
    out.push('НАИВНЫЙ прогноз завис (ML-апгрейд не пришёл)');
  }
  if (d.renderSource === 'client-naive') out.push('клиентская протяжка');
  if (!d.hasTrajectory) out.push('профиля нет');
  else if (d.shimBranch === 'walk') out.push(`фикс за горизонтом — дойти ${num(d.walkRemainingM, 0)} м`);
  else if (d.pastHorizon) out.push('замер за горизонтом');
  if (d.lastJumpM != null && d.lastJumpAgoS != null && d.lastJumpAgoS < 60) {
    out.push(`ТЕЛЕПОРТ ${signed(d.lastJumpM, 0)} м ${num(d.lastJumpAgoS, 0)} с назад`);
  }
  if (d.anchorLagS != null && d.anchorLagS > 6) {
    out.push(`слепая зона ${num(d.anchorLagS, 0)} с`);
  }
  if (d.fixVsCurveM != null && d.fixVsCurveM > 50) {
    out.push(`профиль отстал от фикса на ${num(d.fixVsCurveM, 0)} м`);
  }
  if (d.discontinuity) out.push('скачок разрешён сервером');
  if (d.deltaM != null && Math.abs(d.deltaM) >= 1) {
    out.push(
      d.deltaM >= 0
        ? `smooth ВПЕРЕДИ fixed на ${num(d.deltaM, 1)} м${d.simSpeedKmh <= 1 ? ' И СТОИТ' : ''}`
        : `smooth догоняет fixed: ${num(-d.deltaM, 1)} м`,
    );
  }
  if (d.horizonLeftS != null && d.horizonLeftS < 15) {
    out.push(`горизонта осталось ${num(d.horizonLeftS, 1)} с`);
  }
  return out;
}

/** Подписи для «едет по» (карточка ИСТОЧНИК ДВИЖЕНИЯ). */
const RENDER_SOURCE_LABEL: Record<PhysicsDebugInfo['renderSource'], string> = {
  'curve-ml': 'ML-профиль',
  'curve-naive': 'НАИВНЫЙ профиль',
  'client-naive': 'клиентская протяжка',
  'raw-fix': 'замер на фиксе',
};

/** Подписи режимов поправки по фиксу. */
const SHIM_BRANCH_LABEL: Record<PhysicsDebugInfo['shimBranch'], string> = {
  off: 'спит (профиль свежий)',
  ahead: 'профиль ⩾ фикса',
  wind: 'промотка (конечное τ)',
  walk: 'ФИКС ЗА ГОРИЗОНТОМ',
};

/** Состояние связи по-русски. */
const CONNECTION_LABEL: Record<PhysicsDebugInfo['connection'], string> = {
  live: 'в норме',
  degraded: 'задержка',
  offline: 'ОФЛАЙН',
};

// ── данные с БД (карточка движка) ────────────────────────────────────────────
//
// Только в дебаг-режиме: развёрнутая панель раз в несколько секунд опрашивает
// движок про ЭТОТ трамвай — его последние фиксы, от какого фикса посчитан
// served-профиль, ML это или наивный, дошёл ли этот пересчёт до Convex и жив
// ли ML-сервис. Клиентские карточки говорят, что делает телефон; эта — что
// знает сервер. Вторая половина любого «какого хуя».

/**
 * ДАННЫЕ С БД — взгляд движка на этот трамвай. `clientFixAtMs` — свежайший
 * фикс ТЕЛЕФОНА: сравнение с фиксом движка мгновенно показывает, согласны ли
 * они вообще о реальности.
 */
function ServerCard({ tramKey, clientFixAtMs }: { tramKey: string; clientFixAtMs: number }) {
  const { data, error } = useServerDebug(tramKey);
  const guide = useContext(GuideContext);
  if (guide) return null;
  const now = data?.atMs ?? Date.now();
  const anchorAge = data?.anchorFix ? (now - data.anchorFix.obsAtMs) / 1000 : null;
  const latestAge = data?.latestFix ? (now - data.latestFix.obsAtMs) / 1000 : null;
  const anchorBehindM =
    data?.anchorFix && data?.latestFix ? data.latestFix.s - data.anchorFix.s : null;
  const phoneVsEngineFixS =
    data?.latestFix ? (clientFixAtMs - data.latestFix.obsAtMs) / 1000 : null;
  const fixes = (data?.fixes ?? []).slice(0, 3).map((f) => {
    const at = f.observedAtMs ?? f.obsAtMs;
    const s = f.shapeDistM ?? f.distM;
    const age = at != null ? `${Math.round((now - at) / 1000)}с` : '?';
    return `${age}·${s != null ? Math.round(s) : '?'}м·${f.statePosition ?? '?'}`;
  });
  return (
    <View style={styles.debugCard}>
      <SectionTitle>ДАННЫЕ С БД</SectionTitle>
      {error && <Row label="запрос" value={error} warn />}
      {!error && !data && <Row label="запрос" value="загрузка…" />}
      {data && !data.found && <Row label="запись" value="НЕТ В ДВИЖКЕ" warn />}
      {data?.found && (
        <>
          <Row
            label="профиль из"
            value={data.curveSource === 'naive' ? 'наивного прогноза' : data.curveSource === 'ml' ? 'ML-прогноза' : '—'}
            warn={data.curveSource === 'naive'}
          />
          <Row
            label="→ Convex"
            value={
              !data.publish?.enabled
                ? 'публикация ВЫКЛ'
                : data.publish.synced
                  ? 'доставлен'
                  : 'В ПУТИ'
            }
            warn={!data.publish?.enabled || data.publish?.synced === false}
          />
          <Row
            label="ML-сервис"
            value={data.ml ? (data.ml.ready ? 'готов' : (data.ml.lastError ?? 'не готов')) : '—'}
            warn={data.ml ? !data.ml.ready : false}
          />
          <Row
            label="опорный фикс"
            value={data.anchorFix ? `${num(data.anchorFix.s)}м · ${num(anchorAge, 0)}с` : '—'}
          />
          <Row
            label="свежий фикс"
            value={
              data.latestFix
                ? `${num(data.latestFix.s)}м · ${num(latestAge, 0)}с · ${data.latestFix.statePosition}`
                : '—'
            }
          />
          <Row
            label="опора отстала"
            value={anchorBehindM != null ? `${signed(anchorBehindM, 0)}м` : '—'}
            warn={anchorBehindM != null && anchorBehindM > 50}
          />
          <Row
            label="фиксы тел−движок"
            value={phoneVsEngineFixS != null ? `${signed(phoneVsEngineFixS, 0)}с` : '—'}
            warn={phoneVsEngineFixS != null && Math.abs(phoneVsEngineFixS) > 15}
          />
          {data.latestFix?.stuckAtM != null && (
            <Row label="пробка" value={`держим на ${num(data.latestFix.stuckAtM)}м`} warn />
          )}
          <Row label="интервал фиксов" value={data.latestFix ? `${num(data.latestFix.fixGapS, 0)}с` : '—'} />
          <Row label="последние фиксы" value={fixes.join('  ') || '—'} />
        </>
      )}
    </View>
  );
}

// ── гайд ─────────────────────────────────────────────────────────────────────
//
// Каждая строка умеет объяснить СЕБЯ: `GUIDE_SECTIONS` — единственный список
// подписей, гайд-режим рендерит его же, так что подпись не может разъехаться
// со своей документацией.

interface GuideSection {
  title: string;
  /** [подпись строки ровно как в живой панели, объяснение простым языком]. */
  rows: [string, string][];
}

const GUIDE_SECTIONS: GuideSection[] = [
  {
    title: 'ИСТОЧНИК ДВИЖЕНИЯ',
    rows: [
      [
        'едет по',
        'На основе чего маркер движется прямо сейчас. «ML-профиль» — профиль из ML-прогноза. «НАИВНЫЙ профиль» — простая быстрая физика: сервер эмитит её МГНОВЕННО на каждый новый фикс, а через ~1–3 с заменяет ML-профилем — короткие вспышки наивного здесь штатны; подсветка загорается только если наивный завис (ML-апгрейд не пришёл за 6 с). «Клиентская протяжка» — профиля нет вообще, телефон тянет точку от последнего фикса с наблюдаемым темпом (до 60 с). «Замер на фиксе» — нет ни профиля, ни темпа.',
      ],
      [
        'лента Convex',
        'Профили приходят пуш-потоком из Convex в момент пересчёта; число — позиция в ленте (растёт с каждым пересчётом любой машины). Другого транспорта больше нет.',
      ],
      ['генератор', 'Какой генератор построил профили — по данным самой ленты. Продакшен публикует drive-v3.'],
      [
        'опорный фикс',
        'ТОТ фикс, от которого посчитан текущий ML-прогноз: метры по маршруту и его возраст. Всё, во что верит профиль, начинается с этого наблюдения.',
      ],
      [
        'прогноз не видел',
        'СЛЕПАЯ ЗОНА: сколько секунд более новых фиксов served-профиль ещё не видел (время свежайшего фикса минус время опорного). В норме 0–4 с — движок пересчитывает каждые ~2 с. Стабильно большая = движок отстаёт от жизни, и клиенту приходится доводить точку поправкой по фиксу.',
      ],
      ['пересчёт прогноза', 'Сколько секунд назад сервер выпустил этот профиль.'],
      [
        'смены профиля',
        'Последние принятые пересчёты, свежий слева: чем посчитан каждый (ml или наив) и сколько секунд назад выпущен. Наивная вставка живёт всего ~1–3 с до ML-апгрейда — мгновенно её не поймать, а здесь она остаётся видимой. Паттерн «наив N с ← ml…» на проблемном фиксе = мгновенная коррекция сработала; сплошные ml = старый профиль был достаточно точен и вставка не потребовалась.',
      ],
    ],
  },
  {
    title: 'ПОПРАВКА ПО ФИКСУ',
    rows: [
      [
        'режим',
        'Что поправка делает сейчас. «Спит» — фикса новее опорного нет, профиль рисуется как есть. «Профиль ⩾ фикса» — новый фикс есть, но профиль уже на нём/впереди. «Промотка» — профиль промотан на τ секунд вперёд, чтобы пройти через фикс. «ФИКС ЗА ГОРИЗОНТОМ» — трамвай уехал дальше ВСЕГО, что профиль предсказал: smooth идёт к фиксу пешком (⩽2 м/с сверху), fixed прибит к фиксу. Это состояние твоего бага — скриншоть эту карточку.',
      ],
      ['промотка τ', 'На сколько секунд профиль промотан вперёд. ∞ = режим «фикс за горизонтом».'],
      [
        'отрыв фикса',
        'Свежий фикс минус положение профиля в момент фикса, в метрах. Плюс = трамвай доказуемо впереди нарисованного — тот разрыв, который поправка закрывает.',
      ],
      [
        'поправка сейчас',
        'Сколько метров поправка добавляет к маркеру прямо сейчас, после ограничения скорости режима: fixed берёт весь разрыв сразу, smooth — не быстрее 2 м/с сверху.',
      ],
      ['осталось дойти', 'Только для «фикс за горизонтом»: сколько метров ещё идти до фикса.'],
      [
        'последний телепорт',
        'Последний СКАЧОК маркера, который не объясняется ездой (вперёд больше ~20 м/с + запас, или назад больше 10 м): сколько метров и когда. Минус = маркер улетел НАЗАД. Именно эта строка ловит «телепортировался и стоит» — если она загорелась, смотри, в каком режиме была поправка и что в ДАННЫХ С БД.',
      ],
      ['фикс', 'Свежайший фикс на телефоне: метры по маршруту и возраст.'],
      [
        'коорд−ось',
        'Один и тот же фикс в двух представлениях фида: сырые координаты, спроецированные на ось маршрута, минус заявленная дистанция по оси. Пражский фид рутинно противоречит сам себе до ±70 м (замерено 2026-08-22: у 65 % флота разъезд > 25 м, у стоящих на остановках хуже всего). Весь движок живёт на ОСИ — поэтому ОПОРА на карте (ось) и ФИКС (координаты) могут стоять в разных местах при нулевой слепой зоне: это противоречие данных города, не баг пайплайна.',
      ],
      ['наблюдаемый темп', 'Скорость по последним двум фиксам. Ею же едет клиентская протяжка.'],
    ],
  },
  {
    title: 'ПРОФИЛИ ДВИЖЕНИЯ',
    rows: [
      ['рисуем', 'Какой из двух профилей показывает карта: smooth (плавный) или fixed (точный). Выбирается переключателем «Более точное положение».'],
      ['smooth', 'Метры по маршруту на профиле smooth. Сервер вшивает в него непрерывность — он не телепортируется, кроме разрешённого скачка.'],
      ['fixed', 'Метры по маршруту на профиле fixed — сырое мнение модели; перепривязывается к каждому фиксу и имеет право прыгать.'],
      [
        'разрыв точек',
        'smooth − fixed в метрах. ПЛЮС = smooth убежала вперёд и будет ждать/ехать медленнее, пока модель догонит; если при этом скорость 0 — трамвай стоит посреди перегона именно поэтому (второй подозреваемый твоего бага, заголовок это подсветит). Минус = smooth догоняет.',
      ],
      ['скорость', 'С какой скоростью реально движется нарисованная точка (профиль + поправка).'],
      ['горизонт', 'Сколько секунд профиля осталось. На нуле точка плавно докатывается и замирает притушенной — дальше данных нет.'],
      ['скачок', 'Разрешил ли сервер этому пересчёту телепорт (смена рейса или большой рассинхрон) + сколько разрешений было за сессию.'],
    ],
  },
  {
    title: 'ДАННЫЕ С БД',
    rows: [
      ['профиль из', 'Чем движок посчитал served-профиль: ML-прогнозом или наивным (простая физика на время падения ML).'],
      ['→ Convex', 'Дошёл ли ИМЕННО этот пересчёт до Convex (то, что читает телефон). «В ПУТИ» дольше пары секунд = публикация сломана.'],
      ['ML-сервис', 'Отвечает ли LightGBM-сервис движку вообще.'],
      ['опорный фикс', 'От какого фикса движок посчитал served-профиль (по его собственным записям).'],
      ['свежий фикс', 'Свежайший фикс, который движок держит для этого трамвая, с состоянием из фида.'],
      ['опора отстала', 'Свежий фикс движка минус опорный, в метрах — насколько реальность уехала от прогноза по данным самого сервера.'],
      ['фиксы тел−движок', 'Время фикса на телефоне минус у движка, секунд. Должно быть ≈0 (оба читают одну ленту фиксов); большое = телефон и движок расходятся о самой реальности.'],
      ['интервал фиксов', 'Наблюдаемый интервал между последними двумя фиксами этого трамвая.'],
      ['последние фиксы', 'Последние фиксы из архива движка: возраст · метры · состояние.'],
    ],
  },
  {
    title: 'СВЯЗЬ',
    rows: [
      [
        'состояние',
        '«В норме» (апдейт моложе 15 с), «задержка» (15–45 с — трамваи продолжают ехать по профилям), «ОФЛАЙН» (старше 45 с или подписка падает — баннер, трамваи докатываются до конца профилей и замирают).',
      ],
      [
        'апдейт от Convex',
        'Сколько секунд назад пришёл последний апдейт ленты (пересчёт любой машины или сердцебиение движка — тихий флот не выглядит мёртвым). Именно он решает состояние выше.',
      ],
      ['сдвиг часов', 'Часы сервера минус часы телефона, сглажено. Все профили читаются по ИСПРАВЛЕННОМУ времени — поэтому два телефона рисуют трамвай в одном месте.'],
      ['машин в ленте', 'Сколько машин сейчас в ленте профилей.'],
      ['подписка', 'Падает ли подписка/загрузка прямо сейчас.'],
    ],
  },
  {
    title: 'GPS РАЙДЕРА (м)',
    rows: [
      ['точка−я', 'Честная метрика: нарисованная точка минус ТВОЁ GPS-положение вдоль маршрута. Плюс = приложение рисует трамвай впереди того, в котором ты сидишь.'],
      ['точка−фикс', 'Нарисованная точка минус последний фикс.'],
      ['я−фикс', 'Твоё GPS-положение минус фикс — насколько запаздывает/врёт сам фид.'],
      ['GPS фильтр/сырой', 'Твой GPS на маршруте: фильтрованный и сырой — видно работу фильтра выбросов.'],
      ['GPS-вотч', 'Крутится ли вотч геолокации. Все строки выше без него пусты.'],
      ['точность', 'Горизонтальная точность GPS. Выше ~30 м числа лага шумные.'],
      ['до рельсов', 'Насколько твой GPS в стороне от путей — фильтрованный / сырой. Много = проекция гадает.'],
    ],
  },
  {
    title: 'СЛЕДУЮЩАЯ ОСТАНОВКА',
    rows: [
      ['остановка', 'Следующая остановка впереди нарисованной точки.'],
      ['метры / прибытие', 'Расстояние до неё вдоль маршрута и когда профиль smooth его пересечёт. За горизонтом прибытие пустое — дальше данных честно нет.'],
      ['опоздание', 'Опоздание по расписанию из фида. Плюс = опаздывает.'],
      ['состояние / фаза', 'Состояние из фида и выведенная фаза: едет, стоит на остановке, конечная.'],
    ],
  },
];

/** Плоский словарь подпись → объяснение для `Row` в гайд-режиме. */
const GUIDE: Record<string, string> = Object.fromEntries(GUIDE_SECTIONS.flatMap((s) => s.rows));

const PRIMER: [string, string][] = [
  [
    'ПРОБЛЕМА',
    'Город сообщает о каждом трамвае только раз в ~10–20 с (фикс), и эти позиции уже устарели на секунды. Всё движение между фиксами приходится предсказывать.',
  ],
  [
    'КТО ПРЕДСКАЗЫВАЕТ',
    'Сервер, для всего флота, каждые ~2 с: ML-модель (ml-gbdt) даёт прогноз на 120 с вперёд, генератор drive-v3 превращает его в реалистичный ПРОФИЛЬ ДВИЖЕНИЯ (разгоны, торможения, остановки), и каждый пересчёт тут же ПУШится в телефон через Convex. Если ML упал — сервер держит старый профиль, пока тот описывает трамвай, а потом подставляет наивный прогноз (простая физика).',
  ],
  [
    'ЧТО ДЕЛАЕТ ТЕЛЕФОН',
    'Почти ничего: находит две точки профиля вокруг «сейчас», интерполирует и кладёт на маршрут. Плюс одна поправка: если пришёл фикс, которого профиль не видел, профиль проматывается вперёд до него (поправка по фиксу). Симуляции и состояния нет — поэтому трамвай всегда на рельсах.',
  ],
  [
    'ДВА ПРОФИЛЯ',
    'У каждого трамвая их два: SMOOTH (непрерывность вшита — не телепортируется) и FIXED (сырое мнение модели — прыгает к каждому фиксу). Карта рисует один; панель всегда показывает оба, их разность — строка «разрыв точек».',
  ],
  [
    'ОДНИ ЧАСЫ',
    'Профили размечены серверным временем; телефон меряет ошибку своих часов и читает по исправленному времени. Два телефона с разными часами рисуют один и тот же трамвай.',
  ],
  [
    'ЧЕСТНОСТЬ',
    'Когда данные перестают приходить, трамваи доезжают профили до конца, плавно докатываются и ЗАМИРАЮТ притушенными за явным баннером. Ничто не анимируется дальше реальных данных.',
  ],
  [
    'ИСТИНА',
    'Пока ты едешь, твой собственный GPS проецируется на тот же маршрут. «Точка−я» — настоящая ошибка: плюс значит приложение рисует трамвай впереди того, в котором ты сидишь.',
  ],
];

/** Истина, пока панель показывает объяснения вместо живых значений. */
const GuideContext = createContext(false);

// ── строки ───────────────────────────────────────────────────────────────────

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  const guide = useContext(GuideContext);
  if (guide) {
    return (
      <View style={styles.guideRow}>
        <Text style={styles.guideLabel}>{label}</Text>
        <Text style={styles.guideHelp}>{GUIDE[label] ?? '(нет описания)'}</Text>
      </View>
    );
  }
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, warn && styles.valueWarn]}>{value}</Text>
    </View>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <Text style={styles.section}>{children}</Text>;
}

// ── компонент ────────────────────────────────────────────────────────────────

/** collapsed → одна строка · live → панель · guide → что всё это значит. */
type DebugMode = 'collapsed' | 'live' | 'guide';

export function DebugOverlay() {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const followKey = useSelectionStore((s) => s.followTramKey);
  const selectedKey = useSelectionStore((s) => s.selectedTramKey);
  const positionMode = useSettingsStore((s) => s.positionMode);
  const key = followKey ?? selectedKey;
  // 1 Гц — заголовку нужны только линия и модель, не покадровое чтение.
  const state = useTramState(key);
  const [mode, setMode] = useState<DebugMode>('live');
  const collapsed = mode === 'collapsed';
  const guide = mode === 'guide';
  // Нативный CFBundleVersion — доказательство, какой бинарь стоит на девайсе.
  const buildNumber = Constants.platform?.ios?.buildNumber ?? '?';

  const header = key
    ? `DBG ${key}${state ? ` · L${state.snapshot.line} · ${state.model.id}` : ''}`
    : 'DEBUG — трамвай не выбран';

  const maxPanelH = Math.min(224, Math.round(windowHeight * 0.28));

  return (
    <View
      style={[styles.wrap, { top: insets.top + 4, maxHeight: maxPanelH }]}
      pointerEvents="box-none"
    >
      <View style={[styles.panel, { maxHeight: maxPanelH }]}>
        <View style={styles.headerRow}>
          <Pressable
            onPress={() => setMode(collapsed ? 'live' : 'collapsed')}
            style={styles.headerTap}
            accessibilityRole="button"
            accessibilityLabel="Свернуть или развернуть дебаг-панель"
          >
            <Text style={styles.header} numberOfLines={1}>
              {header}
            </Text>
          </Pressable>
          {/* Совпадает с трассами на карте (DebugMapTraces). `*` — профиль,
              который карта реально рисует; у ФИКСА звёздочки не бывает. */}
          <View style={styles.legend} pointerEvents="none">
            <Text style={[styles.legendText, styles.legendFix]}>● ФИКС</Text>
            <Text style={[styles.legendText, styles.legendFixed]}>
              ● FIXED{positionMode === 'fixed' ? '*' : ''}
            </Text>
            <Text style={[styles.legendText, styles.legendSmooth]}>
              ● SMOOTH{positionMode === 'smooth' ? '*' : ''}
            </Text>
            <Text style={[styles.legendText, styles.legendMl]}>● ML</Text>
          </View>
          <Text style={styles.buildNumber}>B{buildNumber}</Text>
          {/* Гайд: каждая строка меняется на объяснение + букварь движка. */}
          <Pressable
            onPress={() => setMode(guide ? 'live' : 'guide')}
            style={styles.hintTap}
            accessibilityRole="button"
            accessibilityLabel={guide ? 'Показать живые значения' : 'Объяснить значения'}
          >
            <Text style={[styles.hint, guide && styles.hintActive]}>{guide ? '↩' : '?'}</Text>
          </Pressable>
          <Pressable
            onPress={() => setMode(collapsed ? 'live' : 'collapsed')}
            style={styles.hintTap}
            accessibilityRole="button"
            accessibilityLabel="Свернуть или развернуть дебаг-панель"
          >
            <Text style={styles.hint}>{collapsed ? '▸' : '▾'}</Text>
          </Pressable>
        </View>

        {!key && !guide && (
          <Text style={styles.note}>Выбери трамвай и включи «Следовать», чтобы разобрать его физику.</Text>
        )}

        {key && collapsed && <DebugCollapsed tramKey={key} />}

        {!collapsed && guide && <DebugGuide />}

        {key && !collapsed && !guide && <DebugLive tramKey={key} />}
      </View>
    </View>
  );
}

/** Свёрнутая строка: ничего быстрее фазы не меняется — 1 Гц, без GPS-вотча. */
function DebugCollapsed({ tramKey }: { tramKey: string }) {
  const [dbg, setDbg] = useState<PhysicsDebugInfo | undefined>(undefined);

  useEffect(() => {
    const read = () => setDbg(getRuntime().fleet.getDiagnostics(tramKey, Date.now()));
    read();
    const id = setInterval(read, 1_000);
    return () => clearInterval(id);
  }, [tramKey]);

  return (
    <Text style={styles.collapsed} numberOfLines={1}>
      {dbg ? phaseLabel(dbg) : '…'} · {num(dbg?.simSpeedKmh, 0)} км/ч
    </Text>
  );
}

/** Гайд: только статический текст — без чтений движка, GPS и циклов. */
function DebugGuide() {
  return (
    <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
      <GuideContext.Provider value>
        <SectionTitle>КАК РАБОТАЕТ ДВИЖОК</SectionTitle>
        {PRIMER.map(([title, body]) => (
          <View key={title} style={styles.guideRow}>
            <Text style={styles.guideLabel}>{title}</Text>
            <Text style={styles.guideHelp}>{body}</Text>
          </View>
        ))}
        <GuideBody />
      </GuideContext.Provider>
    </ScrollView>
  );
}

/**
 * Живая панель — единственный владелец 10 Гц цикла и GPS-вотча. Монтируется
 * только развёрнутой, не в гайде и со следуемым трамваем; размонтирование
 * освобождает локатор и чистит таймер.
 */
function DebugLive({ tramKey }: { tramKey: string }) {
  const locator = useOnlineLocator();
  const [snap, setSnap] = useState<DebugSnapshot | null>(null);

  useEffect(() => {
    const read = () => setSnap(buildSnapshot(tramKey, locator));
    read();
    const id = setInterval(read, DEBUG_LIVE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [tramKey, locator]);

  const dbg = snap?.dbg;
  const health = snap?.health;
  const fix = snap?.fix ?? null;
  const proj = snap?.proj ?? null;
  const realDistM = snap?.realDistM ?? null;
  const realRawDistM = snap?.realRawDistM ?? null;

  // Разности со знаком (+ = нарисованный трамвай впереди настоящего).
  const lagM = dbg && realDistM != null ? dbg.simDistM - realDistM : null;
  const simVsObs = dbg ? dbg.simDistM - dbg.obsDistM : null;
  const realVsObs = realDistM != null && dbg ? realDistM - dbg.obsDistM : null;

  return (
    <ScrollView
      horizontal
      style={styles.scroll}
      contentContainerStyle={styles.liveDeck}
      showsHorizontalScrollIndicator={false}
    >
      {!dbg && <Text style={styles.note}>Состояния ещё нет (ждём фикс).</Text>}
      {dbg && health && (
        <>
          {/* НА ЧЁМ ЕДЕТ ТРАМВАЙ — карточка пайплайна. По порядку: какие
              данные движут маркером, из какой ленты, от какого фикса посчитан
              ML-прогноз и насколько тот отстал от свежайшего фикса. */}
          <View style={styles.debugCard}>
            <Text style={styles.phase}>{phaseLabel(dbg)}</Text>
            <SectionTitle>ИСТОЧНИК ДВИЖЕНИЯ</SectionTitle>
            {/* Наивный профиль — ШТАТНАЯ первая фаза каждого фикса (сервер
                эмитит его мгновенно, ML-апгрейд приходит через ~1–3 с), так
                что свежий наивный не тревога. Тревога — наивный, который так
                и не сменился ML-профилем. */}
            <Row
              label="едет по"
              value={RENDER_SOURCE_LABEL[dbg.renderSource]}
              warn={
                dbg.renderSource === 'curve-naive'
                  ? dbg.emissionAgeS != null && dbg.emissionAgeS > 6
                  : dbg.renderSource !== 'curve-ml'
              }
            />
            <Row label="лента Convex" value={`№${num(dbg.feedSeq)}`} />
            <Row label="генератор" value={dbg.serverGen ?? '—'} />
            <Row
              label="опорный фикс"
              value={
                dbg.anchorFixS != null
                  ? `${num(dbg.anchorFixS)}м · ${num(dbg.anchorAgeS, 1)}с`
                  : dbg.anchorAgeS != null
                    ? `? · ${num(dbg.anchorAgeS, 1)}с`
                    : '—'
              }
            />
            <Row
              label="прогноз не видел"
              value={dbg.anchorLagS != null ? `${num(dbg.anchorLagS, 1)}с фиксов` : '—'}
              warn={dbg.anchorLagS != null && dbg.anchorLagS > 6}
            />
            <Row
              label="пересчёт прогноза"
              value={dbg.emissionAgeS != null ? `${num(dbg.emissionAgeS, 1)}с назад` : '—'}
              warn={dbg.emissionAgeS != null && dbg.emissionAgeS > 70}
            />
            {/* Историю ВИДНО, мгновенный флаг — нет. Для наивных вставок
                показано, СКОЛЬКО каждая прожила до следующего пересчёта —
                прямой ответ на «наивный живёт дольше, чем показывают». */}
            <Row
              label="смены профиля"
              value={
                dbg.profileHistory.length > 0
                  ? dbg.profileHistory
                      .slice(0, 4)
                      .map((e, i, arr) => {
                        const base = `${e.source === 'naive' ? 'наив' : 'ml'} ${num(e.ageS, 1)}с`;
                        // lived = my age − the age of the NEXT (newer) entry
                        const next = i > 0 ? arr[i - 1] : null;
                        return e.source === 'naive' && next
                          ? `${base}(жил ${num(Math.max(0, e.ageS - next.ageS), 1)}с)`
                          : base;
                      })
                      .join(' ← ')
                  : '—'
              }
              warn={dbg.profileHistory[0]?.source === 'naive' && dbg.profileHistory[0].ageS > 6}
            />
          </View>

          {/* ПОПРАВКА ПО ФИКСУ — механика τ. Карточка, которую скриншотишь при
              телепорте или стоянии посреди дороги. */}
          <View style={styles.debugCard}>
            <SectionTitle>ПОПРАВКА ПО ФИКСУ</SectionTitle>
            <Row
              label="режим"
              value={SHIM_BRANCH_LABEL[dbg.shimBranch]}
              warn={dbg.shimBranch === 'walk'}
            />
            <Row
              label="промотка τ"
              value={dbg.shimBranch === 'walk' ? '∞' : dbg.tauS != null ? `${num(dbg.tauS, 1)}с` : '—'}
            />
            <Row
              label="отрыв фикса"
              value={dbg.fixVsCurveM != null ? `${signed(dbg.fixVsCurveM, 1)}м` : '—'}
              warn={dbg.fixVsCurveM != null && dbg.fixVsCurveM > 100}
            />
            <Row
              label="поправка сейчас"
              value={dbg.fixForwardM != null ? `${signed(dbg.fixForwardM, 1)}м` : '—'}
            />
            <Row
              label="осталось дойти"
              value={dbg.walkRemainingM != null ? `${num(dbg.walkRemainingM, 1)}м` : '—'}
              warn={dbg.walkRemainingM != null && dbg.walkRemainingM > 30}
            />
            <Row
              label="последний телепорт"
              value={
                dbg.lastJumpM != null
                  ? `${signed(dbg.lastJumpM, 0)}м · ${num(dbg.lastJumpAgoS, 0)}с назад`
                  : 'не было'
              }
              warn={dbg.lastJumpM != null && dbg.lastJumpAgoS != null && dbg.lastJumpAgoS < 120}
            />
            <Row label="фикс" value={`${num(dbg.obsDistM)}м · ${num(dbg.fixAgeS, 1)}с`} />
            {/* Один фикс, два представления: координаты, спроецированные на
                ось маршрута, минус заявленная дистанция. Пражский фид
                противоречит сам себе до ±70 м — вот НА СКОЛЬКО прямо сейчас. */}
            <Row
              label="коорд−ось"
              value={dbg.fixCoordVsAxisM != null ? `${signed(dbg.fixCoordVsAxisM, 0)}м` : '—'}
              warn={dbg.fixCoordVsAxisM != null && Math.abs(dbg.fixCoordVsAxisM) > 50}
            />
            <Row label="наблюдаемый темп" value={`${num(dbg.observedPaceMs * 3.6, 1)} км/ч`} />
          </View>

          <View style={styles.debugCard}>
            <Text style={styles.phase} numberOfLines={2}>
              {activeNotes(dbg).join(' · ') || 'всё в норме'}
            </Text>
            <SectionTitle>ПРОФИЛИ ДВИЖЕНИЯ</SectionTitle>
            <Row label="рисуем" value={dbg.mode} />
            <Row label="smooth" value={num(dbg.smoothDistM)} />
            <Row label="fixed" value={num(dbg.fixedDistM)} />
            <Row
              label="разрыв точек"
              value={signed(dbg.deltaM, 1)}
              warn={dbg.deltaM != null && Math.abs(dbg.deltaM) > 80}
            />
            <Row label="скорость" value={`${num(dbg.simSpeedKmh, 1)} км/ч`} />
            <Row
              label="горизонт"
              value={dbg.horizonLeftS != null ? `${num(dbg.horizonLeftS, 1)}с` : '—'}
              warn={dbg.pastHorizon}
            />
            <Row label="скачок" value={`${dbg.discontinuity ? 'РАЗРЕШЁН' : 'нет'} · ${dbg.discontinuitiesTotal} всего`} />
          </View>

          <ServerCard tramKey={tramKey} clientFixAtMs={dbg.obsAtMs} />

          <View style={styles.debugCard}>
            <SectionTitle>СВЯЗЬ</SectionTitle>
            <Row
              label="состояние"
              value={CONNECTION_LABEL[dbg.connection]}
              warn={dbg.connection !== 'live'}
            />
            <Row
              label="апдейт от Convex"
              value={dbg.bundleAgeS != null ? `${num(dbg.bundleAgeS, 1)}с назад` : 'не было'}
              warn={dbg.bundleAgeS == null || dbg.bundleAgeS >= 15}
            />
            <Row label="сдвиг часов" value={`${signed(dbg.clockOffsetMs)}мс`} warn={health.clockImplausible} />
            <Row label="машин в ленте" value={num(health.vehicleCount)} />
            <Row
              label="подписка"
              value={health.consecutiveFailures > 0 ? `ошибка ×${health.consecutiveFailures}` : 'ок'}
              warn={health.consecutiveFailures > 0}
            />
          </View>

          <View style={styles.debugCard}>
            <SectionTitle>GPS РАЙДЕРА (м)</SectionTitle>
            <Row label="точка−я" value={signed(lagM)} warn={lagM != null && Math.abs(lagM) > 60} />
            <Row label="точка−фикс" value={signed(simVsObs)} />
            <Row label="я−фикс" value={signed(realVsObs)} />
            <Row label="GPS фильтр/сырой" value={`${num(realDistM)} / ${num(realRawDistM)}`} />
            <Row label="GPS-вотч" value={snap?.watchActive ? (fix ? 'живой' : 'стартует') : (snap?.watchError ?? 'выкл')} warn={!snap?.watchActive} />
            <Row label="точность" value={fix?.accuracyM != null ? `${num(fix.accuracyM)}м` : '—'} warn={fix?.accuracyM != null && fix.accuracyM > 30} />
            <Row label="до рельсов" value={`${num(proj?.fOffM, 1)} / ${num(proj?.gpsOffM, 1)}м`} />
          </View>

          <View style={styles.debugCard}>
            <SectionTitle>СЛЕДУЮЩАЯ ОСТАНОВКА</SectionTitle>
            <Row label="остановка" value={dbg.nextStopName ?? '—'} />
            <Row label="метры / прибытие" value={`${num(snap?.nextStopDistM)}м / ${dbg.nextStopEtaS != null ? `${num(dbg.nextStopEtaS)}с` : '—'}`} />
            <Row label="опоздание" value={`${signed(dbg.delaySeconds)}с`} />
            <Row label="состояние / фаза" value={`${dbg.statePosition} / ${dbg.phase}`} />
          </View>
        </>
      )}
    </ScrollView>
  );
}

/** Тело гайда: ТЕ ЖЕ секции и подписи, что в живой панели, из GUIDE_SECTIONS. */
function GuideBody() {
  return (
    <>
      {GUIDE_SECTIONS.map((section) => (
        <View key={section.title}>
          <SectionTitle>{section.title}</SectionTitle>
          {section.rows.map(([label]) => (
            <Row key={label} label={label} value="" />
          ))}
        </View>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 6,
    right: 6,
    zIndex: 1000,
  },
  panel: {
    backgroundColor: 'rgba(8,10,14,0.88)',
    borderColor: 'rgba(120,200,255,0.35)',
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  scroll: { flexShrink: 1 },
  liveDeck: { gap: 7, paddingBottom: 2 },
  debugCard: {
    backgroundColor: 'rgba(23,31,40,0.82)',
    borderColor: 'rgba(120,200,255,0.18)',
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 7,
    paddingBottom: 6,
    width: 252,
  },
  headerRow: { alignItems: 'center', flexDirection: 'row' },
  headerTap: { flex: 1, justifyContent: 'center', minHeight: 44 },
  hintTap: { alignItems: 'center', justifyContent: 'center', minHeight: 44, minWidth: 44 },
  hintActive: { color: '#FFD479' },
  guideRow: { marginBottom: 7 },
  guideLabel: { color: '#6BE6A6', fontFamily: MONO, fontSize: 10.5, fontWeight: '700' },
  guideHelp: { color: '#C6D2DE', fontFamily: MONO, fontSize: 10, lineHeight: 13.5, marginTop: 1 },
  header: { color: '#6BE6A6', flex: 1, fontFamily: MONO, fontSize: 11, fontWeight: '700' },
  legend: { flexDirection: 'row', gap: 6, marginHorizontal: 8 },
  legendText: { fontFamily: MONO, fontSize: 9, fontWeight: '800' },
  legendFix: { color: '#FF4FA3' },
  legendFixed: { color: '#B7FF4A' },
  legendSmooth: { color: '#4DDBFF' },
  legendMl: { color: '#FFD479' },
  buildNumber: {
    color: '#FFD479',
    fontFamily: MONO,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
    fontWeight: '800',
    marginRight: 2,
  },
  hint: { color: '#7FB2D9', fontFamily: MONO, fontSize: 11 },
  collapsed: { color: '#DDE6EE', fontFamily: MONO, fontSize: 10.5, marginTop: 3 },
  phase: { color: '#FFD479', fontFamily: MONO, fontSize: 11, fontWeight: '700', marginTop: 4 },
  section: {
    color: '#7FB2D9',
    fontFamily: MONO,
    fontSize: 9.5,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 1,
    marginTop: 7,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 0.5 },
  label: { color: '#9AA7B4', fontFamily: MONO, fontSize: 10.5, flexShrink: 0 },
  value: { color: '#EAF1F7', fontFamily: MONO, fontSize: 10.5, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  valueWarn: { color: '#FF8F6B' },
  notes: { color: '#EAF1F7', fontFamily: MONO, fontSize: 10.5 },
  note: { color: '#9AA7B4', fontFamily: MONO, fontSize: 10, marginTop: 4 },
});
