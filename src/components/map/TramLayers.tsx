// Live fleet rendering: two ShapeSources fed imperatively per engine frame
// (no React state per frame), zoom-banded layers per architecture.md:
//   <13.2 direction teardrops (bearing-rotated SymbolLayer) ·
//   13.2–14.8 model FACE badges (per-model face sprite + line number) floating
//   above a map-aligned heading teardrop · ≥14.8 3D ModelLayer,
// plus transparent hit-test circles on BOTH sources (tap anywhere on a tram
// body) and a gold selection halo.
//
// Badge declutter (band 2): the badge SymbolLayer runs Mapbox's NATIVE
// collision pass (icon/text allowOverlap OFF) with a stable symbolSortKey, so
// overlapping badges hide instead of stacking unreadably — while the heading
// teardrop marker at the true position always renders, so a decluttered tram
// never loses its position dot. Selected/followed/favorite trams render on a
// separate pinned badge layer that opts out of collision entirely — they are
// NEVER hidden. All of it is style-side: zero extra JS work, zero payload
// growth, no per-frame React.
//
// Sprites (teardrops + fav star from MAP_ICON_ASSETS, one face PNG per icon
// pack × model from ICON_PACKS[..].sprites) are loaded through expo-asset
// localUri — same Fabric-safe pattern as the GLBs — and registered via
// <Images> as 'face-<pack>-<modelId>'. All icon variants are picked by style
// EXPRESSIONS over props the points FC already carried
// (line/modelId/bearing/favorite/selected), so the push payload did not grow;
// the SELECTED pack is baked into the badge iconImage expression and only
// changes on a settings-store pack change (single re-render, no per-frame
// React).
//
// Cadence (zoom-adaptive, thermal-aware): the engine ticks at TICK_MS (~16 ms)
// while the map is in the glide band (zoom ≥ 14, hysteresis down to 13.7 —
// aligned with the fast points cadence so 15 Hz pushes never sample 10 Hz
// motion); at far zooms the runtime drops to ~10 Hz (see
// tramData.setDetailZoom). Each tick pushes the sections
// FC (small — viewport-culled) when the band is on screen; the points FC
// (whole fleet, badges/dots) is pushed at a zoom-dependent cadence
// (pointsPushIntervalMs: 15 Hz close, 1 s mid, 5 s far — far-zoom badges are
// near-static and re-pushing burns GPU). The follow camera is retargeted at
// ~12.5 Hz (CAMERA_RETARGET_MS) with overlapping linear glides, and a
// stationary-target deadband keeps a dwelling tram from restarting native
// camera animations at all — see ./followCamera.ts. Stringify is skipped
// entirely while a FC stays empty, and frames that push nothing skip
// buildFrame altogether.

import {
  Camera,
  CircleLayer,
  Images,
  LineLayer,
  ModelLayer,
  Models,
  ShapeSource,
  SymbolLayer,
} from '@rnmapbox/maps';
import { Asset } from 'expo-asset';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type RefObject,
} from 'react';

import { Tram } from '@/constants/theme';
import { getRuntime, pointsPushIntervalMs } from '@/hooks/tramData';
import {
  FACE_SPRITE_SCALE,
  ICON_PACKS,
  ICON_PACK_IDS,
  type IconPackId,
} from '@/lib/fleet/iconPacks';
import { MAP_ICON_ASSETS, MAP_ICON_SCALE } from '@/lib/fleet/modelSpecs';
import { bearingAt, pointAt } from '@/lib/geo/polyline';
import { buildFrame } from '@/lib/render/featureBuilder';
import type { PlannerItinerary, Viewport } from '@/lib/types';
import { useFavoritesStore } from '@/stores/favorites';
import { usePlannerStore } from '@/stores/planner';
import { useSelectionStore } from '@/stores/selection';
import { useSettingsStore } from '@/stores/settings';
import {
  CAMERA_DWELL_EVAL_MS,
  CAMERA_DWELL_SPEED_KMH,
  CAMERA_GLIDE_MS,
  CAMERA_RETARGET_MS,
  CAMERA_RETURN_MS,
  leadTarget,
  withinDeadband,
  type FollowCameraTarget,
  type FollowOrientation,
} from './followCamera';
import {
  BAND_BADGES_TO_MODELS,
  BAND_DOTS_TO_BADGES,
  BAND_FADE,
  SECTIONS_FEED_MIN_ZOOM,
} from './mapStyle';

/**
 * Comic-scale curve: models only reach real-world 1× at this zoom (deeper than
 * the old MODEL_REAL_SCALE_ZOOM=16.6 — mid zooms stay comically oversized).
 */
const MODEL_COMIC_REAL_SCALE_ZOOM = 17.0;

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const EMPTY_FC_STRING = JSON.stringify(EMPTY_FC);

/**
 * Follow-camera FALLBACK orientation, used ONLY if the captured orientation is
 * somehow null (it never is while following — the map screen snapshots the live
 * camera on engage/return). Follow keeps the tram centered under the FIXED
 * captured zoom/pitch/heading; it does NOT auto-rotate to the tram bearing.
 */
const FOLLOW_ZOOM = 17.5;
const FOLLOW_PITCH = 60;

/**
 * Orientation channel between the map screen (which owns the camera and its
 * onCameraChanged snapshotting) and the follow-camera retarget loop here.
 * `orientation` is the FIXED zoom/pitch/heading captured when follow was
 * engaged or resumed ("Return to follow"); the loop centers the tram under it
 * without ever turning the map toward the tram's bearing. The PAUSED state
 * (user grabbed the camera) lives in the selection store (`followPaused`) so
 * the follow chips can react to it; the loop reads it there each frame.
 */
export interface FollowGestureState {
  /** Fixed camera orientation of the active follow; null when not following. */
  orientation: FollowOrientation | null;
}

// Cadence constants, target leading and the stationary-target deadband live
// in ./followCamera (pure module — see the doc comments there).

/** Night lines 90–99 use the navy sprite variants instead of PID red. */
const NIGHT_LINE = ['>=', ['to-number', ['get', 'line']], 90];

// Geometry-less trams (no loaded shape yet) are excluded from the bearing-
// rotated teardrop / capsule sprites via an inline `['!=', ['get',
// 'geometryless'], 1]` filter on each — they have no reliable heading, so they
// render as a plain un-oriented dot (tram-geometryless-dots) at all zooms.
// (Inlined per layer, not shared: rnmapbox's FilterExpression only type-checks
// as a literal in prop position, not as a widened const.)

/**
 * Direction teardrop sprite: dot-<day|night>[-fav]. Variant is derived from
 * props the points FC already carries — no extra payload on pushes.
 * (Casts follow the file's ModelLayer precedent — rnmapbox's Value<> types
 * don't model nested expressions.)
 */
const DOT_ICON = [
  'concat',
  'dot-',
  ['case', NIGHT_LINE, 'night', 'day'],
  ['case', ['==', ['get', 'favorite'], 1], '-fav', ''],
] as unknown as string;

/**
 * Model FACE badge sprite: face-<packId>-<modelId> — one recognizable
 * "mugshot" PNG per icon pack × model (ICON_PACKS[pack].sprites; every pack's
 * sprites are registered in <Images> up front). The pack half is baked into
 * the expression when the badge style is built — the selected pack is a
 * SETTING that changes rarely, so TramLayers subscribes to it via React (one
 * re-render + native style re-push per change, zero per-frame work) and the
 * per-tram half stays a style-side ['get','modelId'] with no payload growth.
 * The live line number sits beside the face as SymbolLayer text.
 */
function faceIcon(pack: IconPackId): string {
  return ['concat', `face-${pack}-`, ['get', 'modelId']] as unknown as string;
}

/**
 * Face-badge anatomy. The face sprite is 64 pt natural (192 px @ scale 3);
 * at FACE_MAX_ICON_SIZE it renders 32 pt tall at the top of the band, ramping
 * down to FACE_MIN_RATIO of that at band entry. The face floats above the
 * heading teardrop (iconAnchor bottom + FACE_GAP_PX px gap, scaled by
 * iconSize), and the line number seats to its RIGHT, vertically centered on
 * the face. textSize interpolates in lockstep with iconSize, so the constant
 * em offsets keep the number seated across the whole band's size ramp (same
 * trick as the old capsule).
 */
const FACE_NATURAL_PT = 64;
const FACE_MAX_ICON_SIZE = 0.5;
const FACE_MIN_RATIO = 0.78;
const FACE_GAP_PX = 20; // × iconSize → ≈10 pt above the marker at band top
const FACE_TEXT_MAX_SIZE = 15;
/** Line number: left-anchored 3 pt right of the face edge, centered on it. */
const FACE_TEXT_OFFSET_X_EM =
  ((FACE_NATURAL_PT * FACE_MAX_ICON_SIZE) / 2 + 3) / FACE_TEXT_MAX_SIZE;
const FACE_TEXT_OFFSET_Y_EM =
  -(FACE_GAP_PX * FACE_MAX_ICON_SIZE + (FACE_NATURAL_PT * FACE_MAX_ICON_SIZE) / 2) /
  FACE_TEXT_MAX_SIZE;

/** Shared crossfade for every band-2 (badge) layer. */
const BADGE_BAND_OPACITY = [
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
] as unknown as number;

type BadgeSymbolStyle = NonNullable<ComponentProps<typeof SymbolLayer>['style']>;

/**
 * Shared face-badge style for the two band-2 badge layers. `pinned` selects
 * the collision behaviour:
 *  - false (tram-badges, the bulk of the fleet): Mapbox's NATIVE collision
 *    pass hides badges that would overlap (icon+text placement both checked —
 *    a badge either fully shows or fully hides). symbolSortKey gives a STABLE
 *    deterministic priority (by line number) so the same badges win every
 *    placement pass — no flicker from churning priorities. The heading
 *    teardrop marker underneath ignores placement, so a hidden badge's tram
 *    keeps its position dot.
 *  - true (tram-badges-pinned: selected/followed/favorite trams): opts out of
 *    collision entirely — these are NEVER hidden — and, drawn as the later
 *    layer, renders on top of the crowd.
 * Everything is a style expression over props the points FC already carries;
 * the declutter costs zero JS work and zero push payload.
 */
function faceBadgeStyle(pinned: boolean, pack: IconPackId): BadgeSymbolStyle {
  return {
    iconImage: faceIcon(pack),
    iconAnchor: 'bottom',
    iconOffset: [0, -FACE_GAP_PX],
    iconSize: [
      'interpolate',
      ['linear'],
      ['zoom'],
      BAND_DOTS_TO_BADGES,
      FACE_MAX_ICON_SIZE * FACE_MIN_RATIO,
      BAND_BADGES_TO_MODELS,
      FACE_MAX_ICON_SIZE,
    ] as unknown as number,
    iconOpacity: BADGE_BAND_OPACITY,
    textField: ['get', 'line'] as unknown as string,
    textFont: ['DIN Pro Bold', 'Arial Unicode MS Regular'],
    textSize: [
      'interpolate',
      ['linear'],
      ['zoom'],
      BAND_DOTS_TO_BADGES,
      FACE_TEXT_MAX_SIZE * FACE_MIN_RATIO,
      BAND_BADGES_TO_MODELS,
      FACE_TEXT_MAX_SIZE,
    ] as unknown as number,
    // PID red (night navy for lines 90+) with a white halo — readable on both
    // the day and night basemap lightPresets.
    textColor: ['case', NIGHT_LINE, Tram.night, Tram.pidRed] as unknown as string,
    textHaloColor: '#FFFFFF',
    textHaloWidth: 1.6,
    textAnchor: 'left',
    textOffset: [FACE_TEXT_OFFSET_X_EM, FACE_TEXT_OFFSET_Y_EM],
    textOpacity: BADGE_BAND_OPACITY,
    iconAllowOverlap: pinned,
    iconIgnorePlacement: pinned,
    textAllowOverlap: pinned,
    textIgnorePlacement: pinned,
    ...(pinned
      ? {}
      : { symbolSortKey: ['to-number', ['get', 'line']] as unknown as number }),
  };
}

/**
 * Map icon sprites resolved through expo-asset (same Fabric-safe localUri
 * pattern as the GLBs — see useTramModels) and registered with a pixel-ratio
 * scale so iconSize works in pt-like units. Null while loading; layers that
 * need the sprites mount only once they're registered.
 *
 * Registers the teardrop/star sprites from MAP_ICON_ASSETS plus one
 * face-<packId>-<modelId> sprite per icon pack × model (ICON_PACKS[..].sprites
 * — the badge faces; 28 small PNGs). ALL packs are registered up front so
 * switching the pack setting is a pure style-expression change with no image
 * (re)loading. The legacy cap-* capsule sprites are no longer used by any
 * layer and are skipped.
 */
function useMapIcons(): Record<string, { url: string; scale: number }> | null {
  const [icons, setIcons] = useState<Record<string, { url: string; scale: number }> | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries: [string, number, number][] = [
        ...Object.entries(MAP_ICON_ASSETS)
          .filter(([key]) => !key.startsWith('cap-'))
          .map(([key, moduleId]): [string, number, number] => [key, moduleId, MAP_ICON_SCALE]),
        ...ICON_PACK_IDS.flatMap((packId) =>
          Object.entries(ICON_PACKS[packId].sprites).map(([modelId, moduleId]): [
            string,
            number,
            number,
          ] => [`face-${packId}-${modelId}`, moduleId, FACE_SPRITE_SCALE]),
        ),
      ].filter(([, moduleId]) => !!moduleId);
      const pairs = await Promise.all(
        entries.map(async ([key, moduleId, scale]) => {
          const asset = Asset.fromModule(moduleId);
          await asset.downloadAsync();
          return [key, { url: asset.localUri ?? asset.uri, scale }] as const;
        }),
      );
      if (!cancelled) setIcons(Object.fromEntries(pairs));
    })().catch((e) => {
      console.warn('[map] map icon sprites failed to load — using fallback dots', e);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return icons;
}

export interface TramLayersProps {
  cameraRef: RefObject<Camera | null>;
  viewportRef: RefObject<Viewport>;
  /** Gesture/override state for the follow camera (owned by the map screen). */
  followGestureRef: RefObject<FollowGestureState>;
  /** modelKey → local GLB URI; null while still downloading (gates <Models>). */
  modelUris: Record<string, string> | null;
}

export function TramLayers({
  cameraRef,
  viewportRef,
  followGestureRef,
  modelUris,
}: TramLayersProps) {
  const iconImages = useMapIcons();
  // Selected icon pack: a SETTING (changes rarely, from the settings sheet).
  // Subscribing via React is deliberate — one re-render per change rebuilds
  // the badge layers' iconImage expression and re-pushes the style natively.
  // NO per-frame cost: the selector only fires on actual pack changes.
  const iconPack = useSettingsStore((s) => s.iconPack);
  const pointsRef = useRef<ShapeSource>(null);
  const sectionsRef = useRef<ShapeSource>(null);
  const fixOverlayRef = useRef<ShapeSource>(null);
  const sectionsFedRef = useRef(false);
  const sectionsEmptyRef = useRef(true);
  const fixEmptyRef = useRef(true);
  const lastPointsPushMsRef = useRef(0);
  /** Next follow-camera evaluation is skipped until this timestamp. */
  const cameraEvalDueMsRef = useRef(0);
  /**
   * The last camera target actually SENT (deadband reference). Null whenever
   * the camera is not authoritatively ours — not following, or the user's
   * fingers are on the map — so the next retarget always fires.
   */
  const lastSentCameraRef = useRef<(FollowCameraTarget & { key: string }) | null>(null);
  /** True on the frame right after follow was paused — the next active frame
   *  does a gentle "Return to follow" ease instead of a snap retarget. */
  const wasPausedRef = useRef(false);
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

      // Cheap getState() read per frame — the toggle lives in a form sheet and
      // changes rarely; no subscription bookkeeping needed.
      const positionMode = useSettingsStore.getState().positionMode;

      // Zoom-adaptive push cadences (thermal): sections every tick but ONLY
      // inside the model band; points at pointsPushIntervalMs(zoom).
      const wantSections = viewport.zoom >= SECTIONS_FEED_MIN_ZOOM;
      const wantPoints =
        nowMs - lastPointsPushMsRef.current >= pointsPushIntervalMs(viewport.zoom);

      // On leaving the band the sections source is cleared once so stale
      // models never linger — no frame build needed for that.
      if (!wantSections && sectionsFedRef.current) {
        sectionsFedRef.current = false;
        sectionsEmptyRef.current = true;
        sectionsRef.current?.setNativeProps({ id: 'trams-sections', shape: EMPTY_FC_STRING });
      }

      if (wantPoints || wantSections) {
        const favTrams = useFavoritesStore.getState().favoriteTrams;
        if (!favSetRef.current || favSetRef.current.source !== favTrams) {
          favSetRef.current = { source: favTrams, set: new Set(favTrams) };
        }

        // Planner route-only mode: while an itinerary is shown, only trams on
        // its legs' lines render. The line set is cached per itinerary ref.
        const itinerary = usePlannerStore.getState().itinerary;
        if (lineFilterRef.current.source !== itinerary) {
          lineFilterRef.current = {
            source: itinerary,
            set: itinerary ? new Set(itinerary.legs.map((leg) => leg.line)) : null,
          };
        }

        const frame = buildFrame(rt.engine.getStates(nowMs), viewport, {
          selectedKey: selection.selectedTramKey,
          // The follow target gets selected:1 too — it must never be hidden
          // by the badge collision pass (and keeps its halo/fix overlay when
          // follow outlives the sheet's selection).
          followedKey: selection.followTramKey,
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

        // While the FC stays empty (no visible trams) the stringify+push is
        // skipped.
        if (wantSections) {
          const isEmpty = frame.sections.features.length === 0;
          if (!isEmpty || !sectionsEmptyRef.current) {
            sectionsRef.current?.setNativeProps({
              id: 'trams-sections',
              shape: isEmpty ? EMPTY_FC_STRING : JSON.stringify(frame.sections),
            });
          }
          sectionsEmptyRef.current = isEmpty;
          sectionsFedRef.current = true;
        }

        // Last-real-fix overlay for the selected/followed tram (dashed
        // connector + fix dot). Pushed at the sections cadence; defensive
        // `??` until the featureBuilder workstream populates fixOverlay.
        const fixFC = (frame.fixOverlay ?? EMPTY_FC) as GeoJSON.FeatureCollection;
        const fixEmpty = fixFC.features.length === 0;
        if (!fixEmpty || !fixEmptyRef.current) {
          fixOverlayRef.current?.setNativeProps({
            id: 'tram-fix-overlay',
            shape: fixEmpty ? EMPTY_FC_STRING : JSON.stringify(fixFC),
          });
        }
        fixEmptyRef.current = fixEmpty;
      }

      // Follow camera: runs ONLY while following AND not paused. Retarget every
      // CAMERA_RETARGET_MS (NOT every tick — see followCamera.ts) with a longer
      // overlapping glide; targets inside the stationary deadband are not
      // re-sent at all, so a tram dwelling at a stop lets the native map go
      // fully idle. Engine state is read fresh at each retarget. The camera
      // holds the FIXED captured orientation (zoom/pitch/heading) — it centers
      // the tram WITHOUT ever rotating the map toward the tram's bearing.
      const followKey = selection.followTramKey;
      if (!followKey) {
        lastSentCameraRef.current = null;
        wasPausedRef.current = false;
        return;
      }
      if (selection.followPaused) {
        // Follow is paused: the user grabbed the map, so the whole camera is
        // theirs. Forget the last-sent target and re-arm the eval clock so the
        // first frame after "Return to follow" acts immediately; flag the
        // resume so it eases back gently instead of snapping.
        lastSentCameraRef.current = null;
        cameraEvalDueMsRef.current = 0;
        wasPausedRef.current = true;
        return;
      }
      const lastSent = lastSentCameraRef.current;
      // A target switch (follow started / spotter hop) or a resume from pause
      // retargets immediately; otherwise hold the eval cadence.
      const resuming = wasPausedRef.current;
      if (!resuming && lastSent?.key === followKey && nowMs < cameraEvalDueMsRef.current) return;
      const state = rt.engine.getState(followKey, nowMs);
      if (!state) {
        // The followed tram disappeared (left service / pruned) — end follow.
        selection.setFollowTramKey(null);
        lastSentCameraRef.current = null;
        wasPausedRef.current = false;
        return;
      }
      // Track where the tram is RENDERED. In live mode that is the PROJECTED
      // observation (the fix dead-reckoned to now) — anchoring to the raw fix
      // left the camera parked while the tram drove away.
      const isLive = positionMode === 'live';
      let anchor = state.position;
      let bearing = state.bearing;
      if (isLive) {
        const geometry = rt.engine.getGeometry(followKey);
        const projDist = state.projectedObservedDistM;
        if (geometry && projDist != null) {
          anchor = pointAt(geometry.coordinates, geometry.cumDistM, projDist);
          bearing = bearingAt(geometry.coordinates, geometry.cumDistM, projDist);
        } else {
          anchor = state.observedPosition;
          bearing = state.observedBearing;
        }
      }
      // FIXED orientation captured on engage/return (map screen snapshots the
      // live camera). Fallbacks only fire in the impossible null case; heading
      // falls back to the tram bearing (behind-view) purely defensively.
      const orientation = followGestureRef.current?.orientation ?? null;
      const target: FollowCameraTarget = {
        // Lead slightly toward where the tram will be at the next retarget.
        center: leadTarget(anchor, bearing, state.simSpeedKmh),
        zoom: orientation?.zoom ?? FOLLOW_ZOOM,
        pitch: orientation?.pitch ?? FOLLOW_PITCH,
        heading: orientation?.heading ?? (((bearing % 360) + 360) % 360),
      };
      if (resuming) {
        // Return to follow: gently ease the center back onto the tram under the
        // user's current zoom/pitch/heading (already captured into orientation
        // by the map screen). Suppress normal retargets until the ease lands.
        wasPausedRef.current = false;
        cameraEvalDueMsRef.current = nowMs + CAMERA_RETURN_MS;
        lastSentCameraRef.current = { key: followKey, ...target };
        cameraRef.current?.setCamera({
          centerCoordinate: target.center,
          zoomLevel: target.zoom,
          pitch: target.pitch,
          heading: target.heading,
          animationMode: 'easeTo',
          animationDuration: CAMERA_RETURN_MS,
        });
        return;
      }
      // Deadband: visually identical to what the map is already showing —
      // skip the send (each one restarts a native animation). Movement, a
      // teleport or the dwell ending all exceed the deadband and send on the
      // next eval; while parked, evals relax to the dwell cadence.
      if (lastSent?.key === followKey && withinDeadband(lastSent, target)) {
        cameraEvalDueMsRef.current =
          nowMs +
          (state.simSpeedKmh < CAMERA_DWELL_SPEED_KMH ? CAMERA_DWELL_EVAL_MS : CAMERA_RETARGET_MS);
        return;
      }
      cameraEvalDueMsRef.current = nowMs + CAMERA_RETARGET_MS;
      lastSentCameraRef.current = { key: followKey, ...target };
      cameraRef.current?.setCamera({
        centerCoordinate: target.center,
        zoomLevel: target.zoom,
        pitch: target.pitch,
        heading: target.heading,
        animationMode: 'linearTo',
        animationDuration: CAMERA_GLIDE_MS,
      });
    });
  }, [cameraRef, viewportRef, followGestureRef]);

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
    // Band 3–4 (≥14.8): articulated 3D sections. modelScale follows a clearly
    // cartoonish exponential curve: 5× at band entry (mid zoom = toy trams),
    // easing to real-world 1× only at z17. Oversized models overlapping at
    // hubs is acceptable per spec ("comically oversized").
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
            ['exponential', 1.6],
            ['zoom'],
            BAND_BADGES_TO_MODELS,
            ['literal', [5, 5, 5]],
            15.6,
            ['literal', [3.2, 3.2, 3.2]],
            16.4,
            ['literal', [1.6, 1.6, 1.6]],
            MODEL_COMIC_REAL_SCALE_ZOOM,
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
          // Shadows OFF (thermal): per-model shadow passes are the biggest GPU
          // cost at pitch; ambient occlusion stays on for grounding.
          modelCastShadows: false,
          modelReceiveShadows: false,
          modelType: 'common-3d',
        }}
      />,
    );
  }

  // Points-source children: plain element array, no false/undefined holes
  // (spike rule). The sprite-driven layers are appended only once <Images>
  // has the icons registered; until then a minimal fallback dot keeps the
  // fleet visible and tappable.
  const pointLayers: ReactElement[] = [
    // Gold halo under the selected tram, all zooms.
    <CircleLayer
      key="tram-selected-halo"
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
    />,
    // Geometry-less trams (shape still streaming in): a plain dot at the raw
    // GPS position across ALL zooms — including the 3D band, where the sprite
    // teardrops/badges fade out, so a shapeless tram never vanishes. No 3D body
    // and no bearing rotation (there is no reliable heading yet); the shared
    // hit-target circle below keeps it tappable. A brief transient — Fix 2
    // requests the new trip's geometry at raised priority to shorten it.
    <CircleLayer
      key="tram-geometryless-dots"
      id="tram-geometryless-dots"
      slot="top"
      filter={['==', ['get', 'geometryless'], 1]}
      style={{
        circleRadius: ['interpolate', ['linear'], ['zoom'], 10, 3, 16, 6],
        circleColor: ['case', NIGHT_LINE, Tram.night, Tram.pidRed],
        circleStrokeWidth: 1.5,
        circleStrokeColor: '#FFFFFF',
        circlePitchAlignment: 'map',
      }}
    />,
  ];
  if (iconImages != null) {
    pointLayers.push(
      // Band 1 (<13.2): direction teardrops — the whole marker rotates to the
      // tram bearing and lies flat on the map (Flightradar-style), so heading
      // is readable at city scale.
      <SymbolLayer
        key="tram-dots"
        id="tram-dots"
        slot="top"
        // Geometry-less trams are excluded from every bearing-rotated / badge
        // sprite: they have no reliable heading and render as a plain dot
        // (tram-geometryless-dots) at all zooms instead.
        filter={['!=', ['get', 'geometryless'], 1]}
        maxZoomLevel={BAND_DOTS_TO_BADGES + BAND_FADE}
        style={{
          iconImage: DOT_ICON,
          iconRotate: ['get', 'bearing'],
          iconRotationAlignment: 'map',
          iconPitchAlignment: 'map',
          iconAllowOverlap: true,
          iconIgnorePlacement: true,
          iconSize: ['interpolate', ['linear'], ['zoom'], 10, 0.55, BAND_DOTS_TO_BADGES, 0.8],
          iconOpacity: [
            'interpolate',
            ['linear'],
            ['zoom'],
            BAND_DOTS_TO_BADGES - BAND_FADE,
            1,
            BAND_DOTS_TO_BADGES + BAND_FADE,
            0,
          ],
        }}
      />,
      // Band 2 (13.2–14.8): the tram MARKER — a map-aligned teardrop at the
      // true position, rotated to the bearing (direction stays readable while
      // the face badge floats above it, FR24-style). Ignores placement, so a
      // tram whose badge was decluttered away keeps its position dot.
      <SymbolLayer
        key="tram-badge-markers"
        id="tram-badge-markers"
        slot="top"
        filter={['!=', ['get', 'geometryless'], 1]}
        minZoomLevel={BAND_DOTS_TO_BADGES - BAND_FADE}
        maxZoomLevel={BAND_BADGES_TO_MODELS + BAND_FADE + 0.1}
        style={{
          iconImage: DOT_ICON,
          iconRotate: ['get', 'bearing'],
          iconRotationAlignment: 'map',
          iconPitchAlignment: 'map',
          iconAllowOverlap: true,
          iconIgnorePlacement: true,
          iconSize: 0.6,
          iconOpacity: BADGE_BAND_OPACITY,
        }}
      />,
      // Band 2: model FACE badge floating just above the marker — the model's
      // recognizable face sprite with the live line number seated beside it.
      // This is the DECLUTTERED layer: Mapbox's native collision pass hides
      // badges that would overlap (stable line-number sort key picks the
      // winners), while the teardrop marker above keeps every tram's position
      // visible. Selected/followed/favorite trams are excluded here — they
      // render on the pinned layer below instead.
      <SymbolLayer
        key="tram-badges"
        id="tram-badges"
        slot="top"
        filter={[
          'all',
          ['!=', ['get', 'geometryless'], 1],
          ['!=', ['get', 'selected'], 1],
          ['!=', ['get', 'favorite'], 1],
        ]}
        minZoomLevel={BAND_DOTS_TO_BADGES - BAND_FADE}
        maxZoomLevel={BAND_BADGES_TO_MODELS + BAND_FADE + 0.1}
        style={faceBadgeStyle(false, iconPack)}
      />,
      // Band 2: PINNED face badges — selected/followed/favorite trams. No
      // collision (never hidden), drawn over the decluttered crowd.
      <SymbolLayer
        key="tram-badges-pinned"
        id="tram-badges-pinned"
        slot="top"
        filter={[
          'all',
          ['!=', ['get', 'geometryless'], 1],
          ['any', ['==', ['get', 'selected'], 1], ['==', ['get', 'favorite'], 1]],
        ]}
        minZoomLevel={BAND_DOTS_TO_BADGES - BAND_FADE}
        maxZoomLevel={BAND_BADGES_TO_MODELS + BAND_FADE + 0.1}
        style={faceBadgeStyle(true, iconPack)}
      />,
      // Band 2: gold star pinned to favorite trams' face badges (top-right).
      <SymbolLayer
        key="tram-badge-fav"
        id="tram-badge-fav"
        slot="top"
        filter={['all', ['==', ['get', 'favorite'], 1], ['!=', ['get', 'geometryless'], 1]]}
        minZoomLevel={BAND_DOTS_TO_BADGES - BAND_FADE}
        maxZoomLevel={BAND_BADGES_TO_MODELS + BAND_FADE + 0.1}
        style={{
          iconImage: 'fav-star',
          iconAllowOverlap: true,
          iconIgnorePlacement: true,
          iconSize: 0.65,
          iconOffset: [25, -62],
          iconOpacity: BADGE_BAND_OPACITY,
        }}
      />,
    );
  } else {
    // Sprites still resolving (or failed): minimal legacy dot keeps every
    // tram visible + tappable across bands 1–2.
    pointLayers.push(
      <CircleLayer
        key="tram-dots-fallback"
        id="tram-dots-fallback"
        slot="top"
        filter={['!=', ['get', 'geometryless'], 1]}
        maxZoomLevel={BAND_BADGES_TO_MODELS + BAND_FADE + 0.1}
        style={{
          circleRadius: ['interpolate', ['linear'], ['zoom'], 10, 3, 14.8, 6],
          circleColor: ['case', NIGHT_LINE, Tram.night, Tram.pidRed],
          circleStrokeWidth: 1.5,
          circleStrokeColor: '#FFFFFF',
        }}
      />,
    );
  }
  pointLayers.push(
    // Transparent hit-test target across ALL zooms (ModelLayer taps are
    // unreliable — spike convention). Near-zero opacity keeps it rendered
    // so native hit-testing still sees the features.
    <CircleLayer
      key="tram-hit-targets"
      id="tram-hit-targets"
      slot="top"
      style={{
        circleRadius: 26,
        circleColor: '#000000',
        circleOpacity: 0.011,
        circleStrokeWidth: 0,
      }}
    />,
  );

  return (
    <>
      {modelUris != null && <Models models={modelUris} />}
      {iconImages != null && <Images images={iconImages} />}

      <ShapeSource id="trams-points" ref={pointsRef} shape={EMPTY_FC} onPress={onPressTram}>
        {pointLayers}
      </ShapeSource>

      <ShapeSource id="trams-sections" ref={sectionsRef} shape={EMPTY_FC} onPress={onPressTram}>
        {sectionLayers}
      </ShapeSource>

      {/* Last-real-fix overlay for the selected/followed tram: dashed gold
          connector from the rendered position to the raw AVL fix + a small
          white/gold fix dot. Fed imperatively at the sections cadence; the FC
          is empty for everything but the selected tram. */}
      <ShapeSource id="tram-fix-overlay" ref={fixOverlayRef} shape={EMPTY_FC}>
        <LineLayer
          id="tram-fix-connector"
          slot="top"
          style={{
            lineColor: Tram.gold,
            lineWidth: 2,
            lineOpacity: 0.9,
            lineDasharray: [1.5, 1.5],
            lineCap: 'round',
          }}
        />
        <CircleLayer
          id="tram-fix-dot"
          slot="top"
          filter={['==', ['geometry-type'], 'Point']}
          style={{
            circleRadius: ['interpolate', ['linear'], ['zoom'], 13, 3, 17, 4.5],
            circleColor: '#FFFFFF',
            circleStrokeColor: Tram.gold,
            circleStrokeWidth: 2,
            circleOpacity: 0.95,
            circleStrokeOpacity: 0.95,
            circlePitchAlignment: 'map',
          }}
        />
      </ShapeSource>
    </>
  );
}
