// Live fleet rendering: two ShapeSources fed imperatively per engine frame
// (no React state per frame), zoom-banded layers per architecture.md:
//   <13.2 dots · 13.2–14.8 badge circles + line numbers · ≥14.8 3D ModelLayer,
// plus transparent hit-test circles on BOTH sources (tap anywhere on a tram
// body) and a gold selection halo.
//
// Cadence (60 fps): the engine ticks at TICK_MS (~16 ms). Every tick pushes the
// sections FC (small — viewport-culled) and retargets the follow camera; the
// points FC (whole fleet, badges/dots) is pushed at ~15 Hz (POINTS_PUSH_MS).
// Stringify is skipped entirely while the sections FC stays empty.

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
import { useCallback, useEffect, useRef, type ReactElement, type RefObject } from 'react';

import { Tram } from '@/constants/theme';
import { getRuntime, POINTS_PUSH_MS, TICK_MS } from '@/hooks/tramData';
import { buildFrame } from '@/lib/render/featureBuilder';
import type { PlannerItinerary, Viewport } from '@/lib/types';
import { useFavoritesStore } from '@/stores/favorites';
import { usePlannerStore } from '@/stores/planner';
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

/** Follow-camera: ahead-side chase view — zoom 17.1, pitch 56. */
const FOLLOW_ZOOM = 17.1;
const FOLLOW_PITCH = 56;
/**
 * Heading offset from the tram's bearing so the camera looks at the tram from
 * ahead-and-slightly-to-the-side (only while followHeadingLock is on).
 */
const FOLLOW_HEADING_AHEAD = 160;

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
  const sectionsEmptyRef = useRef(true);
  const lastPointsPushMsRef = useRef(0);
  const favSetRef = useRef<{ source: string[]; set: Set<string> } | null>(null);
  const lineFilterRef = useRef<{
    source: PlannerItinerary | null;
    set: Set<string> | null;
  }>({ source: null, set: null });

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

      // Planner route-only mode: while an itinerary is shown, only trams on its
      // legs' lines render. The line set is cached per itinerary reference.
      const itinerary = usePlannerStore.getState().itinerary;
      if (lineFilterRef.current.source !== itinerary) {
        lineFilterRef.current = {
          source: itinerary,
          set: itinerary ? new Set(itinerary.legs.map((leg) => leg.line)) : null,
        };
      }

      // The whole-fleet points FC only changes visibly at badge/dot scale —
      // push it at ~15 Hz; sections + camera run at full tick rate.
      const wantPoints = nowMs - lastPointsPushMsRef.current >= POINTS_PUSH_MS;

      // Cheap getState() read per frame — the toggle lives in a form sheet and
      // changes rarely; no subscription bookkeeping needed.
      const positionMode = useSettingsStore.getState().positionMode;

      const frame = buildFrame(rt.engine.getStates(nowMs), viewport, {
        selectedKey: selection.selectedTramKey,
        favoriteKeys: favSetRef.current.set,
        coupledPairFn: rt.coupledPairFn,
        getGeometry,
        lineFilter: lineFilterRef.current.set,
        skipPoints: !wantPoints,
        positionMode,
        nowMs,
      });

      if (wantPoints) {
        lastPointsPushMsRef.current = nowMs;
        pointsRef.current?.setNativeProps({
          id: 'trams-points',
          shape: JSON.stringify(frame.points),
        });
      }

      // The sections source is fed only near/inside the model band; on leaving
      // the band it is cleared once so stale models never linger. While the FC
      // stays empty (no visible trams) the stringify+push is skipped.
      if (viewport.zoom >= SECTIONS_FEED_MIN_ZOOM) {
        const isEmpty = frame.sections.features.length === 0;
        if (!isEmpty || !sectionsEmptyRef.current) {
          sectionsRef.current?.setNativeProps({
            id: 'trams-sections',
            shape: isEmpty ? EMPTY_FC_STRING : JSON.stringify(frame.sections),
          });
        }
        sectionsEmptyRef.current = isEmpty;
        sectionsFedRef.current = true;
      } else if (sectionsFedRef.current) {
        sectionsFedRef.current = false;
        sectionsEmptyRef.current = true;
        sectionsRef.current?.setNativeProps({ id: 'trams-sections', shape: EMPTY_FC_STRING });
      }

      // Follow camera: retarget every frame for a continuous linear glide.
      const followKey = selection.followTramKey;
      if (followKey) {
        const state = rt.engine.getState(followKey, nowMs);
        if (state) {
          // Track where the tram is RENDERED: raw fix in live mode, sim otherwise.
          const isLive = positionMode === 'live';
          cameraRef.current?.setCamera({
            centerCoordinate: isLive ? state.observedPosition : state.position,
            zoomLevel: FOLLOW_ZOOM,
            pitch: FOLLOW_PITCH,
            // Heading lock: look at the tram from ahead-side; otherwise north-up.
            heading: useSettingsStore.getState().followHeadingLock
              ? ((isLive ? state.observedBearing : state.bearing) + FOLLOW_HEADING_AHEAD) % 360
              : 0,
            animationMode: 'linearTo',
            animationDuration: TICK_MS,
          });
        }
      }
    });
  }, [cameraRef, viewportRef]);

  // Tap ANY tram feature (badge/dot or any 3D body section): light haptic,
  // select + follow IMMEDIATELY, then open the sheet (its low detent keeps the
  // follow camera visible).
  const onPressTram = useCallback((event: { features: GeoJSON.Feature[] }) => {
    const key = event.features[0]?.properties?.key as string | undefined;
    if (!key) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const rt = getRuntime();
    const state = rt.engine.getState(key);
    if (state) rt.prioritizeTrip(state.snapshot.tripId);
    const selection = useSelectionStore.getState();
    selection.setSelectedTramKey(key);
    selection.setFollowTramKey(key);
    // Keys are usually registration numbers but can fall back to trip ids
    // containing URL-hostile characters — encode for the route param.
    router.push(`/tram/${encodeURIComponent(key)}`);
  }, []);

  // ShapeSource children must be a plain element array (no false/undefined
  // holes — rnmapbox clones each child to inject sourceID); the ModelLayer is
  // appended only once the GLBs are registered.
  const sectionLayers: ReactElement[] = [
    // Per-SECTION hit targets so a tap anywhere along a 30 m articulated body
    // (not just the head) opens/follows the tram. Active wherever the sections
    // source is fed.
    <CircleLayer
      key="tram-section-hit-targets"
      id="tram-section-hit-targets"
      slot="top"
      minZoomLevel={SECTIONS_FEED_MIN_ZOOM}
      style={{
        circleRadius: 22,
        circleColor: '#000000',
        circleOpacity: 0.011,
        circleStrokeWidth: 0,
      }}
    />,
  ];
  if (modelUris != null) {
    // Band 3–4 (≥14.8): articulated 3D sections. modelScale eases from a
    // comically-large 2.6× down to real-world 1.0 by z16.6.
    sectionLayers.push(
      <ModelLayer
        key="tram-models"
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
      />,
    );
  }

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
            circleRadius: 26,
            circleColor: '#000000',
            circleOpacity: 0.011,
            circleStrokeWidth: 0,
          }}
        />
      </ShapeSource>

      <ShapeSource id="trams-sections" ref={sectionsRef} shape={EMPTY_FC} onPress={onPressTram}>
        {sectionLayers}
      </ShapeSource>
    </>
  );
}
