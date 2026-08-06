// Live fleet rendering: ShapeSources fed directly on the native side per engine frame
// (no React state per frame), zoom-banded layers per architecture.md:
//   <13.2 direction teardrops (bearing-rotated SymbolLayer) ·
//   13.2–14.8 model FACE badges (per-model face sprite + line number) floating
//   above a map-aligned heading teardrop · ≥14.8 3D ModelLayer,
// plus transparent hit-test circles on BOTH sources (tap anywhere on a tram
// body) and a gold selection halo.
//
// Badge layout (band 2): overlapping badges pick DIFFERENT SIDES of their
// marker, never hide and never fly away on a leader line. buildFrame runs a
// variable-anchor solve over the visible band-2 trams
// (featureBuilder.declutterBadges, at the points cadence — no extra timers,
// no per-frame React): each plate takes the nearest free slot around its own
// arrow (above/below/beside/diagonals, plus a second row for pileups) and
// remembers its side push to push. The heading teardrop marker always stays
// at the TRUE position on the points source. The badges FC feeds the separate
// `trams-badges` ShapeSource here (allowOverlap — the solve already resolved
// collisions). Selected/followed/favorite trams hold the default above-slot
// as immovable obstacles and are NOT in the badges FC — they render from the
// points FC on the pinned layer, always visible, exactly at their tram, on
// top.
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
// Cadence (zoom-adaptive, thermal-aware): the engine ticks at TICK_MS (~33 ms)
// while the map is in the glide band (zoom ≥ 14, hysteresis down to 13.7 —
// aligned with the fast points cadence so 15 Hz pushes never sample 10 Hz
// motion); at far zooms the runtime drops to ~10 Hz (see
// tramData.setDetailZoom). Each tick pushes the sections
// FC (small — viewport-culled) when the band is on screen; the points FC is
// viewport-culled before state allocation at close zoom and whole-fleet only
// at the much slower city-scale cadence
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
import { DETAIL_ENTER_ZOOM, getRuntime, pointsPushIntervalMs, pointsPushWanted } from '@/hooks/tramData';
import {
  FACE_SPRITE_SCALE,
  ICON_PACKS,
  ICON_PACK_IDS,
  type IconPackId,
} from '@/lib/fleet/iconPacks';
import { MAP_ICON_ASSETS, MAP_ICON_SCALE } from '@/lib/fleet/modelSpecs';
import { bearingAt, pointAt } from '@/lib/geo/polyline';
import {
  buildFrame,
  BADGE_CULL_MARGIN_M,
  expandBbox,
  FACE_GAP_PX,
  FACE_MAX_ICON_SIZE,
  FACE_MIN_RATIO,
  FACE_TEXT_MAX_SIZE,
  FACE_TEXT_OFFSET_X_EM,
  FACE_TEXT_OFFSET_Y_EM,
  type BadgeAnchorMemory,
} from '@/lib/render/featureBuilder';
import type { PlannerItinerary, Viewport } from '@/lib/types';
import { useFavoritesStore } from '@/stores/favorites';
import { usePlannerStore } from '@/stores/planner';
import { useSelectionStore } from '@/stores/selection';
import { useSettingsStore, type PositionMode } from '@/stores/settings';
import {
  CAMERA_DWELL_EVAL_MS,
  CAMERA_DWELL_SPEED_KMH,
  CAMERA_GLIDE_MS,
  CAMERA_RETARGET_MS,
  CAMERA_RETURN_MS,
  RAW_FIX_GLIDE_MS,
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

/** The line's PID color (day red / night navy) as a style expression. */
const LINE_COLOR = ['case', NIGHT_LINE, Tram.night, Tram.pidRed] as unknown as string;

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
 *
 * The FACE_* metric constants live in featureBuilder (single source of truth)
 * because the declutter solve models each badge's screen box from the SAME
 * numbers this style renders with.
 */
// Default line-number text offsets (FACE_TEXT_OFFSET_*_EM) live in
// featureBuilder next to the other FACE_* metrics: the anchor solve emits
// data-driven offsets built from the SAME constants.

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
 * Shared face-badge style for both band-2 badge layers (the anchor-solved
 * bulk on the `trams-badges` source and the pinned selected/followed/favorite
 * layer on the points source). Overlap is ALWAYS allowed: the bulk layer's
 * plates already sit on collision-free anchor slots picked by the solve in
 * buildFrame (badges adapt, they never hide), and pinned badges must never be
 * hidden by anything.
 *
 * The BULK layer takes its icon/text offsets from the per-feature `off` /
 * `toff` props (the anchor slot, in pure screen units — pixel-exact at any
 * camera pitch); the PINNED layer renders from the points FC (no such props)
 * with the static default-slot offsets built from the same constants.
 */
function faceBadgeStyle(pack: IconPackId, dataDrivenOffsets: boolean): BadgeSymbolStyle {
  return {
    iconImage: faceIcon(pack),
    iconAnchor: 'bottom',
    iconOffset: dataDrivenOffsets
      ? (['get', 'off'] as unknown as number[])
      : [0, -FACE_GAP_PX],
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
    textColor: LINE_COLOR,
    textHaloColor: '#FFFFFF',
    textHaloWidth: 1.6,
    textAnchor: 'left',
    textOffset: dataDrivenOffsets
      ? (['get', 'toff'] as unknown as number[])
      : [FACE_TEXT_OFFSET_X_EM, FACE_TEXT_OFFSET_Y_EM],
    textOpacity: BADGE_BAND_OPACITY,
    iconAllowOverlap: true,
    iconIgnorePlacement: true,
    textAllowOverlap: true,
    textIgnorePlacement: true,
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
  const badgesRef = useRef<ShapeSource>(null);
  const fixOverlayRef = useRef<ShapeSource>(null);
  const sectionsFedRef = useRef(false);
  const pointsEmptyRef = useRef(true);
  const sectionsEmptyRef = useRef(true);
  const badgesEmptyRef = useRef(true);
  /** Push-to-push badge anchor-slot memory — keeps stacks from re-shuffling. */
  const badgeMemoryRef = useRef<BadgeAnchorMemory>(new Map());
  const fixEmptyRef = useRef(true);
  const lastPointsPushMsRef = useRef(0);
  /** Position mode of the last points push — a switch forces an immediate
   *  re-anchor push in every mode (even at the 5 s city-scale cadence). */
  const lastPushedModeRef = useRef<PositionMode | null>(null);
  /** Selection/follow keys of the last points push. Raw mode gates pushes on
   *  fix ingests, but the selected halo + pinned badge ride the points FC — a
   *  tap must not wait for the next poll to light up. */
  const lastPushedSelectionRef = useRef<{ sel: string | null; fol: string | null }>({
    sel: null,
    fol: null,
  });
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

  // Per-frame push: engine states → GeoJSON → direct native update. Refs only.
  useEffect(() => {
    const rt = getRuntime();
    const getGeometry = (key: string) => rt.engine.getGeometry(key);

    // Viewport supplier for the runtime's geometry warm-up: missing shapes of
    // ON-SCREEN trams load at raised priority so a visible tram doesn't sit as
    // a bare loading dot. Read once per POLL (not per frame) by the runtime.
    rt.setViewportProvider(() => viewportRef.current);

    const unsubscribe = rt.subscribeFrame((nowMs) => {
      const viewport = viewportRef.current;
      const selection = useSelectionStore.getState();

      // Cheap getState() read per frame — the toggle lives in a form sheet and
      // changes rarely; no subscription bookkeeping needed.
      const positionMode = useSettingsStore.getState().positionMode;

      // Zoom-adaptive push cadences (thermal): sections every tick but ONLY
      // inside the model band; points at pointsPushIntervalMs(zoom). Raw mode
      // (engine-v2.md §2.7): a raw frame changes only when a fix changes, so
      // raw pushes ride the SAME due-check gated by the runtime's ingest-set
      // dirty flag — no new timer, and identical frames are never re-pushed at
      // 15 Hz. The flag is consumed only on due frames (consuming it early
      // would swallow a fix update). A mode switch pushes immediately.
      const isRaw = positionMode === 'raw';
      // Forced pushes (bypass interval + dirty gate): a position-mode switch
      // in any mode; a selection/follow change in raw mode (the halo, pinned
      // badge and fix overlay ride the points FC — a tap must not wait ~5 s
      // for the next poll's ingest to light up).
      const lastSel = lastPushedSelectionRef.current;
      const forcePush =
        lastPushedModeRef.current !== positionMode ||
        (isRaw &&
          (lastSel.sel !== selection.selectedTramKey ||
            lastSel.fol !== selection.followTramKey));
      const pointsDue =
        forcePush ||
        nowMs - lastPointsPushMsRef.current >= pointsPushIntervalMs(viewport.zoom);
      const rawDirty = isRaw && pointsDue ? rt.takeRawFrameDirty() : false;
      const wantPoints = pointsPushWanted(
        positionMode,
        nowMs - lastPointsPushMsRef.current,
        viewport.zoom,
        rawDirty,
        forcePush,
      );
      // Raw sections are frozen between fixes too: push them on points frames
      // (fix landed / mode switch) and on band entry, never every tick.
      const inSectionsBand = viewport.zoom >= SECTIONS_FEED_MIN_ZOOM;
      const wantSections =
        inSectionsBand && (!isRaw || wantPoints || !sectionsFedRef.current);

      // On leaving the band the sections source is cleared once so stale
      // models never linger — no frame build needed for that.
      if (!inSectionsBand && sectionsFedRef.current) {
        sectionsFedRef.current = false;
        sectionsEmptyRef.current = true;
        void sectionsRef.current?.updateShape(EMPTY_FC_STRING);
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

        // Above z14 Mapbox can only reveal the viewport plus the badge prefetch
        // margin. Cull BEFORE public-state allocation/feature construction;
        // city-scale frames stay whole-fleet but run only every 1–5 seconds.
        const states =
          viewport.zoom >= DETAIL_ENTER_ZOOM
            ? rt.engine.getStatesInBounds(
                nowMs,
                expandBbox(viewport.bbox, BADGE_CULL_MARGIN_M),
                selection.selectedTramKey,
                selection.followTramKey,
                positionMode,
              )
            : rt.engine.getStates(nowMs);
        const frame = buildFrame(states, viewport, {
          selectedKey: selection.selectedTramKey,
          // The follow target gets selected:1 too — the declutter solve pins
          // it in place (never hidden, never displaced), and it keeps its
          // halo/fix overlay when follow outlives the sheet's selection.
          followedKey: selection.followTramKey,
          favoriteKeys: favSetRef.current.set,
          coupledPairFn: rt.coupledPairFn,
          getGeometry,
          lineFilter: lineFilterRef.current.set,
          skipPoints: !wantPoints,
          badgeMemory: badgeMemoryRef.current,
          positionMode,
          nowMs,
        });

        if (wantPoints) {
          lastPointsPushMsRef.current = nowMs;
          lastPushedModeRef.current = positionMode;
          lastPushedSelectionRef.current = {
            sel: selection.selectedTramKey,
            fol: selection.followTramKey,
          };
          // At close zoom the pre-allocation viewport cull can legitimately
          // produce an empty points FC (for example, a quiet block between
          // tram corridors). Re-sending that identical empty payload at 15 Hz
          // still wakes Mapbox's GeoJSON parser + Metal render loop. Push the
          // empty FC once when the last visible tram leaves, then stay silent
          // until a tram enters the viewport again.
          const pointsEmpty = frame.points.features.length === 0;
          if (!pointsEmpty || !pointsEmptyRef.current) {
            void pointsRef.current?.updateShape(
              pointsEmpty ? EMPTY_FC_STRING : JSON.stringify(frame.points),
            );
          }
          pointsEmptyRef.current = pointsEmpty;
          // Decluttered badge anchors + leaders, same cadence as the points.
          // Empty outside the badge band (stringify+push skipped while it
          // STAYS empty; the one clearing push stops stale badges — the badge
          // layers' zoom gates hide them anyway until then).
          const badgesFC = (frame.badges ?? EMPTY_FC) as GeoJSON.FeatureCollection;
          const badgesEmpty = badgesFC.features.length === 0;
          if (!badgesEmpty || !badgesEmptyRef.current) {
            void badgesRef.current?.updateShape(
              badgesEmpty ? EMPTY_FC_STRING : JSON.stringify(badgesFC),
            );
          }
          badgesEmptyRef.current = badgesEmpty;
        }

        // While the FC stays empty (no visible trams) the stringify+push is
        // skipped.
        if (wantSections) {
          const isEmpty = frame.sections.features.length === 0;
          if (!isEmpty || !sectionsEmptyRef.current) {
            void sectionsRef.current?.updateShape(
              isEmpty ? EMPTY_FC_STRING : JSON.stringify(frame.sections),
            );
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
          void fixOverlayRef.current?.updateShape(
            fixEmpty ? EMPTY_FC_STRING : JSON.stringify(fixFC),
          );
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
      // Track where the tram is RENDERED. In live mode that is the predictor
      // (the engine's estimate of the real tram now) — anchoring to the raw
      // fix left the camera parked while the tram drove away. In raw mode the
      // fix IS the rendered anchor: the camera sits on observedPosition and
      // eases across each fix jump (see the send below).
      const isLive = positionMode === 'live';
      let anchor = state.position;
      let bearing = state.bearing;
      if (isRaw) {
        anchor = state.observedPosition;
        bearing = state.observedBearing;
      } else if (isLive) {
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
        // Raw anchors only move on fix jumps — zero lead (leading a parked
        // point by a stale sim speed would aim the camera off the marker).
        center: isRaw ? anchor : leadTarget(anchor, bearing, state.simSpeedKmh),
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
        // Raw mode: between fixes the target is deadband-suppressed, so every
        // actual send IS a fix jump (~45–95 s apart, possibly hundreds of
        // meters) — glide it over RAW_FIX_GLIDE_MS instead of the 170 ms
        // steady-state overlap glide, which would read as a hard snap (§2.7).
        animationDuration: isRaw ? RAW_FIX_GLIDE_MS : CAMERA_GLIDE_MS,
      });
    });

    return () => {
      rt.setViewportProvider(null);
      unsubscribe();
    };
  }, [cameraRef, viewportRef, followGestureRef]);

  // Tap ANY tram feature (badge/dot or any 3D body section): light haptic, then
  // present the tram card. `openTram` is ONE store write that selects (gold
  // halo), engages follow and presents — no router involved, because the card is
  // an owned sheet on the map screen, not a route. The card opens on its 0.42
  // detent, which keeps the followed tram visible.
  const onPressTram = useCallback((event: { features: GeoJSON.Feature[] }) => {
    const key = event.features[0]?.properties?.key as string | undefined;
    if (!key) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const rt = getRuntime();
    const state = rt.engine.getState(key);
    if (state) rt.prioritizeTrip(state.snapshot.tripId);
    useSelectionStore.getState().openTram(key);
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
    // Geometry-less trams (shape still streaming in) render at the raw GPS
    // position across ALL zooms — including the 3D band, where the sprite
    // teardrops/badges fade out, so a shapeless tram never vanishes. No 3D
    // body and no bearing rotation (there is no reliable heading yet).
    //
    // LOOK: a "materializing" roundel, not an alarming solid red blob — a soft
    // line-colored halo + a white-filled circle with a line-colored ring + the
    // line number beside it. Reads as "a tram, still loading its route".
    // Everything is a static style expression over props the points FC already
    // carries (`line`) — zero per-frame JS, zero payload growth (perf
    // invariants #1/#5); the shared hit-target circle keeps it tappable, and
    // the viewport-priority warm-up + geometry-landed re-ingest keep the
    // transient short.
    <CircleLayer
      key="tram-geometryless-halo"
      id="tram-geometryless-halo"
      slot="top"
      filter={['==', ['get', 'geometryless'], 1]}
      style={{
        circleRadius: ['interpolate', ['linear'], ['zoom'], 10, 8, 16, 14],
        circleColor: LINE_COLOR,
        circleOpacity: 0.14,
        circleStrokeColor: LINE_COLOR,
        circleStrokeWidth: 1,
        circleStrokeOpacity: 0.3,
        circlePitchAlignment: 'map',
      }}
    />,
    <CircleLayer
      key="tram-geometryless-dots"
      id="tram-geometryless-dots"
      slot="top"
      filter={['==', ['get', 'geometryless'], 1]}
      style={{
        circleRadius: ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 7],
        circleColor: '#FFFFFF',
        circleStrokeWidth: 2,
        circleStrokeColor: LINE_COLOR,
        circlePitchAlignment: 'map',
      }}
    />,
    // Line number seated right of the roundel — the dot is identifiably "tram
    // <line>" while its shape loads. Never decluttered (it is the tram's only
    // identity in this state).
    <SymbolLayer
      key="tram-geometryless-line"
      id="tram-geometryless-line"
      slot="top"
      filter={['==', ['get', 'geometryless'], 1]}
      style={{
        textField: ['get', 'line'] as unknown as string,
        textFont: ['DIN Pro Bold', 'Arial Unicode MS Regular'],
        textSize: ['interpolate', ['linear'], ['zoom'], 10, 9, 16, 12] as unknown as number,
        textColor: LINE_COLOR,
        textHaloColor: '#FFFFFF',
        textHaloWidth: 1.4,
        textAnchor: 'left',
        textOffset: [0.9, 0],
        textAllowOverlap: true,
        textIgnorePlacement: true,
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
          // MARKER_OBSTACLE_HALF_PX models this size — change both together.
          iconSize: 0.6,
          iconOpacity: BADGE_BAND_OPACITY,
        }}
      />,
      // Band 2: PINNED face badges — selected/followed/favorite trams. Drawn
      // from the points FC (true position, never displaced by the declutter
      // solve — they are its immovable obstacles), never hidden, on top of
      // the decluttered crowd (the bulk badges live on the trams-badges
      // source below).
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
        style={faceBadgeStyle(iconPack, false)}
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
          // Top-right corner of the face plate (offset units × iconSize 0.65;
          // plate top ≈ (FACE_GAP_PX + FACE_NATURAL_PT) × iconSize 0.5 = 48 pt
          // above the marker at band top).
          iconOffset: [25, -71],
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
          circleColor: LINE_COLOR,
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

  // Badge source layers (band 2, bulk fleet). Mounted BEFORE the points
  // source, so the true-position markers, the pinned badges and the fav star
  // all draw over the crowd. Plain element array, no holes (spike rule); the
  // badge symbol layer joins only once the face sprites are registered. No
  // leader lines — the anchor solve keeps every plate hugging its own arrow.
  const badgeLayers: ReactElement[] = [];
  if (iconImages != null) {
    badgeLayers.push(
      // Band 2: the bulk-fleet face badges at the anchor slots the solve in
      // buildFrame picked (each plate on a free side of its own arrow) —
      // overlap is allowed because it no longer happens; a badge is never
      // hidden and never far from the teardrop that marks its true position.
      <SymbolLayer
        key="tram-badges"
        id="tram-badges"
        slot="top"
        minZoomLevel={BAND_DOTS_TO_BADGES - BAND_FADE}
        maxZoomLevel={BAND_BADGES_TO_MODELS + BAND_FADE + 0.1}
        style={faceBadgeStyle(iconPack, true)}
      />,
    );
  }

  return (
    <>
      {modelUris != null && <Models models={modelUris} />}
      {iconImages != null && <Images images={iconImages} />}

      {/* Every live source deliberately omits the React `shape` prop and is fed
          by the patched direct-native updateShape command. It must never use
          setNativeProps: that writes the new frame into Fabric's ShadowTree,
          where a concurrent UI commit can later replay an older frame.

          Decluttered bulk badges + leaders (band 2). Mounted first so the
          points-source layers (markers at true positions, pinned badges,
          fav stars) draw over it. Tapping a displaced badge still selects
          its tram — features carry the tram key. */}
      <ShapeSource id="trams-badges" ref={badgesRef} onPress={onPressTram}>
        {badgeLayers}
      </ShapeSource>

      <ShapeSource id="trams-points" ref={pointsRef} onPress={onPressTram}>
        {pointLayers}
      </ShapeSource>

      <ShapeSource id="trams-sections" ref={sectionsRef} onPress={onPressTram}>
        {sectionLayers}
      </ShapeSource>

      {/* Last-real-fix overlay for the selected/followed tram: dashed gold
          connector from the rendered position to the raw AVL fix + a small
          white/gold fix dot. Fed imperatively at the sections cadence; the FC
          is empty for everything but the selected tram. */}
      <ShapeSource id="tram-fix-overlay" ref={fixOverlayRef}>
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
