// In-world physics diagnostics for one selected/followed tram — THE comparison
// mechanism (docs/research/physics-v3-protocol.md §"Two render modes": the
// harness that lets smooth be visibly beaten by fixed, or not).
//
// Three positions, always visible together:
//   FIX    magenta — the latest raw AVL coordinate received from the feed;
//   FIXED  lime    — the fixed-mode marker, including its client correction;
//   SMOOTH cyan    — the smooth-mode marker, including correction + guard.
//
// Both curves are evaluated at the SAME server-corrected instant, so the white
// dashed connector compares actual mode positions. This differs from raw
// server-curve deviationM whenever client correction/continuity is active.
//
// Histories are sampled at 10 Hz and retained for 20 seconds. They are pushed
// through ShapeSource.updateShape, never a declarative shape prop, so enabling
// devtools cannot reintroduce the Fabric frame-rewind bug it is meant to help
// diagnose.

import { CircleLayer, LineLayer, ShapeSource, SymbolLayer } from '@rnmapbox/maps';
import { usePathname } from 'expo-router';
import { useEffect, useRef, useSyncExternalStore } from 'react';

import { getRuntime } from '@/hooks/tramData';
import { SourceWriter } from '@/lib/render/sourceWriter';
import { useServerDebug, type ServerVehicleDebug } from './serverDebug';
import { haversineM, pointAt, type LngLat } from '@/lib/geo/polyline';
import { useSelectionStore } from '@/stores/selection';
import { useSettingsStore } from '@/stores/settings';

const SAMPLE_MS = 100;
const noSubscription = () => () => {};
const TRACE_MS = 20_000;
const MOVE_EPSILON_M = 0.25;

const FIX = '#FF4FA3';
/** The «fixed» (raw model opinion) curve. */
const FIXED = '#B7FF4A';
/** The «smooth» (continuity) curve. */
const SMOOTH = '#4DDBFF';
/** ML-прогноз: сырые таргет-точки, за которыми едет профиль. */
const ML_TARGET = '#FFD479';
/** Опорный фикс — наблюдение, ОТ которого посчитан ML-прогноз. */
const ML_ANCHOR = '#FFFFFF';
/** Архивные фиксы движка (где реально видели трамвай). */
const ENG_FIX = '#FF4FA3';

interface TracePoint {
  atMs: number;
  coordinate: LngLat;
}

interface TraceHistory {
  key: string | null;
  tripId: string | null;
  fixAtMs: number;
  fix: TracePoint[];
  fixed: TracePoint[];
  smooth: TracePoint[];
}

function appendTrace(trace: TracePoint[], coordinate: LngLat, nowMs: number): void {
  const last = trace[trace.length - 1];
  if (!last || haversineM(last.coordinate, coordinate) >= MOVE_EPSILON_M) {
    trace.push({ atMs: nowMs, coordinate });
  }
  const cutoff = nowMs - TRACE_MS;
  while (trace.length > 201 || (trace.length > 0 && trace[0].atMs < cutoff)) trace.shift();
}

function pointFeature(
  id: string,
  coordinate: LngLat,
  role: 'fix' | 'fixed' | 'smooth',
  label: string,
  active: boolean,
): GeoJSON.Feature<GeoJSON.Point> {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: coordinate },
    properties: { role, label, active: active ? 1 : 0 },
  };
}

function lineFeature(
  id: string,
  coordinates: LngLat[],
  role: 'fix' | 'fixed' | 'smooth' | 'delta',
): GeoJSON.Feature<GeoJSON.LineString> | null {
  if (coordinates.length < 2) return null;
  return {
    type: 'Feature',
    id,
    geometry: { type: 'LineString', coordinates },
    properties: { role },
  };
}

function makeFrame(
  history: TraceHistory,
  positions: { fix: LngLat; fixed: LngLat; smooth: LngLat },
  fixAgeS: number,
  deltaM: number | null,
  activeMode: 'smooth' | 'fixed',
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  const traces = [
    lineFeature('debug-fix-trace', history.fix.map((p) => p.coordinate), 'fix'),
    lineFeature('debug-fixed-trace', history.fixed.map((p) => p.coordinate), 'fixed'),
    lineFeature('debug-smooth-trace', history.smooth.map((p) => p.coordinate), 'smooth'),
    // The connector IS the smooth↔fixed delta, drawn to scale.
    lineFeature('debug-delta', [positions.fixed, positions.smooth], 'delta'),
  ];
  for (const trace of traces) if (trace) features.push(trace);

  // Exactly one dot is ACTIVE: the curve the map is actually drawing. The FIX
  // dot is never active — physics v3 has no render mode that shows the raw
  // fix, so marking it would claim something untrue.
  features.push(
    // «коорд» в подписи — это СЫРЫЕ координаты фикса; его представление на
    // ОСИ маршрута рисует кольцо ОПОРЫ. Разъезд между ними = противоречие
    // самого фида (строка «коорд−ось» в оверлее), не баг рендера.
    pointFeature('debug-fix', positions.fix, 'fix', `GPS · ${fixAgeS.toFixed(0)}с`, false),
    pointFeature(
      'debug-fixed',
      positions.fixed,
      'fixed',
      deltaM == null ? 'FIXED' : `FIXED · Δ${deltaM.toFixed(1)}м`,
      activeMode === 'fixed',
    ),
    pointFeature('debug-smooth', positions.smooth, 'smooth', 'SMOOTH', activeMode === 'smooth'),
  );
  return { type: 'FeatureCollection', features };
}

export function DebugMapTraces() {
  const mapVisible = !usePathname().startsWith('/model/');
  const followKey = useSelectionStore((s) => s.followTramKey);
  const selectedKey = useSelectionStore((s) => s.selectedTramKey);
  const positionMode = useSettingsStore((s) => s.positionMode);
  const key = followKey ?? selectedKey;
  const sourceRef = useRef<ShapeSource>(null);
  // ДАННЫЕ С БД для карты: сырые ML-таргеты + опорный фикс + архивные фиксы
  // движка (3 с поллинг, только пока смонтированы дебаг-трассы).
  const runtime = getRuntime();
  const sourceRole = useSyncExternalStore(mapVisible ? runtime.subscribeUi : noSubscription,
    () => mapVisible ? runtime.physicsHealth.source?.active ?? 'primary' : 'hidden');
  const { data: serverData } = useServerDebug(mapVisible && sourceRole !== 'fallback' ? key : null);
  const serverRef = useRef<ServerVehicleDebug | null>(null);
  serverRef.current = serverData;
  const historyRef = useRef<TraceHistory>({
    key: null,
    tripId: null,
    fixAtMs: 0,
    fix: [],
    fixed: [],
    smooth: [],
  });

  useEffect(() => {
    // A full-screen GL viewer owns the visible surface; retain source state,
    // but never push native map frames behind it.
    if (!mapVisible) return;
    const runtime = getRuntime();
    const writer = new SourceWriter();
    if (!key) {
      historyRef.current = { key: null, tripId: null, fixAtMs: 0, fix: [], fixed: [], smooth: [] };
      writer.send('debug-traces', sourceRef.current, JSON.stringify({ type: 'FeatureCollection', features: [] }), Date.now());
      return () => writer.dispose();
    }
    let lastSampleMs = 0;

    const push = (nowMs: number) => {
      if (nowMs - lastSampleMs < SAMPLE_MS) return;
      lastSampleMs = nowMs;
      // Read the SMOOTH state explicitly (not whichever mode is selected), so
      // both actual mode positions can be compared at the same instant.
      // These read-only getters cannot advance the live presentation guard.
      const state = runtime.fleet.getState(key, nowMs, 'smooth');
      if (!state) {
        writer.send('debug-traces', sourceRef.current, JSON.stringify({ type: 'FeatureCollection', features: [] }), nowMs);
        return;
      }
      const history = historyRef.current;
      if (history.key !== key || history.tripId !== state.snapshot.tripId) {
        history.key = key;
        history.tripId = state.snapshot.tripId;
        history.fixAtMs = 0;
        history.fix = [];
        history.fixed = [];
        history.smooth = [];
      }

      const geometry = runtime.fleet.getGeometry(key);
      const smooth: LngLat = state.position;
      const fixedState = runtime.fleet.getState(key, nowMs, 'fixed');
      const fixed: LngLat = fixedState?.position ?? state.observedPosition;
      const fix: LngLat = [state.snapshot.coordinates[0], state.snapshot.coordinates[1]];

      appendTrace(history.smooth, smooth, nowMs);
      appendTrace(history.fixed, fixed, nowMs);
      if (history.fixAtMs !== state.snapshot.observedAtMs) {
        history.fixAtMs = state.snapshot.observedAtMs;
        appendTrace(history.fix, fix, nowMs);
      } else {
        // No new observation must not leave its trail on the map forever.
        while (history.fix.length && history.fix[0].atMs < nowMs - TRACE_MS) history.fix.shift();
      }

      const frame = makeFrame(
        history,
        { fix, fixed, smooth },
        Math.max(0, runtime.trajectories.nowMs(nowMs) - state.snapshot.observedAtMs) / 1_000,
        fixedState ? state.simDistM - fixedState.simDistM : null,
        positionMode,
      );
      // A missing model is not a FIXED opinion at the raw fix. Only the raw
      // observation remains until a matching usable trajectory arrives.
      if (state.fixedDistM == null || !geometry) {
        frame.features = frame.features.filter((f) => f.properties?.role === 'fix');
      }
      // ML-слой (данные с БД): таргет-точки прогноза, опорный фикс и архивные
      // фиксы движка — визуальная оценка «насколько модель адекватна и
      // обновляется ли профиль». Рисуем только для ТЕКУЩЕГО рейса — таргеты
      // чужого trip лежали бы на чужой оси.
      const sd = runtime.trajectories.health(nowMs).source?.active === 'fallback' ? null : serverRef.current;
      const serverNowMs = runtime.trajectories.nowMs(nowMs);
      if (sd?.found && geometry && sd.tripId === state.snapshot.tripId) {
        const at = (sVal: number): LngLat =>
          pointAt(
            geometry.coordinates,
            geometry.cumDistM,
            Math.max(0, Math.min(geometry.totalM, sVal)),
          );
        const target = (sd.target ?? []).filter((p) => Number.isFinite(p.t) && Number.isFinite(p.s)).slice(0, 24);
        target.forEach((pt, i) => {
          frame.features.push({
            type: 'Feature',
            id: `debug-mltarget-${i}`,
            geometry: { type: 'Point', coordinates: at(pt.s) },
            properties: {
              role: 'mltarget',
              past: pt.t < serverNowMs ? 1 : 0,
              label:
                i === target.length - 1
                  ? `ML +${Math.max(0, Math.round((pt.t - serverNowMs) / 1000))}с`
                  : '',
            },
          });
        });
        if (sd.anchorFix) {
          const anchorPt = at(sd.anchorFix.s);
          // Опора и ФИКС — часто ОДНО наблюдение в двух представлениях
          // (ось vs координаты). Пунктир + дельта в подписи говорят это
          // явно — вместо «почему опора не там, где фикс, что за бред».
          const sameObservation =
            Math.abs(sd.anchorFix.obsAtMs - state.snapshot.observedAtMs) < 1_500;
          const deltaM = haversineM(anchorPt, fix);
          if (sameObservation && deltaM > 15) {
            frame.features.push({
              type: 'Feature',
              id: 'debug-anchor-link',
              geometry: { type: 'LineString', coordinates: [anchorPt, fix] },
              properties: { role: 'anchorlink' },
            });
          }
          frame.features.push({
            type: 'Feature',
            id: 'debug-mlanchor',
            geometry: { type: 'Point', coordinates: anchorPt },
            properties: {
              role: 'mlanchor',
              past: 0,
              label:
                `ОПОРА ${Math.round((serverNowMs - sd.anchorFix.obsAtMs) / 1000)}с` +
                (sameObservation && deltaM > 15 ? `·Δ${Math.round(deltaM)}м` : ''),
            },
          });
        }
        (sd.fixes ?? []).slice(0, 6).forEach((f, i) => {
          const sVal = f.shapeDistM ?? f.distM;
          if (sVal == null) return;
          frame.features.push({
            type: 'Feature',
            id: `debug-engfix-${i}`,
            geometry: { type: 'Point', coordinates: at(sVal) },
            properties: { role: 'engfix', past: 1, label: '' },
          });
        });
      }
      writer.send('debug-traces', sourceRef.current, JSON.stringify(frame), nowMs);
    };

    push(Date.now());
    const unsubscribe = runtime.subscribeFrame(push);
    return () => { unsubscribe(); writer.dispose(); };
  }, [key, positionMode, mapVisible]);

  return (
    <ShapeSource id="debug-traces" ref={sourceRef}>
      <LineLayer
        id="debug-trace-lines"
        slot="top"
        filter={['all', ['==', ['geometry-type'], 'LineString'], ['in', ['get', 'role'], ['literal', ['fix', 'fixed', 'smooth']]]] as never}
        style={{
          lineColor: [
            'match',
            ['get', 'role'],
            'fix', FIX,
            'fixed', FIXED,
            SMOOTH,
          ] as unknown as string,
          lineOpacity: 0.72,
          lineWidth: 3,
        }}
      />
      <LineLayer
        id="debug-position-delta"
        slot="top"
        filter={['==', ['get', 'role'], 'delta']}
        style={{
          lineColor: '#FFFFFF',
          lineDasharray: [1.2, 1.2],
          lineOpacity: 0.8,
          lineWidth: 2,
        }}
      />
      <CircleLayer
        id="debug-position-halos"
        slot="top"
        filter={['all', ['==', ['geometry-type'], 'Point'], ['in', ['get', 'role'], ['literal', ['fix', 'fixed', 'smooth']]]] as never}
        style={{
          circleColor: [
            'match',
            ['get', 'role'],
            'fix', FIX,
            'fixed', FIXED,
            SMOOTH,
          ] as unknown as string,
          circleOpacity: 0.22,
          circleRadius: ['case', ['==', ['get', 'active'], 1], 18, 13] as unknown as number,
          circleStrokeColor: [
            'match',
            ['get', 'role'],
            'fix', FIX,
            'fixed', FIXED,
            SMOOTH,
          ] as unknown as string,
          circleStrokeOpacity: 0.9,
          circleStrokeWidth: 2,
          circlePitchAlignment: 'map',
        }}
      />
      <CircleLayer
        id="debug-position-cores"
        slot="top"
        filter={['all', ['==', ['geometry-type'], 'Point'], ['in', ['get', 'role'], ['literal', ['fix', 'fixed', 'smooth']]]] as never}
        style={{
          circleColor: '#071015',
          circleRadius: ['case', ['==', ['get', 'active'], 1], 7, 5] as unknown as number,
          circleStrokeColor: [
            'match',
            ['get', 'role'],
            'fix', FIX,
            'fixed', FIXED,
            SMOOTH,
          ] as unknown as string,
          circleStrokeWidth: 3,
          circlePitchAlignment: 'map',
        }}
      />
      {/* Пунктир «одно наблюдение, два представления»: ОПОРА (ось) ↔ ФИКС
          (координаты). */}
      <LineLayer
        id="debug-anchor-link"
        slot="top"
        filter={['==', ['get', 'role'], 'anchorlink']}
        style={{
          lineColor: '#C6D2DE',
          lineDasharray: [0.8, 1.6],
          lineOpacity: 0.7,
          lineWidth: 1.5,
        }}
      />
      {/* ML-прогноз: таргет-точки (золото; прошедшие — притушены), кольцо
          опорного фикса и мелкие архивные фиксы движка. */}
      <CircleLayer
        id="debug-ml-targets"
        slot="top"
        filter={['==', ['get', 'role'], 'mltarget']}
        style={{
          circleColor: ML_TARGET,
          circleOpacity: ['case', ['==', ['get', 'past'], 1], 0.25, 0.85] as unknown as number,
          circleRadius: ['case', ['==', ['get', 'past'], 1], 3, 4.5] as unknown as number,
          circleStrokeColor: '#071015',
          circleStrokeWidth: 1,
          circlePitchAlignment: 'map',
        }}
      />
      <CircleLayer
        id="debug-ml-anchor"
        slot="top"
        filter={['==', ['get', 'role'], 'mlanchor']}
        style={{
          circleColor: 'rgba(0,0,0,0)',
          circleRadius: 10,
          circleStrokeColor: ML_ANCHOR,
          circleStrokeWidth: 2.5,
          circlePitchAlignment: 'map',
        }}
      />
      <CircleLayer
        id="debug-eng-fixes"
        slot="top"
        filter={['==', ['get', 'role'], 'engfix']}
        style={{
          circleColor: ENG_FIX,
          circleOpacity: 0.35,
          circleRadius: 2.5,
          circlePitchAlignment: 'map',
        }}
      />
      <SymbolLayer
        id="debug-position-labels"
        slot="top"
        filter={['all', ['==', ['geometry-type'], 'Point'], ['!=', ['get', 'label'], '']] as never}
        style={{
          textField: ['get', 'label'] as unknown as string,
          textFont: ['DIN Pro Bold', 'Arial Unicode MS Regular'],
          textSize: 11,
          textColor: ['match', ['get', 'role'], 'fix', FIX, 'fixed', FIXED,
            'smooth', SMOOTH, 'mltarget', ML_TARGET, '#FFFFFF'] as unknown as string,
          textHaloColor: '#071015',
          textHaloWidth: 2,
          // Offsets alone leave centered strings crossing each other. Attach
          // the text's near corner to a distinct quadrant, so labels extend
          // away from coincident markers; collision placement handles nearby
          // but noncoincident points. Exact values remain in the inspector.
          textAnchor: ['match', ['get', 'role'],
            'fix', 'bottom-right', 'fixed', 'top-right',
            'smooth', 'bottom-left', 'mlanchor', 'top-left', 'bottom-left'] as never,
          textJustify: 'auto',
          textOffset: ['match', ['get', 'role'],
            'fix', ['literal', [-1.4, -1.4]],
            'fixed', ['literal', [-1.4, 1.4]],
            'smooth', ['literal', [1.4, -1.4]],
            'mlanchor', ['literal', [1.4, 1.4]],
            ['literal', [0.8, -0.8]],
          ] as unknown as [number, number],
          textPadding: 4,
          textMaxWidth: 13,
          symbolSortKey: ['match', ['get', 'role'],
            'smooth', 0, 'fixed', 1, 'fix', 2, 'mlanchor', 3, 4] as unknown as number,
          textAllowOverlap: false,
          textIgnorePlacement: false,
        }}
      />
    </ShapeSource>
  );
}
