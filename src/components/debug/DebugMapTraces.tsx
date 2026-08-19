// In-world physics diagnostics for one selected/followed tram — THE comparison
// mechanism (docs/research/physics-v3-protocol.md §"Two render modes": the
// harness that lets smooth be visibly beaten by fixed, or not).
//
// Three positions, always visible together:
//   FIX    magenta — the latest raw AVL coordinate received from the feed;
//   FIXED  lime    — the server's raw model OPINION curve («более точное
//                    положение») evaluated now;
//   SMOOTH cyan    — the server's continuity curve evaluated now.
//
// Both curves are evaluated at the SAME server-corrected instant, so the white
// dashed connector between them is exactly `deviationM` — the number the tram
// sheet and the debug overlay report, drawn to scale on the map.
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
/** The «fixed» (raw model opinion) curve. */
const FIXED = '#B7FF4A';
/** The «smooth» (continuity) curve. */
const SMOOTH = '#4DDBFF';

interface TracePoint {
  atMs: number;
  coordinate: LngLat;
}

interface TraceHistory {
  key: string | null;
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
  while (trace.length > 0 && trace[0].atMs < cutoff) trace.shift();
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
    pointFeature('debug-fix', positions.fix, 'fix', `FIX · ${fixAgeS.toFixed(1)}s`, false),
    pointFeature(
      'debug-fixed',
      positions.fixed,
      'fixed',
      deltaM == null ? 'FIXED' : `FIXED · ${deltaM.toFixed(1)}m`,
      activeMode === 'fixed',
    ),
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
    fixed: [],
    smooth: [],
  });

  useEffect(() => {
    const runtime = getRuntime();
    if (!key) {
      historyRef.current = { key: null, fixAtMs: 0, fix: [], fixed: [], smooth: [] };
      void sourceRef.current?.updateShape({ type: 'FeatureCollection', features: [] });
      return;
    }
    let lastSampleMs = 0;

    const push = (nowMs: number) => {
      if (nowMs - lastSampleMs < SAMPLE_MS) return;
      lastSampleMs = nowMs;
      // Read the SMOOTH state explicitly (not whichever mode is selected), so
      // both curves are always sampled and the comparison never depends on the
      // user's current setting: simDistM is then the smooth curve AS DRAWN
      // (fix-forward included) and fixedDistM its raw opinion partner at the
      // same instant. The gap between the smooth trace and the fix trace is
      // therefore the shim doing its job, not an error.
      const state = runtime.fleet.getState(key, nowMs, 'smooth');
      if (!state) return;
      const history = historyRef.current;
      if (history.key !== key) {
        history.key = key;
        history.fixAtMs = 0;
        history.fix = [];
        history.fixed = [];
        history.smooth = [];
      }

      const geometry = runtime.fleet.getGeometry(key);
      const smooth: LngLat = state.position;
      const fixed: LngLat =
        geometry && state.fixedDistM != null
          ? pointAt(geometry.coordinates, geometry.cumDistM, state.fixedDistM)
          : state.observedPosition;
      const fix: LngLat = [state.snapshot.coordinates[0], state.snapshot.coordinates[1]];

      appendTrace(history.smooth, smooth, nowMs);
      appendTrace(history.fixed, fixed, nowMs);
      if (history.fixAtMs !== state.snapshot.observedAtMs) {
        history.fixAtMs = state.snapshot.observedAtMs;
        appendTrace(history.fix, fix, nowMs);
      }

      const frame = makeFrame(
        history,
        { fix, fixed, smooth },
        Math.max(0, nowMs - state.snapshot.observedAtMs) / 1_000,
        state.deviationM,
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
        filter={['==', ['geometry-type'], 'Point']}
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
        filter={['==', ['geometry-type'], 'Point']}
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
