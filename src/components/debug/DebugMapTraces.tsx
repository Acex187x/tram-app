// In-world simulation diagnostics for one selected/followed tram.
//
// The three positions are intentionally visible at the same time:
//   FIX    magenta — latest AVL coordinate received from the feed;
//   LIVE   lime    — that fix advanced by the projection simulation;
//   SMOOTH cyan    — the main physics simulation shown in smooth mode.
//
// Histories are sampled at 10 Hz and retained for 20 seconds. They are pushed
// through ShapeSource.updateShape, never a declarative shape prop, so enabling
// devtools cannot reintroduce the Fabric frame-rewind bug it is meant to help
// diagnose.

import { CircleLayer, LineLayer, ShapeSource, SymbolLayer } from '@rnmapbox/maps';
import { useEffect, useRef } from 'react';

import { getRuntime } from '@/hooks/tramData';
import { haversineM, pointAt, type LngLat } from '@/lib/geo/polyline';
import { useSelectionStore } from '@/stores/selection';
import { useSettingsStore } from '@/stores/settings';

const SAMPLE_MS = 100;
const TRACE_MS = 20_000;
const MOVE_EPSILON_M = 0.25;

const FIX = '#FF4FA3';
const LIVE = '#B7FF4A';
const SMOOTH = '#4DDBFF';

interface TracePoint {
  atMs: number;
  coordinate: LngLat;
}

interface TraceHistory {
  key: string | null;
  fixAtMs: number;
  fix: TracePoint[];
  live: TracePoint[];
  smooth: TracePoint[];
}

function appendTrace(trace: TracePoint[], coordinate: LngLat, nowMs: number): void {
  const last = trace[trace.length - 1];
  if (!last || haversineM(last.coordinate, coordinate) >= MOVE_EPSILON_M) {
    trace.push({ atMs: nowMs, coordinate });
  }
  const cutoff = nowMs - TRACE_MS;
  while (trace.length > 0 && trace[0].atMs < cutoff) trace.shift();
}

function pointFeature(
  id: string,
  coordinate: LngLat,
  role: 'fix' | 'live' | 'smooth',
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
  role: 'fix' | 'live' | 'smooth' | 'delta',
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
  positions: { fix: LngLat; live: LngLat; smooth: LngLat },
  fixAgeS: number,
  activeMode: 'smooth' | 'live' | 'raw' | 'ml',
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  const traces = [
    lineFeature('debug-fix-trace', history.fix.map((p) => p.coordinate), 'fix'),
    lineFeature('debug-live-trace', history.live.map((p) => p.coordinate), 'live'),
    lineFeature('debug-smooth-trace', history.smooth.map((p) => p.coordinate), 'smooth'),
    lineFeature('debug-delta', [positions.live, positions.smooth], 'delta'),
  ];
  for (const trace of traces) if (trace) features.push(trace);

  features.push(
    // The FIX dot is the ACTIVE marker in raw position mode — raw renders the
    // last reported AVL coordinate itself (engine-v2.md §2.7). In the
    // experimental 'ml' mode NO dot is marked active on purpose: the map's
    // marker is then the lab's trajectory position, which is none of these
    // three engine layers, and claiming one of them would be a lie.
    pointFeature(
      'debug-fix',
      positions.fix,
      'fix',
      `FIX · ${fixAgeS.toFixed(1)}s`,
      activeMode === 'raw',
    ),
    pointFeature('debug-live', positions.live, 'live', 'LIVE', activeMode === 'live'),
    pointFeature('debug-smooth', positions.smooth, 'smooth', 'SMOOTH', activeMode === 'smooth'),
  );
  return { type: 'FeatureCollection', features };
}

export function DebugMapTraces() {
  const followKey = useSelectionStore((s) => s.followTramKey);
  const selectedKey = useSelectionStore((s) => s.selectedTramKey);
  const positionMode = useSettingsStore((s) => s.positionMode);
  const key = followKey ?? selectedKey;
  const sourceRef = useRef<ShapeSource>(null);
  const historyRef = useRef<TraceHistory>({
    key: null,
    fixAtMs: 0,
    fix: [],
    live: [],
    smooth: [],
  });

  useEffect(() => {
    const runtime = getRuntime();
    if (!key) {
      historyRef.current = { key: null, fixAtMs: 0, fix: [], live: [], smooth: [] };
      void sourceRef.current?.updateShape({ type: 'FeatureCollection', features: [] });
      return;
    }
    let lastSampleMs = 0;

    const push = (nowMs: number) => {
      if (nowMs - lastSampleMs < SAMPLE_MS) return;
      lastSampleMs = nowMs;
      const state = runtime.engine.getState(key, nowMs);
      if (!state) return;
      const history = historyRef.current;
      if (history.key !== key) {
        history.key = key;
        history.fixAtMs = 0;
        history.fix = [];
        history.live = [];
        history.smooth = [];
      }

      const geometry = runtime.engine.getGeometry(key);
      const smooth: LngLat = state.position;
      let live: LngLat = state.observedPosition;
      if (geometry && state.projectedObservedDistM != null) {
        live = pointAt(
          geometry.coordinates,
          geometry.cumDistM,
          state.projectedObservedDistM,
        );
      }
      const fix: LngLat = [state.snapshot.coordinates[0], state.snapshot.coordinates[1]];

      appendTrace(history.smooth, smooth, nowMs);
      appendTrace(history.live, live, nowMs);
      if (history.fixAtMs !== state.snapshot.observedAtMs) {
        history.fixAtMs = state.snapshot.observedAtMs;
        appendTrace(history.fix, fix, nowMs);
      }

      const frame = makeFrame(
        history,
        { fix, live, smooth },
        Math.max(0, nowMs - state.snapshot.observedAtMs) / 1_000,
        positionMode,
      );
      void sourceRef.current?.updateShape(frame);
    };

    push(Date.now());
    return runtime.subscribeFrame(push);
  }, [key, positionMode]);

  return (
    <ShapeSource id="debug-traces" ref={sourceRef}>
      <LineLayer
        id="debug-trace-lines"
        slot="top"
        filter={['!=', ['get', 'role'], 'delta']}
        style={{
          lineColor: [
            'match',
            ['get', 'role'],
            'fix', FIX,
            'live', LIVE,
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
        filter={['==', ['geometry-type'], 'Point']}
        style={{
          circleColor: [
            'match',
            ['get', 'role'],
            'fix', FIX,
            'live', LIVE,
            SMOOTH,
          ] as unknown as string,
          circleOpacity: 0.22,
          circleRadius: ['case', ['==', ['get', 'active'], 1], 18, 13] as unknown as number,
          circleStrokeColor: [
            'match',
            ['get', 'role'],
            'fix', FIX,
            'live', LIVE,
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
        filter={['==', ['geometry-type'], 'Point']}
        style={{
          circleColor: '#071015',
          circleRadius: ['case', ['==', ['get', 'active'], 1], 7, 5] as unknown as number,
          circleStrokeColor: [
            'match',
            ['get', 'role'],
            'fix', FIX,
            'live', LIVE,
            SMOOTH,
          ] as unknown as string,
          circleStrokeWidth: 3,
          circlePitchAlignment: 'map',
        }}
      />
      <SymbolLayer
        id="debug-position-labels"
        slot="top"
        filter={['==', ['geometry-type'], 'Point']}
        style={{
          textField: ['get', 'label'] as unknown as string,
          textFont: ['DIN Pro Bold', 'Arial Unicode MS Regular'],
          textSize: 11,
          textColor: '#FFFFFF',
          textHaloColor: '#071015',
          textHaloWidth: 2,
          textOffset: [0, -2.1],
          textAllowOverlap: true,
          textIgnorePlacement: true,
        }}
      />
    </ShapeSource>
  );
}
