// Live fleet rendering: two ShapeSources fed imperatively per engine frame
// (no React state per frame), zoom-banded layers per architecture.md:
//   <13.2 dots · 13.2–14.8 badge circles + line numbers · ≥14.8 3D ModelLayer,
// plus a transparent hit-test circle across all zooms and a gold selection halo.
// Also drives the follow camera each frame (linearTo glide at TICK_MS).

import {
  Camera,
  CircleLayer,
  ModelLayer,
  Models,
  ShapeSource,
  SymbolLayer,
} from '@rnmapbox/maps';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, type RefObject } from 'react';

import { Tram } from '@/constants/theme';
import { getRuntime, TICK_MS } from '@/hooks/tramData';
import { buildFrame } from '@/lib/render/featureBuilder';
import type { Viewport } from '@/lib/types';
import { useFavoritesStore } from '@/stores/favorites';
import { useSelectionStore } from '@/stores/selection';
import { useSettingsStore } from '@/stores/settings';
import {
  BAND_BADGES_TO_MODELS,
  BAND_DOTS_TO_BADGES,
  BAND_FADE,
  MODEL_REAL_SCALE_ZOOM,
  SECTIONS_FEED_MIN_ZOOM,
} from './mapStyle';

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const EMPTY_FC_STRING = JSON.stringify(EMPTY_FC);

/** Follow-camera parameters (spec: zoom ≥16.8, pitch 60, linear glide). */
const FOLLOW_MIN_ZOOM = 16.8;
const FOLLOW_PITCH = 60;

/** Badge color: PID red, dark blue for night lines 90–99. */
const BADGE_COLOR = [
  'case',
  ['>=', ['to-number', ['get', 'line']], 90],
  Tram.night,
  Tram.pidRed,
] as const;

export interface TramLayersProps {
  cameraRef: RefObject<Camera | null>;
  viewportRef: RefObject<Viewport>;
  /** modelKey → local GLB URI; null while still downloading (gates <Models>). */
  modelUris: Record<string, string> | null;
}

export function TramLayers({ cameraRef, viewportRef, modelUris }: TramLayersProps) {
  const pointsRef = useRef<ShapeSource>(null);
  const sectionsRef = useRef<ShapeSource>(null);
  const sectionsFedRef = useRef(false);
  const favSetRef = useRef<{ source: string[]; set: Set<string> } | null>(null);

  // Per-frame push: engine states → GeoJSON → setNativeProps. Refs only.
  useEffect(() => {
    const rt = getRuntime();
    const getGeometry = (key: string) => rt.engine.getGeometry(key);

    return rt.subscribeFrame((nowMs) => {
      const viewport = viewportRef.current;
      const selection = useSelectionStore.getState();
      const favTrams = useFavoritesStore.getState().favoriteTrams;
      if (!favSetRef.current || favSetRef.current.source !== favTrams) {
        favSetRef.current = { source: favTrams, set: new Set(favTrams) };
      }

      const frame = buildFrame(rt.engine.getStates(nowMs), viewport, {
        selectedKey: selection.selectedTramKey,
        favoriteKeys: favSetRef.current.set,
        coupledPairFn: rt.coupledPairFn,
        getGeometry,
        nowMs,
      });

      pointsRef.current?.setNativeProps({
        id: 'trams-points',
        shape: JSON.stringify(frame.points),
      });

      // The sections source is fed only near/inside the model band; on leaving
      // the band it is cleared once so stale models never linger.
      if (viewport.zoom >= SECTIONS_FEED_MIN_ZOOM) {
        sectionsRef.current?.setNativeProps({
          id: 'trams-sections',
          shape: JSON.stringify(frame.sections),
        });
        sectionsFedRef.current = true;
      } else if (sectionsFedRef.current) {
        sectionsFedRef.current = false;
        sectionsRef.current?.setNativeProps({ id: 'trams-sections', shape: EMPTY_FC_STRING });
      }

      // Follow camera: retarget every frame for a continuous linear glide.
      const followKey = selection.followTramKey;
      if (followKey) {
        const state = rt.engine.getState(followKey, nowMs);
        if (state) {
          cameraRef.current?.setCamera({
            centerCoordinate: state.position,
            zoomLevel: Math.max(FOLLOW_MIN_ZOOM, viewport.zoom),
            pitch: FOLLOW_PITCH,
            heading: useSettingsStore.getState().followHeadingLock ? state.bearing : undefined,
            animationMode: 'linearTo',
            animationDuration: TICK_MS,
          });
        }
      }
    });
  }, [cameraRef, viewportRef]);

  const onPressTram = useCallback((event: { features: GeoJSON.Feature[] }) => {
    const key = event.features[0]?.properties?.key as string | undefined;
    if (!key) return;
    void Haptics.selectionAsync();
    const rt = getRuntime();
    const state = rt.engine.getState(key);
    if (state) rt.prioritizeTrip(state.snapshot.tripId);
    useSelectionStore.getState().setSelectedTramKey(key);
    // Keys are usually registration numbers but can fall back to trip ids
    // containing URL-hostile characters — encode for the route param.
    router.push(`/tram/${encodeURIComponent(key)}`);
  }, []);

  return (
    <>
      {modelUris != null && <Models models={modelUris} />}

      <ShapeSource id="trams-points" ref={pointsRef} shape={EMPTY_FC} onPress={onPressTram}>
        {/* Gold halo under the selected tram, all zooms. */}
        <CircleLayer
          id="tram-selected-halo"
          slot="top"
          filter={['==', ['get', 'selected'], 1]}
          style={{
            circleRadius: ['interpolate', ['linear'], ['zoom'], 12, 12, 16, 26],
            circleColor: Tram.gold,
            circleOpacity: 0.28,
            circleStrokeColor: Tram.gold,
            circleStrokeWidth: 2,
            circleStrokeOpacity: 0.9,
            circlePitchAlignment: 'map',
          }}
        />

        {/* Band 1 (<13.2): small PID-red dots. */}
        <CircleLayer
          id="tram-dots"
          slot="top"
          maxZoomLevel={BAND_DOTS_TO_BADGES + BAND_FADE}
          style={{
            circleRadius: ['interpolate', ['linear'], ['zoom'], 10, 3, 13.2, 5],
            circleColor: BADGE_COLOR,
            circleStrokeWidth: 1.5,
            circleStrokeColor: [
              'case',
              ['==', ['get', 'favorite'], 1],
              Tram.gold,
              '#FFFFFF',
            ],
            circleOpacity: [
              'interpolate',
              ['linear'],
              ['zoom'],
              BAND_DOTS_TO_BADGES - BAND_FADE,
              1,
              BAND_DOTS_TO_BADGES + BAND_FADE,
              0,
            ],
            circleStrokeOpacity: [
              'interpolate',
              ['linear'],
              ['zoom'],
              BAND_DOTS_TO_BADGES - BAND_FADE,
              1,
              BAND_DOTS_TO_BADGES + BAND_FADE,
              0,
            ],
          }}
        />

        {/* Band 2 (13.2–14.8): badge circle + line number. */}
        <CircleLayer
          id="tram-badges"
          slot="top"
          minZoomLevel={BAND_DOTS_TO_BADGES - BAND_FADE}
          maxZoomLevel={BAND_BADGES_TO_MODELS + BAND_FADE + 0.1}
          style={{
            circleRadius: ['interpolate', ['linear'], ['zoom'], 13.2, 9, 14.8, 12],
            circleColor: BADGE_COLOR,
            circleStrokeWidth: 2,
            circleStrokeColor: [
              'case',
              ['==', ['get', 'favorite'], 1],
              Tram.gold,
              Tram.cream,
            ],
            circleOpacity: [
              'interpolate',
              ['linear'],
              ['zoom'],
              BAND_DOTS_TO_BADGES - BAND_FADE,
              0,
              BAND_DOTS_TO_BADGES + BAND_FADE,
              1,
              BAND_BADGES_TO_MODELS,
              1,
              BAND_BADGES_TO_MODELS + BAND_FADE,
              0,
            ],
            circleStrokeOpacity: [
              'interpolate',
              ['linear'],
              ['zoom'],
              BAND_DOTS_TO_BADGES - BAND_FADE,
              0,
              BAND_DOTS_TO_BADGES + BAND_FADE,
              1,
              BAND_BADGES_TO_MODELS,
              1,
              BAND_BADGES_TO_MODELS + BAND_FADE,
              0,
            ],
          }}
        />
        <SymbolLayer
          id="tram-badge-numbers"
          slot="top"
          minZoomLevel={BAND_DOTS_TO_BADGES - BAND_FADE}
          maxZoomLevel={BAND_BADGES_TO_MODELS + BAND_FADE + 0.1}
          style={{
            textField: ['get', 'line'],
            textFont: ['DIN Pro Bold', 'Arial Unicode MS Regular'],
            textSize: ['interpolate', ['linear'], ['zoom'], 13.2, 10, 14.8, 13],
            textColor: '#FFFFFF',
            textAllowOverlap: true,
            textIgnorePlacement: true,
            textOpacity: [
              'interpolate',
              ['linear'],
              ['zoom'],
              BAND_DOTS_TO_BADGES - BAND_FADE,
              0,
              BAND_DOTS_TO_BADGES + BAND_FADE,
              1,
              BAND_BADGES_TO_MODELS,
              1,
              BAND_BADGES_TO_MODELS + BAND_FADE,
              0,
            ],
          }}
        />

        {/* Transparent hit-test target across ALL zooms (ModelLayer taps are
            unreliable — spike convention). Near-zero opacity keeps it rendered
            so native hit-testing still sees the features. */}
        <CircleLayer
          id="tram-hit-targets"
          slot="top"
          style={{
            circleRadius: 18,
            circleColor: '#000000',
            circleOpacity: 0.011,
            circleStrokeWidth: 0,
          }}
        />
      </ShapeSource>

      <ShapeSource id="trams-sections" ref={sectionsRef} shape={EMPTY_FC}>
        {/* Band 3–4 (≥14.8): articulated 3D sections. modelScale eases from a
            comically-large 2.6× down to real-world 1.0 by z16.6. */}
        {modelUris == null ? undefined : (
          <ModelLayer
            id="tram-models"
            slot="top"
            minZoomLevel={BAND_BADGES_TO_MODELS - 0.05}
            style={{
              modelId: ['get', 'modelKey'],
              // SPIKE-VERIFIED orientation: trams authored front-toward −Z, so
              // z = bearing faces the model correctly (no heading offset).
              modelRotation: [0, 0, ['get', 'bearing']] as unknown as number[],
              modelScale: [
                'interpolate',
                ['linear'],
                ['zoom'],
                BAND_BADGES_TO_MODELS,
                ['literal', [2.6, 2.6, 2.6]],
                MODEL_REAL_SCALE_ZOOM,
                ['literal', [1, 1, 1]],
              ],
              modelOpacity: [
                'interpolate',
                ['linear'],
                ['zoom'],
                BAND_BADGES_TO_MODELS,
                0,
                BAND_BADGES_TO_MODELS + BAND_FADE,
                1,
              ],
              modelEmissiveStrength: 1.2,
              modelElevationReference: 'ground',
              modelCastShadows: true,
              modelReceiveShadows: true,
              modelType: 'common-3d',
            }}
          />
        )}
      </ShapeSource>
    </>
  );
}
