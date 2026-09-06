/** Selection inspector for physics v3. One foreground-only 1 Hz sampler owns
 * a bounded 60 s history. Map geometry remains on its imperative frame path. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Constants from 'expo-constants';
import { usePathname } from 'expo-router';
import { AppState, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Line, Polyline } from 'react-native-svg';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { SegmentedPills } from '@/components/ui/SegmentedPills';
import { getRuntime } from '@/hooks/tramData';
import { getMapSourceDeliveries, type SourceDelivery } from '@/lib/render/sourceWriter';
import { getOnlineLocator, projectOnlineFix } from '@/lib/motionlog';
import type { PhysicsDebugInfo, TramPublicState } from '@/lib/types';
import type { TrajectoryHealth } from '@/lib/physics/trajectoryStore';
import { useSelectionStore } from '@/stores/selection';
import { useServerDebug } from './serverDebug';
import { appendSample, DEBUG_SAMPLE_MS, diagnose, geometryEvidence, formatNumber as n, sampleFuture, sampledSpeed, standDuration, type FuturePoint, type MotionSample } from './diagnostics';

export const DEBUG_LIVE_INTERVAL_MS = DEBUG_SAMPLE_MS;
const COLORS = { smooth: '#4DDBFF', fixed: '#C4F27A', fix: '#FF77B7', ml: '#FFD479' };
const TABS = [{ key: 'overview', label: 'Обзор' }, { key: 'history', label: 'История' }, { key: 'server', label: 'Сервер' }, { key: 'help', label: 'Справка' }];
type Tab = 'overview' | 'history' | 'server' | 'help';
interface Snapshot {
  nowMs: number;
  dbg: PhysicsDebugInfo | undefined;
  state: TramPublicState | undefined;
  health: TrajectoryHealth;
  mapSources: Record<string, SourceDelivery>;
  mapZoom: number | null;
  future: FuturePoint[];
  fixedFuture: FuturePoint[];
  history: MotionSample[];
}
function useForeground() {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setActive(state === 'active'));
    return () => sub.remove();
  }, []);
  return active;
}
function useSnapshot(key: string | null, enabled: boolean): Snapshot | null {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const history = useRef<MotionSample[]>([]);
  useEffect(() => { history.current = []; setSnap(null); }, [key]);
  useEffect(() => {
    if (!key || !enabled) return;
    const read = () => {
      const nowMs = Date.now();
      const runtime = getRuntime();
      const dbg = runtime.fleet.getDiagnostics(key, nowMs);
      const state = runtime.fleet.getState(key, nowMs);
      const vehicle = runtime.trajectories.getVehicle(key);
      const serverNow = runtime.trajectories.nowMs(nowMs);
      const matching = state && vehicle?.tripId === state.snapshot.tripId && dbg?.hasTrajectory;
      if (!dbg?.hasGeometry) history.current = [];
      else if (state) history.current = appendSample(history.current, {
        atMs: nowMs, tripId: state.snapshot.tripId, mode: dbg.mode,
        renderedM: dbg.simDistM, speedKmh: dbg.simSpeedKmh, deltaM: dbg.deltaM,
        fixAgeS: dbg.fixAgeS, emissionAgeS: dbg.emissionAgeS,
      });
      setSnap({ nowMs, dbg, state, mapSources: getMapSourceDeliveries(), mapZoom: runtime.mapZoom, health: runtime.trajectories.health(nowMs), history: history.current,
        future: sampleFuture(matching ? vehicle.smooth : undefined, serverNow),
        fixedFuture: sampleFuture(matching ? vehicle.opinion : undefined, serverNow) });
    };
    read();
    const id = setInterval(read, DEBUG_LIVE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [key, enabled]);
  return snap;
}
function Row({ label, value, warn = false, color }: { label: string; value: string; warn?: boolean; color?: string }) {
  return <View style={styles.row}><Text style={styles.label}>{label}</Text><Text selectable style={[styles.value, color ? { color } : undefined, warn && styles.warning]}>{value}</Text></View>;
}
function Card({ title, children }: { title: string; children: ReactNode }) {
  return <View style={styles.card}><Text style={styles.section}>{title}</Text>{children}</View>;
}
function Note({ children }: { children: ReactNode }) { return <Text style={styles.note}>{children}</Text>; }
function Action({ label, onPress, selected = false }: { label: string; onPress: () => void; selected?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={styles.action}><Text style={styles.actionText}>{label}</Text></Pressable>;
}

export function DebugOverlay() {
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const followed = useSelectionStore((s) => s.followTramKey);
  const selected = useSelectionStore((s) => s.selectedTramKey);
  const key = followed ?? selected;
  const foreground = useForeground();
  const pathname = usePathname();
  const active = foreground && !pathname.startsWith('/model/');
  const [expanded, setExpanded] = useState(false);
  const [paused, setPaused] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  const [gps, setGps] = useState(false);
  useEffect(() => { setPaused(false); setGps(false); }, [key]);
  const snap = useSnapshot(key, active && !paused && tab !== 'help');
  const d = snap?.dbg;
  const future = d?.mode === 'fixed' ? snap?.fixedFuture ?? [] : snap?.future ?? [];
  const verdict = d ? diagnose(d, snap?.history ?? [], future, snap?.state) : null;
  const freshness = snap?.state?.sourceFreshness;
  const freshnessLabel = freshness === 'aging' ? 'наблюдение стареет' : freshness === 'stale' ? 'наблюдение устарело' : freshness === 'unknown' ? 'возраст неизвестен' : null;
  const maxHeight = Math.min(height * 0.48, 520);
  return <View pointerEvents="box-none" style={[styles.wrap, { top: insets.top + 5, left: width >= 700 ? undefined : 8, width: width >= 700 ? 440 : undefined, maxWidth: width >= 700 ? 440 : undefined }]}>
    <GlassPanel appearance="dark" readableOverContent style={styles.panel}>
      <Pressable style={styles.header} accessibilityRole="button" accessibilityLabel={expanded ? 'Свернуть инспектор трекинга' : 'Развернуть инспектор трекинга'} onPress={() => setExpanded(!expanded)}>
        <View style={styles.grow}>
          <Text style={styles.title}>Трекинг {snap?.state ? `· ${snap.state.snapshot.line} / ${key}` : key ? `· ${key}` : ''}</Text>
          <Text style={[styles.subtitle, verdict?.level === 'warning' && styles.warning]} numberOfLines={expanded ? 2 : 1}>{paused ? 'Снимок на паузе' : freshnessLabel ? `${freshnessLabel} · ${verdict?.title ?? ''}` : verdict?.title ?? 'Выберите трамвай на карте'}</Text>
        </View>
        <Text style={styles.speed}>{n(d?.simSpeedKmh, 1)}<Text style={styles.unit}> км/ч</Text></Text>
        <Text style={styles.chevron}>{expanded ? '⌃' : '⌄'}</Text>
      </Pressable>
      {expanded && <View style={{ maxHeight }}>
        <SegmentedPills appearance="dark" segments={TABS} selectedKey={tab} onChange={(value) => setTab(value as Tab)} />
        <View style={styles.toolbar}><Text style={styles.timestamp}>{snap ? new Date(snap.nowMs).toLocaleTimeString('ru-RU') : 'Нет снимка'} · 1 Гц · B{Constants.platform?.ios?.buildNumber ?? '?'}</Text><Action label={paused ? 'Продолжить' : 'Пауза'} selected={paused} onPress={() => setPaused(!paused)} /></View>
        <ScrollView testID="tracking-inspector-scroll" style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator nestedScrollEnabled>
          {!key && <Note>Нажмите на трамвай. Инспектор работает и без режима «Следовать».</Note>}
          {tab === 'help' && <Help />}
          {tab !== 'help' && key && !d && <Note>Ждём данные выбранного трамвая. Запись могла исчезнуть из ленты.</Note>}
          {d && snap && tab === 'overview' && <>
            <Note>{verdict?.detail}</Note>
            <Card title="Согласованность фикса и маршрута">
              <Row label="Проверка" value={geometryEvidence(d).title} warn={d.geometryCoherence === 'invalid'} />
              <Row label="GPS − указанная точка оси" value={`${n(d.geometryAxisCoordinateErrorM, 1)} м`} warn={d.geometryCoherence === 'invalid'} />
              <Note>{geometryEvidence(d).detail}</Note>
            </Card>
            <Card title="Свежесть · четыре разных возраста">
              <Row label="Свежесть наблюдения" value={freshness == null ? 'не сообщена' : {fresh:'свежее',aging:'стареет',stale:'устарело',unknown:'возраст неизвестен'}[freshness]} warn={freshness !== undefined && freshness !== 'fresh'} />
              <Row label="Достоверный возраст источника" value={`${n(snap.state?.sourceAgeS, 1)} с`} />
              <Row label="Видимость по свежести" value={snap.state?.sourceOpacity == null ? 'не сообщена' : `${n(snap.state.sourceOpacity * 100)} %`} />
              <Note>Этот коэффициент меняет только видимость. Возраст наблюдения не задаёт остановку, двери или перенос маркера.</Note>
              <Row label="Наблюдение трамвая" value={`${n(d.fixAgeS, 1)} с`} warn={d.fixAgeS > 30} />
              <Row label="Профиль этого трамвая" value={`${n(d.emissionAgeS, 1)} с`} warn={d.emissionAgeS != null && d.emissionAgeS > 60} />
              <Row label="Публикация всего флота" value={`${n(d.bundleAgeS, 1)} с`} warn={d.connection !== 'live'} />
              <Row label="Получено телефоном" value={snap.health.lastBundleAtMs > 0 ? `${n((snap.nowMs - snap.health.lastBundleAtMs) / 1000, 1)} с назад` : 'ещё не получено'} />
              <Row label="Профиль не видел новых фиксов" value={`${n(d.anchorLagS, 1)} с`} />
              <Note>Свежая лента не означает свежий профиль каждого трамвая.</Note>
            </Card>
            <Card title="Положение · метры вдоль маршрута">
              <Row label={`Расчёт отображения · ${d.mode.toUpperCase()}`} value={d.hasGeometry ? `${n(d.simDistM, 1)} м` : 'GPS · ось не применяется'} />
              <Row label="SMOOTH · сервер" value={`${n(d.smoothDistM, 1)} м`} color={COLORS.smooth} />
              <Row label="FIXED · сервер" value={`${n(d.fixedDistM, 1)} м`} color={COLORS.fixed} />
              <Row label="ФИКС · ось маршрута" value={`${n(d.obsDistM, 1)} м`} color={COLORS.fix} />
              <Row label="SMOOTH − FIXED" value={`${n(d.deltaM, 1, true)} м`} />
              <Row label="Скорость между снимками" value={`${n(sampledSpeed(snap.history), 1)} км/ч`} />
              <Row label="Неподвижен (наблюдаем)" value={`${n(standDuration(snap.history))} с`} />
              <Note>Положение и скорость — расчёт на момент снимка. Проверка доставки кадров находится во вкладке «Сервер». Цветные точки учитывают клиентские поправки. Значения «сервер» показывают исходные кривые. Разрыв не равен ошибке относительно реальности.</Note>
            </Card>
            <Card title="Дальше · опубликованный профиль">
              <FutureChart smooth={snap.future} fixed={snap.fixedFuture} />
              <Row label="Горизонт после сдвига времени" value={`${n(d.effectiveHorizonLeftS, 1)} с`} warn={d.effectiveHorizonLeftS != null && d.effectiveHorizonLeftS < 0} />
              <Row label="Горизонт исходной кривой" value={`${n(d.horizonLeftS, 1)} с`} warn={d.pastHorizon} />
              <Row label="Следующая остановка" value={d.nextStopName ?? 'неизвестна'} />
              <Row label="ETA по профилю" value={`${n(d.nextStopEtaS)} с`} />
              <Note>Это расстояние относительно текущей точки каждого серверного профиля. Будущие обновления и клиентская поправка могут изменить движение.</Note>
            </Card>
            <Card title="Как телефон меняет профиль">
              <Row label="Контракт движения" value={d.motionPolicy ?? 'не указан'} />
              <Row label="Источник" value={{ 'curve-ml': 'ML-профиль', 'curve-naive': 'Резервный профиль', 'client-naive': 'Клиентская протяжка', 'raw-fix': 'Последний фикс' }[d.renderSource]} />
              <Row label="Поправка" value={{ off: 'Не применяется', ahead: 'Кривая впереди фикса', wind: 'Сдвиг по времени', walk: 'Догоняем фикс за кривой' }[d.shimBranch]} />
              <Row label="Сдвиг по времени" value={d.tauS === Infinity ? 'За пределами кривой' : `${n(d.tauS, 1)} с`} />
              <Row label="Цель до ограничения движения" value={`${n(d.renderTargetDistM, 1)} м`} />
              <Row label="Цель − маркер" value={`${n(d.renderGuardGapM, 1, true)} м`} warn={d.renderGuardActive} />
              <Row label="Ускорение отображения" value={`${n(d.presentationAccelerationMs2, 2, true)} м/с²`} />
              <Row label="Ограничитель движения" value={d.renderGuardActive ? 'Активен' : 'Не вмешивается'} />
              <Row label="Видимость при переносе" value={snap.state?.presentationOpacity == null ? 'не сообщена' : `${n(snap.state.presentationOpacity * 100)} %`} />
              <Row label="Причина переноса" value={snap.state?.presentationTransitionReason ?? 'нет активного переноса'} />
              <Row label={snap.state?.presentationCorrectionComparable === false ? 'Расстояние переноса в мире' : 'Поправка переноса вдоль оси'} value={`${n(snap.state?.presentationCorrectionM, 1, snap.state?.presentationCorrectionComparable !== false)} м`} />
              <Row label="Поправка по фиксу" value={`${n(d.fixForwardM, 1, true)} м`} />
              <Row label="До фикса в режиме догоняния" value={`${n(d.walkRemainingM, 1)} м`} />
              <Row label="Фаза профиля / статус фида" value={`${d.phase} / ${d.statePosition}`} />
            </Card>
            <Card title="Проверка во время поездки">
              <Note>GPS телефона полезен только если вы действительно едете в выбранном трамвае. Он тоже имеет погрешность.</Note>
              <Action label={gps ? 'Выключить GPS-сравнение' : 'Я в этом трамвае · сравнить GPS'} selected={gps} onPress={() => setGps(!gps)} />
              {gps && active && !paused && key && <RiderGPS tramKey={key} nowMs={snap.nowMs} renderedM={d.simDistM} />}
            </Card>
          </>}
          {d && snap && tab === 'history' && <>
            <Card title="Последние 60 с · выбранный трамвай">
              <HistoryChart history={snap.history} />
              <Note>Голубой: скорость между снимками. Пропуски после паузы не соединяются. Это 1 Гц диагностика, не измерение частоты кадров.</Note>
              <Row label="Последний обнаруженный скачок" value={d.lastJumpM == null ? 'не наблюдался' : `${n(d.lastJumpM, 1, true)} м · ${n(d.lastJumpAgoS)} с назад`} warn={d.lastJumpAgoS != null && d.lastJumpAgoS < 60} />
              <Row label="Скрытых переносов · с запуска" value={n(d.presentationRebaseCount)} />
              <Row label="Последний перенос в мире" value={d.presentationLastWorldJumpM == null ? 'не наблюдался' : `${n(d.presentationLastWorldJumpM, 1)} м`} />
              <Row label="Время последнего переноса" value={d.presentationLastRebaseAtMs == null ? 'не наблюдалось' : new Date(d.presentationLastRebaseAtMs).toLocaleTimeString('ru-RU')} />
              <Row label="Флаг разрыва сервера" value={d.discontinuity ? 'Есть · видимый скачок запрещён' : 'Нет'} />
              <Note>Журнал начинается при открытии инспектора; отсутствие записи не доказывает отсутствие проблемы.</Note>
            </Card>
            <Card title="События · новые сверху">
              {d.events.length === 0 ? <Note>Событий пока не наблюдалось.</Note> : d.events.slice(0, 30).map((e, i) => <View key={`${e.atMs}-${i}`} style={styles.event}><Text style={styles.eventTime}>{new Date(e.atMs - d.clockOffsetMs).toLocaleTimeString('ru-RU')} · {e.kind}</Text><Text selectable style={[styles.eventText, e.warn && styles.warning]}>{e.text}</Text></View>)}
            </Card>
          </>}
          {key && d && snap && tab === 'server' && <ServerCard tramKey={key} snap={snap} paused={paused || !active} />}
        </ScrollView>
      </View>}
    </GlassPanel>
  </View>;
}

function ServerCard({ tramKey, snap, paused }: { tramKey: string; snap: Snapshot; paused: boolean }) {
  const source = snap.health.source;
  const fallback = source?.active === 'fallback';
  const result = useServerDebug(paused || fallback ? null : tramKey);
  const data = result.data;
  const d = snap.dbg!;
  return <>
    <Card title="Лента профилей · телефон">
      <Row label="Связь" value={{ live: 'Свежая публикация', degraded: 'Публикация запаздывает', offline: 'Нет свежей связи' }[d.connection]} warn={d.connection !== 'live'} />
      <Row label="Ошибка транспорта" value={snap.health.lastError ?? 'нет зарегистрированной'} warn={!!snap.health.lastError} />
      <Row label="Кривых / номер обновления" value={`${snap.health.vehicleCount} / ${d.feedSeq}`} />
      <Row label="Источник профилей" value={source ? source.active === 'primary' ? 'Основной · заданный в сборке' : 'Резервный · production' : 'не сообщён'} warn={fallback} />
      <Row label="Подключение" value={source ? source.connecting === 'primary' ? 'К основному источнику' : source.connecting === 'fallback' ? 'К production-резерву' : 'Нет ожидающего подключения' : 'не сообщено'} />
      <Row label="Адрес активного источника" value={source?.url ?? 'не сообщён'} />
      <Row label="Возврат к основному" value={source ? source.probing ? 'Проверяется' : 'Нет активной проверки' : 'не сообщён'} />
      <Row label="Причина переключения" value={source?.reason ?? 'не сообщена'} />
      <Row label="Переключений источника" value={n(source?.switches)} />
      <Row label="Генератор" value={d.serverGen ?? 'не указан'} />
      <Row label="Часы сервер − телефон" value={snap.health.clockSynced ? `${n(d.clockOffsetMs, 0, true)} мс` : 'синхронизация не завершена'} warn={snap.health.clockImplausible} />
    </Card>
    <Card title="Доставка геометрии · Mapbox">
      <Row label="Масштаб карты" value={snap.mapZoom == null ? 'не измерен' : `z${n(snap.mapZoom, 2)}`} />
      {Object.entries(snap.mapSources).length === 0 ? <Note>Нет зарегистрированных источников карты.</Note> : Object.entries(snap.mapSources).map(([name, source]) => <View key={name}>
        <Row label={name} value={`${source.submitted} отправлено · ${source.pending}+${source.queued} ждут`} warn={source.queued > 0} />
        <Row label="Подтверждено / без изменений" value={`${source.acknowledged} / ${source.unchanged}`} />
        <Row label="Последняя отправка / ответ API" value={`${source.lastSubmittedAtMs == null ? '—' : n((snap.nowMs - source.lastSubmittedAtMs) / 1000, 1)} / ${source.lastCompletedAtMs == null ? '—' : n((snap.nowMs - source.lastCompletedAtMs) / 1000, 1)} с назад`} />
        <Row label="Задержка native · последняя / максимум" value={`${n(source.lastLatencyMs)} / ${n(source.maxLatencyMs)} мс`} />
        <Row label="Заменены до отправки" value={`${source.coalesced}`} />
        <Row label="Объём строк · суммарно" value={`${n(source.payloadChars / 1024)} Ки символов`} />
        <Row label="Последняя ошибка" value={source.lastError ?? 'нет зарегистрированной'} warn={!!source.lastError} />
      </View>)}
      <Note>Счётчики за время жизни источника. Подтверждение означает выполнение native API, а не показ кадра GPU. Объём — символы JSON, не байты сети.</Note>
    </Card>
    <Card title="Диагностика сервера · отдельный запрос">
      {fallback ? <Note>Карта сейчас использует production-профили. Частный диагностический сервер относится к другому генератору и не описывает активное движение; его данные и ML-трассы скрыты.</Note> : paused ? <Note>Запросы панели приостановлены. Карта и её трассы продолжают работать.</Note> : <>
        <Row label="Ответ получен" value={result.receivedAtMs ? `${n((Date.now() - result.receivedAtMs) / 1000)} с назад` : result.loading ? 'загрузка…' : 'ответа нет'} />
        {result.error && <Note>Ошибка диагностики: {result.error}. Она не доказывает сбой ленты движения.</Note>}
        {data && !data.found && <Note>У сервера сейчас нет записи этого трамвая.</Note>}
        {data?.found && <>
          <Row label="Рейс совпадает" value={data.tripId == null ? 'не указан' : data.tripId === snap.state?.snapshot.tripId ? 'Да' : 'НЕТ · данные другого рейса'} warn={data.tripId != null && data.tripId !== snap.state?.snapshot.tripId} />
          <Row label="Источник профиля" value={data.curveSource === 'ml' ? 'ML' : data.curveSource === 'naive' ? 'Резервный' : 'не указан'} />
          <Row label="ML готов" value={data.ml?.ready == null ? 'неизвестно' : data.ml.ready ? 'Да' : 'Нет'} />
          <Row label="Пересчёт профиля" value={data.pipeline?.refreshing == null ? 'неизвестно' : data.pipeline.refreshing ? 'В работе' : 'Не выполняется'} />
          <Row label="Новый фикс ожидает пересчёта" value={data.pipeline?.pendingFix == null ? 'неизвестно' : data.pipeline.pendingFix ? 'Да' : 'Нет'} />
          <Row label="Длительность последнего ML-запроса" value={`${n(data.ml?.lastLatencyMs)} мс`} />
          <Row label="Последняя ошибка публикации" value={data.publish?.lastError ?? 'не сообщена'} />
          <Row label="Последняя ошибка ML" value={data.ml?.lastError ?? 'не сообщена'} />
          <Row label="Публикация включена" value={data.publish?.enabled == null ? 'неизвестно' : data.publish.enabled ? 'Да' : 'Нет'} />
          <Row label="Профиль синхронизирован" value={data.publish?.synced == null ? 'неизвестно' : data.publish.synced ? 'Да' : 'Нет'} />
          <Row label="Фикс телефона новее серверного" value={data.latestFix ? `${n((d.obsAtMs - data.latestFix.obsAtMs) / 1000, 1, true)} с` : 'неизвестно'} />
          <Row label="Серверное удержание на оси" value={data.latestFix?.stuckAtM == null ? 'не сообщено' : `${n(data.latestFix.stuckAtM)} м`} />
          <Note>Ответ сервера и снимок телефона получены в разные моменты. Сравнение фиксов осмысленно только для одного рейса.</Note>
        </>}
      </>}
    </Card>
  </>;
}
function RiderGPS({ tramKey, nowMs, renderedM }: { tramKey: string; nowMs: number; renderedM: number }) {
  const locator = getOnlineLocator();
  useEffect(() => { locator.retain(); return () => locator.release(); }, [locator]);
  const fix = locator.latest();
  const proj = fix ? projectOnlineFix(fix, getRuntime().fleet.getGeometry(tramKey)) : null;
  return <><Row label="GPS" value={locator.error() ?? (fix ? 'Наблюдение доступно' : 'Ожидаем разрешение / фикс')} /><Row label="Возраст GPS" value={fix ? `${n((nowMs - fix.t) / 1000, 1)} с` : '—'} warn={!!fix && nowMs - fix.t > 10000} /><Row label="Точность" value={`${n(fix?.accuracyM)} м`} /><Row label="Маркер − GPS на маршруте" value={proj ? `${n(renderedM - (proj.fDistM ?? proj.gpsDistM), 1, true)} м` : '—'} /><Note>GPS без протяжки вперёд; момент снимка {new Date(nowMs).toLocaleTimeString('ru-RU')}.</Note></>;
}
function FutureChart({ smooth, fixed }: { smooth: FuturePoint[]; fixed: FuturePoint[] }) {
  const all = [smooth, fixed].flatMap((series) => series.map((p) => p.distanceM - series[0].distanceM));
  const maxY = Math.max(10, ...all), maxX = Math.max(1, ...smooth.map((p) => p.seconds), ...fixed.map((p) => p.seconds));
  if (all.length === 0) return <Note>Доступного будущего профиля нет.</Note>;
  const points = (series: FuturePoint[]) => series.map((p) => `${8 + p.seconds / maxX * 304},${88 - (p.distanceM - series[0].distanceM) / maxY * 76}`).join(' ');
  return <><Svg width="100%" height={100} viewBox="0 0 320 100" accessible accessibilityLabel={`За ${n(maxX)} секунд профиль smooth продвигается на ${smooth.length ? n(smooth[smooth.length - 1].distanceM - smooth[0].distanceM) : 'неизвестно'} метров`}><Line x1={8} x2={312} y1={88} y2={88} stroke="#657080" /><Polyline points={points(smooth)} fill="none" stroke={COLORS.smooth} strokeWidth={2.5} /><Polyline points={points(fixed)} fill="none" stroke={COLORS.fixed} strokeWidth={2} strokeDasharray="5 3" /></Svg><View style={styles.chartLabels}><Text style={[styles.note, { color: COLORS.smooth }]}>SMOOTH</Text><Text style={[styles.note, { color: COLORS.fixed }]}>FIXED</Text><Text style={styles.note}>0–{n(maxX)} с · 0–{n(maxY)} м</Text></View></>;
}
function HistoryChart({ history }: { history: MotionSample[] }) {
  const series: { t: number; v: number; gap: boolean }[] = [];
  for (let i = 1; i < history.length; i++) {
    const a = history[i - 1], b = history[i], dt = (b.atMs - a.atMs) / 1000;
    series.push({ t: b.atMs, v: dt > 0 ? (b.renderedM - a.renderedM) / dt * 3.6 : 0, gap: dt <= 0 || dt > 2.5 });
  }
  if (series.length < 2) return <Note>Собираем историю. Первые значения появятся через 2 с.</Note>;
  const valid = series.filter((p) => !p.gap), lo = Math.min(0, ...valid.map((p) => p.v)), hi = Math.max(10, ...valid.map((p) => p.v));
  const end = history[history.length - 1].atMs;
  const lines: string[] = []; let line = '';
  for (const p of series) { if (p.gap) { if (line) lines.push(line); line = ''; } else line += `${8 + (p.t - (end - 60000)) / 60000 * 304},${88 - (p.v - lo) / (hi - lo) * 76} `; }
  if (line) lines.push(line);
  return <><Svg width="100%" height={100} viewBox="0 0 320 100" accessible accessibilityLabel={`Скорость за минуту от ${n(lo)} до ${n(hi)} километров в час`}><Line x1={8} x2={312} y1={88 - (0 - lo) / (hi - lo) * 76} y2={88 - (0 - lo) / (hi - lo) * 76} stroke="#657080" />{lines.map((points, i) => <Polyline key={i} points={points} fill="none" stroke={COLORS.smooth} strokeWidth={2} />)}</Svg><Row label="−60 с → сейчас" value={`${n(lo)}…${n(hi)} км/ч`} /></>;
}
function Help() {
  return <>
    <Card title="От наблюдения до карты"><Note>Фикс сообщает, где трамвай был в указанное время. ML прогнозирует будущие позиции. Сервер формирует два профиля: FIXED выражает прогноз, SMOOTH ограничивает резкие смены. Телефон читает профиль по исправленным часам и применяет поправку по более свежему фиксу.</Note></Card>
    <Card title="Если трамвай замер"><Note>Проверьте возраст фикса → возраст именно его профиля → оставшийся горизонт → движение на графике → поправку телефона. Линия рельсов задаёт геометрию, но не скорость. Стоянка профиля, исчерпанный горизонт и отсутствие геометрии — разные состояния.</Note></Card>
    <Card title="Если трамвай дёргается"><Note>Откройте «История». Сопоставьте скачок скорости со сменой профиля, фиксом или рейсом. Пауза фиксирует снимок панели, карта продолжает движение. Точное время и ключ трамвая позволяют найти тот же эпизод в серверных логах.</Note></Card>
    <Card title="Цвета и ограничения"><Note>Розовый — последний фикс, голубой — SMOOTH, зелёный — FIXED, жёлтый — ML-таргеты. Кольцо выделяет используемый картой режим. Прогноз и GPS не являются идеальной истиной. «—» означает отсутствие значения, а не ноль. История ограничена минутой; сбор панели — 1 Гц и только в активном приложении.</Note></Card>
  </>;
}
const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 8, right: 8, zIndex: 1000 }, panel: { borderRadius: 18, paddingHorizontal: 12, paddingBottom: 6, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 66 }, grow: { flex: 1 }, title: { color: '#FFF', fontSize: 15, fontWeight: '600' }, subtitle: { color: '#C8D1DB', fontSize: 12, marginTop: 4 }, speed: { color: '#FFF', fontSize: 21, fontWeight: '600', fontVariant: ['tabular-nums'] }, unit: { fontSize: 11 }, chevron: { color: '#C8D1DB', fontSize: 20 },
  toolbar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, timestamp: { color: '#AEB9C7', fontSize: 11, flexShrink: 1 }, action: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 }, actionText: { color: '#82C5FF', fontSize: 13, fontWeight: '600' }, scroll: { flexShrink: 1 }, content: { gap: 10, paddingBottom: 12 }, card: { backgroundColor: 'rgba(24,30,39,0.85)', borderRadius: 12, padding: 12, gap: 4 }, section: { color: '#FFF', fontSize: 14, fontWeight: '600', marginBottom: 4 }, row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 4 }, label: { color: '#B9C3CF', fontSize: 12, flex: 1 }, value: { color: '#F6F8FC', fontSize: 12, fontVariant: ['tabular-nums'], textAlign: 'right', flex: 1 }, note: { color: '#ACB8C7', fontSize: 12, lineHeight: 17 }, warning: { color: '#FFBE86' }, event: { paddingVertical: 7, gap: 3, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#3C4653' }, eventTime: { color: '#88BDEB', fontSize: 11, fontVariant: ['tabular-nums'] }, eventText: { color: '#EAF0F7', fontSize: 13, lineHeight: 18 }, chartLabels: { flexDirection: 'row', justifyContent: 'space-between', gap: 6 },
});
