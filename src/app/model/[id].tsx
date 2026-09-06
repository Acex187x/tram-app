import { skinAssetUri, useSkinsStore } from '@/stores/skins';
import type { SkinRecord } from '@/lib/skins/registry';
import { registerEmbeddedTextures } from '@/components/model/embeddedTextures';
// Full-screen interactive 3D tram viewer (fullScreenModal, registered in
// _layout as model/[id]). Renders ALL body sections of MODEL_SPECS[id] with
// expo-gl + three.js, laid nose-to-tail like a real consist (front = −Z, same
// convention as scripts/render-model.mjs). Orbit with a pan gesture, pinch to
// dolly. Stationary scenes perform no rendering work. Written defensively: every GL/GLB
// step is guarded — failures land in a friendly error state, never a crash.
import { Asset } from 'expo-asset';
import { isDevice } from 'expo-device';
import { GLView, type ExpoWebGLRenderingContext } from 'expo-gl';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  AppState,
  Button,
  PixelRatio,
  Switch,
  StyleSheet,
  Text,
  useColorScheme,
  View,
  type AccessibilityActionEvent,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import {
  fitRadius,
  fitCabRadius,
  INITIAL_AZIMUTH_DEG,
  INITIAL_ELEVATION_DEG,
  layoutSections,
  normalizeAzimuthDeg,
  orbitToPosition,
  panOrbit,
  pinchOrbit,
  viewerBackgroundColor,
  ZOOM_MAX_FACTOR,
  ZOOM_MIN_FACTOR,
  type OrbitState,
} from '@/components/model/orbitMath';
import { CircleControl } from '@/components/maps-kit/CircleControl';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { Colors, TextScale } from '@/constants/theme';
import { MODEL_SPECS } from '@/lib/fleet/modelSpecs';
import { modelClipPlanes } from '@/components/model/clipPlanes';
import { useSimulatorMaterials } from '@/components/model/simulatorMaterials';
import { createDemandRenderer, nextMechanismFrame } from '@/components/model/demandRenderer';
import { createModelRenderSurface } from '@/components/model/renderSurface';
import { VIEWER_MODEL_ASSETS } from '@/components/model/viewerAssets';
import { SegmentedPills } from '@/components/ui/SegmentedPills';
import {
  bindMechanisms,
  applyMechanisms,
  type ModelMechanisms,
} from '@/components/model/mechanisms';
import {
  CLOSED_DOORS,
  changeDoorTarget,
  doorProgress,
  type IndicatorDirection,
} from '@/components/model/mechanismMath';
import type { TramModelId, TramModelSpec } from '@/lib/types';

// React Native defines `navigator` without `userAgent`; GLTFLoader (r162)
// sniffs `navigator.userAgent.indexOf('Firefox')` and crashes on undefined.
const nav = globalThis.navigator as { userAgent?: string } | undefined;
if (nav && typeof nav.userAgent !== 'string') {
  try {
    Object.defineProperty(nav, 'userAgent', {
      value: 'ReactNative ExpoGL',
      configurable: true,
    });
  } catch {
    // non-configurable navigator: GLTFLoader will fail loudly instead
  }
}

const CAMERA_FOV_DEG = 40;
/** Bound explicit gestures and door animation to 30 fps, including ProMotion. */
const DEVICE_FRAME_MS = 33;
const SIMULATOR_FRAME_MS = 83;
const SIMULATOR_RENDER_MAX_EDGE = 640;

/** VoiceOver intercepts pan/pinch, so orbiting is also offered as actions. */
const ROTATE_ACTIONS = [
  { name: 'increment', label: 'Rotate right' },
  { name: 'decrement', label: 'Rotate left' },
];
const ROTATE_ACTION_DEG = 30;

const INITIAL_ORBIT: OrbitState = {
  azimuthDeg: INITIAL_AZIMUTH_DEG,
  elevationDeg: INITIAL_ELEVATION_DEG,
  radiusM: 40,
};

// ── three.js glue (kept out of orbitMath so that module stays jest-pure) ─────

/** Everything the render loop needs, owned by onContextCreate. */
interface GlSession {
  gl: ExpoWebGLRenderingContext;
  renderer: THREE.WebGLRenderer;
  renderSurface: ReturnType<typeof createModelRenderSurface>;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  background: THREE.Color;
  target: THREE.Vector3;
  scheduler: ReturnType<typeof createDemandRenderer>;
  disposed: boolean;
  mechanisms: ModelMechanisms;
  bounds: THREE.Box3;
  overviewRadius: number;
  overviewTarget: THREE.Vector3;
  /** Drawing-buffer size the renderer/camera are currently fitted to. */
  bufW: number;
  bufH: number;
}

/**
 * three r16x expects a canvas-shaped object even when given a raw context
 * (it wires up context-loss listeners and reads dimensions from it).
 */
function makeFakeCanvas(gl: ExpoWebGLRenderingContext): HTMLCanvasElement {
  return {
    width: gl.drawingBufferWidth,
    height: gl.drawingBufferHeight,
    clientWidth: gl.drawingBufferWidth,
    clientHeight: gl.drawingBufferHeight,
    style: {},
    addEventListener: () => {},
    removeEventListener: () => {},
    getContext: () => gl,
  } as unknown as HTMLCanvasElement;
}

/** Lighting copied from scripts/render-model.mjs (renderThumb) for consistency. */
function addLights(scene: THREE.Scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8088a0, 1.15));
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.1);
  sun.position.set(28, 46, 30);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xdde8ff, 0.75);
  fill.position.set(-26, 18, -22);
  scene.add(fill);
}

/** Load + parse every section GLB of a spec. Throws if none can be loaded. */
async function loadSections(spec: TramModelSpec, skin?: SkinRecord): Promise<THREE.Group[]> {
  const loader = new GLTFLoader();
  const cleanTextures = skin ? registerEmbeddedTextures(loader, skin.id) : undefined;
  const objects: THREE.Group[] = [];
  try {
    for (const section of spec.sections) {
      const moduleId = VIEWER_MODEL_ASSETS[section.modelKey];
      if (!moduleId) throw new Error(`Missing viewer section ${section.modelKey}`);
      let uri: string;
      if (skin) uri = skinAssetUri(skin, 'viewer', section.modelKey);
      else { const asset = Asset.fromModule(moduleId); await asset.downloadAsync(); uri = asset.localUri ?? asset.uri; }
      const res = await fetch(uri);
      const buffer = await res.arrayBuffer();
      const gltf = await loader.parseAsync(buffer, '');
      if (cleanTextures) gltf.scene.userData.cleanupSkinTextures = cleanTextures;
      objects.push(gltf.scene);
    }
  } catch (error) {
    objects.forEach((object) => disposeObject(object));
    cleanTextures?.();
    throw error;
  }
  if (objects.length === 0) throw new Error(`no GLB sections loaded for ${spec.id}`);
  return objects;
}

function disposeObject(root: THREE.Object3D, extras: THREE.Material[] = []) {
  const materials = new Set(extras);
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((m) => materials.add(m));
    else if (material) materials.add(material);
  });
  const textures = new Set<THREE.Texture>();
  materials.forEach((material) => { for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value); material.dispose(); });
  textures.forEach(texture => texture.dispose());
  root.traverse(object => object.userData.cleanupSkinTextures?.());
}

function disposeSession(session: GlSession) {
  session.disposed = true;
  session.scheduler.dispose();
  disposeObject(session.scene, session.mechanisms.materialsToDispose);
  session.renderSurface.dispose();
  try {
    session.renderer.dispose();
  } catch {
    /* context already released */
  }
}

// ── UI bits ──────────────────────────────────────────────────────────────────

function SpecChip({
  icon,
  label,
  a11yLabel,
}: {
  icon: SFSymbol;
  label: string;
  /** Spoken form, where the abbreviated `label` would be ambiguous ("30.3 m"). */
  a11yLabel?: string;
}) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  return (
    <View
      style={[
        styles.chip,
        {
          backgroundColor: scheme === 'dark' ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.06)',
        },
      ]}
      accessible
      accessibilityLabel={a11yLabel ?? label}
    >
      <SymbolView name={icon} size={12} tintColor={c.textSecondary} />
      <Text style={[styles.chipText, { color: c.text }]} maxFontSizeMultiplier={TextScale.compact}>
        {label}
      </Text>
    </View>
  );
}

// ── screen ───────────────────────────────────────────────────────────────────

export default function ModelViewerScreen() {
  const params = useLocalSearchParams<{ id: string; skin?: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const spec: TramModelSpec | undefined = MODEL_SPECS[id as TramModelId];
  const skin = useSkinsStore(s => s.skins.find(item => item.id === params.skin && item.modelId === id));
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const background = viewerBackgroundColor(scheme);

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [cardHeight, setCardHeight] = useState(240);
  const [doorsOpen, setDoorsOpen] = useState(false);
  const [indicator, setIndicator] = useState<IndicatorDirection>('off');
  const [mechanismsAvailable, setMechanismsAvailable] = useState({
    doors: false,
    indicators: false,
  });

  // Refs shared between gestures and the render loop (no re-renders per frame).
  const orbitRef = useRef<OrbitState>(INITIAL_ORBIT);
  const panStartRef = useRef<OrbitState>(INITIAL_ORBIT);
  const pinchStartRef = useRef<OrbitState>(INITIAL_ORBIT);
  const zoomClampRef = useRef({ min: 5, max: 120 });
  const backgroundRef = useRef(background);
  const sessionRef = useRef<GlSession | null>(null);
  const mountedRef = useRef(true);
  const reduceMotionRef = useRef(false);
  const doorTransitionRef = useRef(CLOSED_DOORS);
  const signalRef = useRef<{
    direction: IndicatorDirection;
    startedAtMs: number;
  }>({ direction: 'off', startedAtMs: 0 });
  const appActiveRef = useRef(
    AppState.currentState !== 'background' && AppState.currentState !== 'inactive',
  );
  const contextGenerationRef = useRef(0);
  // Expo GL 57 exposes drawingBufferWidth/Height as creation-time values.
  // Native layout resizes the actual framebuffer without updating those JS
  // properties. Use the GLView's measured pixel size after card/rotation changes.
  const surfaceSizeRef = useRef({ width: 0, height: 0 });

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      appActiveRef.current = state === 'active';
      const session = sessionRef.current;
      if (!session || session.disposed) return;
      session.scheduler.setActive(appActiveRef.current);
    });
    return () => subscription.remove();
  }, []);

  // Reduce Motion makes mechanism controls settle immediately.
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        if (alive) { reduceMotionRef.current = v; sessionRef.current?.scheduler.request(); }
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => {
      reduceMotionRef.current = v;
      sessionRef.current?.scheduler.request();
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  // Keep the render loop's background in sync with the system theme.
  useEffect(() => {
    backgroundRef.current = background;
    sessionRef.current?.scheduler.request();
  }, [background]);

  // Unknown / missing id → graceful back (route can be deep-linked).
  useEffect(() => {
    if (!spec) {
      if (router.canGoBack()) router.back();
      else router.replace('/');
    }
  }, [spec, router]);

  // Dispose GL resources and invalidate setup work on unmount.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      contextGenerationRef.current++;
      if (sessionRef.current) disposeSession(sessionRef.current);
      sessionRef.current = null;
    };
  }, []);

  const onContextCreate = useCallback(
    async (gl: ExpoWebGLRenderingContext) => {
      if (!spec) return;
      const generation = ++contextGenerationRef.current;
      if (sessionRef.current) disposeSession(sessionRef.current);
      sessionRef.current = null;
      setStatus('loading');
      setMechanismsAvailable({ doors: false, indicators: false });
      let renderer: THREE.WebGLRenderer | null = null;
      try {
        const width = surfaceSizeRef.current.width || gl.drawingBufferWidth;
        const height = surfaceSizeRef.current.height || gl.drawingBufferHeight;
        // expo-gl returns undefined for VERSION/SHADING_LANGUAGE_VERSION string
        // params; three r162 calls .indexOf on them. Shim them to WebGL 1 ids.
        const rawGetParameter = gl.getParameter.bind(gl);
        (gl as unknown as { getParameter: (p: number) => unknown }).getParameter = (
          pname: number,
        ) => {
          const value = rawGetParameter(pname);
          if (typeof value === 'string') return value;
          if (pname === gl.VERSION) return 'WebGL 1.0 (Expo GL)';
          if (pname === gl.SHADING_LANGUAGE_VERSION) return 'WebGL GLSL ES 1.0 (Expo GL)';
          return value;
        };
        renderer = new THREE.WebGLRenderer({
          canvas: makeFakeCanvas(gl),
          context: gl as unknown as WebGL2RenderingContext,
          antialias: true,
        });
        renderer.setPixelRatio(1);
        renderer.setSize(width, height, false);

        const scene = new THREE.Scene();
        const backgroundColor = new THREE.Color(backgroundRef.current);
        scene.background = backgroundColor;
        addLights(scene);

        // ── consist: all sections nose-to-tail, front toward −Z end ─────────
        const sections = await loadSections(spec, skin);
        if (!mountedRef.current || generation !== contextGenerationRef.current) {
          sections.forEach((section) => disposeObject(section));
          renderer.dispose();
          return;
        }
        const group = new THREE.Group();
        // Match map placement using body lengths, not protruding lamps,
        // collectors or shared bogie geometry in the mesh bounding boxes.
        const extents = spec.sections.map(({ lengthM }) => ({
          minZ: -lengthM / 2,
          maxZ: lengthM / 2,
        }));
        const offsets = layoutSections(extents, spec.jointGapM);
        sections.forEach((obj, i) => {
          obj.position.z = offsets[i];
          group.add(obj);
        });
        scene.add(group);
        const replacedMaterials = isDevice ? [] : useSimulatorMaterials(group);
        const mechanisms = bindMechanisms(group);
        mechanisms.materialsToDispose.push(...replacedMaterials);

        const total = new THREE.Box3().setFromObject(group);
        const target = total.getCenter(new THREE.Vector3());
        const size = total.getSize(new THREE.Vector3());

        // expo-gl WebGL1 quirk (verified on-simulator): the scene stays blank
        // unless at least one MeshBasicMaterial object is drawn — it primes the
        // program pipeline for the PBR materials. A 1 cm cube hidden 1 m below
        // the model costs nothing and makes everything render.
        const pipelinePrimer = new THREE.Mesh(
          new THREE.BoxGeometry(0.01, 0.01, 0.01),
          new THREE.MeshBasicMaterial({ color: 0x000000 }),
        );
        pipelinePrimer.position.set(target.x, total.min.y - 1, target.z);
        scene.add(pipelinePrimer);

        // ── camera: 3/4 front, framing the whole consist ────────────────────
        const aspect = width / Math.max(1, height);
        const camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, aspect, 0.1, 600);
        const r0 = fitRadius({ x: size.x, y: size.y, z: size.z }, CAMERA_FOV_DEG, aspect);
        orbitRef.current = {
          azimuthDeg: INITIAL_AZIMUTH_DEG,
          elevationDeg: INITIAL_ELEVATION_DEG,
          radiusM: r0,
        };
        zoomClampRef.current = {
          min: Math.max(2, r0 * ZOOM_MIN_FACTOR),
          max: r0 * ZOOM_MAX_FACTOR,
        };

        const frameBudgetMs = isDevice ? DEVICE_FRAME_MS : SIMULATOR_FRAME_MS;
        const session: GlSession = {
          gl,
          renderer,
          renderSurface: createModelRenderSurface(
            renderer,
            width,
            height,
            isDevice ? null : SIMULATOR_RENDER_MAX_EDGE,
          ),
          scene,
          camera,
          background: backgroundColor,
          target,
          scheduler: createDemandRenderer(() => frame(), frameBudgetMs),
          disposed: false,
          mechanisms,
          bounds: total,
          overviewRadius: r0,
          overviewTarget: target.clone(),
          bufW: width,
          bufH: height,
        };
        sessionRef.current = session;

        // Render only after input, layout/theme changes or a mechanism edge.
        const frame = (): number | null => {
          if (session.disposed || !appActiveRef.current) return null;
          // Native framebuffer dimensions follow layout; Expo's initial JS
          // drawingBuffer properties stay stale. Using them crops the roof
          // after the ready-state controls increase the bottom card's height.
          const bw = surfaceSizeRef.current.width || session.bufW;
          const bh = surfaceSizeRef.current.height || session.bufH;
          if (bw > 0 && bh > 0 && (bw !== session.bufW || bh !== session.bufH)) {
            const oldAspect = session.camera.aspect;
            const nextAspect = bw / bh;
            const size = session.bounds.getSize(new THREE.Vector3());
            const fitRatio = fitRadius(size, CAMERA_FOV_DEG, nextAspect) /
              fitRadius(size, CAMERA_FOV_DEG, oldAspect);
            orbitRef.current.radiusM *= fitRatio;
            zoomClampRef.current.min *= fitRatio;
            zoomClampRef.current.max *= fitRatio;
            session.bufW = bw;
            session.bufH = bh;
            session.renderer.setSize(bw, bh, false);
            session.renderSurface.resize(bw, bh);
            session.camera.aspect = nextAspect;
            session.camera.updateProjectionMatrix();
          }
          const now = Date.now();
          const pos = orbitToPosition(orbitRef.current, session.target);
          session.camera.position.set(pos.x, pos.y, pos.z);
          session.camera.lookAt(session.target);
          const clip = modelClipPlanes(pos, session.target, session.bounds.min, session.bounds.max);
          if (clip.near !== session.camera.near || clip.far !== session.camera.far) {
            session.camera.near = clip.near;
            session.camera.far = clip.far;
            session.camera.updateProjectionMatrix();
          }
          session.background.set(backgroundRef.current);
          const signal = signalRef.current;
          applyMechanisms(
            session.mechanisms,
            doorProgress(doorTransitionRef.current, now, reduceMotionRef.current),
            signal.direction,
            now,
            signal.startedAtMs,
            reduceMotionRef.current,
          );
          try {
            session.renderSurface.render(session.scene, session.camera);
            session.gl.endFrameEXP();
            // endFrameEXP queues work asynchronously. Without a completion
            // barrier, a software GL renderer accumulates minutes of frames;
            // iOS then blocks background/close waiting for that queue to drain.
            // flushEXP is Expo's supported native-command barrier. Schedule
            // the next frame only after this frame has crossed it.
            session.gl.flushEXP();
          } catch (error) {
            console.warn('[model-viewer] rendering failed', error);
            disposeSession(session);
            if (mountedRef.current) setStatus('error');
            return null;
          }
          return nextMechanismFrame(now, doorTransitionRef.current, signal.direction,
            signal.startedAtMs, reduceMotionRef.current, frameBudgetMs);
        };
        setMechanismsAvailable({
          doors: mechanisms.doors.length > 0,
          indicators: mechanisms.indicators.length > 0,
        });
        session.scheduler.setActive(appActiveRef.current);
        // Rendering errors asynchronously replace ready with the error state.
        if (!session.disposed) setStatus('ready');
      } catch (e) {
        console.warn('[model-viewer] failed to build 3D scene', e);
        if (e instanceof Error) console.warn('[model-viewer] stack:', e.stack);
        try {
          renderer?.dispose();
        } catch {
          // best-effort cleanup on a half-initialized context
        }
        if (mountedRef.current && generation === contextGenerationRef.current) setStatus('error');
      }
    },
    [spec, skin],
  );

  // ── gestures: pan = orbit, pinch = dolly (simultaneous, JS thread). Each
  // gesture owns its start state and merges only its own axes into the shared
  // orbit, so a two-finger orbit-while-zooming doesn't fight itself. ─────────
  const noteInteraction = useCallback(() => {
    sessionRef.current?.scheduler.request();
  }, []);
  const endGesture = useCallback(() => {
    noteInteraction();
  }, [noteInteraction]);

  /* eslint-disable react-hooks/refs -- the builder callbacks below are DEFERRED
     (they fire on touch, never during render), but the rule only sees closures
     handed to a function that IS called during render and has to assume the
     worst. The orbit deliberately lives in refs: the demand renderer reads it, so
     holding it in state would re-render the tree on every finger move (perf
     invariant #1). */
  const panGesture = Gesture.Pan()
    .runOnJS(true)
    .maxPointers(1)
    .onBegin(() => {
      panStartRef.current = orbitRef.current;
      noteInteraction();
    })
    .onUpdate((e) => {
      const o = panOrbit(panStartRef.current, e.translationX, e.translationY);
      orbitRef.current = {
        ...orbitRef.current,
        azimuthDeg: o.azimuthDeg,
        elevationDeg: o.elevationDeg,
      };
      noteInteraction();
    })
    .onFinalize(endGesture);

  const pinchGesture = Gesture.Pinch()
    .runOnJS(true)
    .onBegin(() => {
      pinchStartRef.current = orbitRef.current;
      noteInteraction();
    })
    .onUpdate((e) => {
      const { min, max } = zoomClampRef.current;
      const o = pinchOrbit(pinchStartRef.current, e.scale, min, max);
      orbitRef.current = { ...orbitRef.current, radiusM: o.radiusM };
      noteInteraction();
    })
    .onFinalize(endGesture);

  const gesture = Gesture.Simultaneous(panGesture, pinchGesture);
  /* eslint-enable react-hooks/refs */

  // Non-gesture orbiting for VoiceOver invalidates the stationary scene.
  const onRotateAction = (e: AccessibilityActionEvent) => {
    const o = orbitRef.current;
    const delta = e.nativeEvent.actionName === 'increment' ? ROTATE_ACTION_DEG : -ROTATE_ACTION_DEG;
    orbitRef.current = {
      ...o,
      azimuthDeg: normalizeAzimuthDeg(o.azimuthDeg + delta),
    };
    sessionRef.current?.scheduler.request();
  };

  const onViewPreset = (view: 'whole' | 'front' | 'rear') => {
    const session = sessionRef.current;
    if (!session || !spec) return;
    sessionRef.current?.scheduler.request();
    if (view === 'whole') {
      session.target.copy(session.overviewTarget);
      orbitRef.current = {
        azimuthDeg: INITIAL_AZIMUTH_DEG,
        elevationDeg: INITIAL_ELEVATION_DEG,
        radiusM: fitRadius(
          session.bounds.getSize(new THREE.Vector3()),
          CAMERA_FOV_DEG,
          session.camera.aspect,
        ),
      };
    } else {
      const front = view === 'front';
      session.target.set(
        session.overviewTarget.x,
        session.bounds.min.y + spec.heightM * 0.52,
        front ? session.bounds.min.z + 0.65 : session.bounds.max.z - 0.65,
      );
      const radius = fitCabRadius(
        { x: spec.widthM * 1.08, y: spec.heightM, z: 2.2 },
        CAMERA_FOV_DEG,
        session.camera.aspect,
      );
      orbitRef.current = {
        azimuthDeg: front ? 0 : 180,
        elevationDeg: 5,
        radiusM: radius,
      };
      zoomClampRef.current.min = Math.min(zoomClampRef.current.min, 2);
    }
  };

  const onDoorsChange = (open: boolean) => {
    const now = Date.now();
    doorTransitionRef.current = changeDoorTarget(
      doorTransitionRef.current,
      open,
      now,
      reduceMotionRef.current,
    );
    sessionRef.current?.scheduler.request();
    setDoorsOpen(open);
  };
  const onIndicatorChange = (key: string) => {
    const direction = key as IndicatorDirection;
    signalRef.current = { direction, startedAtMs: Date.now() };
    sessionRef.current?.scheduler.request();
    setIndicator(direction);
  };

  const onClose = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  if (!spec) {
    // Unknown id: the effect above already navigated away — render a quiet frame.
    return <View style={[styles.root, { backgroundColor: background }]} />;
  }

  return (
    <GestureHandlerRootView style={[styles.root, { backgroundColor: background }]}>
      {status !== 'error' && (
        // The label/actions live on a plain View wrapper: props set directly on
        // the GLView are swallowed by the native GL surface.
        <View
          style={[
            styles.gl,
            {
              marginTop: insets.top + 56,
              marginBottom: cardHeight + Math.max(insets.bottom, 12) + 24,
            },
          ]}
          accessible
          accessibilityRole="image"
          accessibilityLabel={`3D model of ${spec.name}, ${spec.manufacturer}, ${spec.totalLengthM.toFixed(1)} metres long`}
          accessibilityActions={ROTATE_ACTIONS}
          onAccessibilityAction={onRotateAction}
        >
          <GestureDetector gesture={gesture}>
            <GLView
              key={`${spec.id}-${skin?.directory ?? 'standard'}`}
              style={styles.gl}
              msaaSamples={isDevice ? 4 : 0}
              onContextCreate={onContextCreate}
              onLayout={({ nativeEvent: { layout } }) => {
                const scale = PixelRatio.get();
                surfaceSizeRef.current = {
                  width: Math.max(1, Math.round(layout.width * scale)),
                  height: Math.max(1, Math.round(layout.height * scale)),
                };
                sessionRef.current?.scheduler.request();
              }}
            />
          </GestureDetector>
        </View>
      )}

      {status === 'loading' && (
        <View style={styles.centerOverlay} pointerEvents="none">
          <ActivityIndicator size="large" color={c.textSecondary} />
          <Text style={[styles.loadingText, { color: c.textSecondary }]}>
            Building {spec.name}…
          </Text>
        </View>
      )}

      {status === 'error' && (
        <View style={styles.centerOverlay}>
          <SymbolView name="cube.transparent" size={44} tintColor={c.textSecondary} />
          <Text style={[styles.errorTitle, { color: c.text }]}>3D view unavailable</Text>
          <Text style={[styles.loadingText, { color: c.textSecondary }]}>
            The model could not be loaded on this device.
          </Text>
        </View>
      )}

      {/* Close — top-right, Apple circular translucent control */}
      <View style={[styles.closeSlot, { top: insets.top + 8 }]}>
        <CircleControl
          symbol="xmark"
          label="Close 3D viewer"
          onPress={onClose}
          appearance={scheme}
        />
      </View>

      {/* Model card — bottom */}
      <GlassPanel style={[styles.infoGlass, { bottom: Math.max(insets.bottom, 12) + 8 }]}>
        <View
          style={styles.infoContent}
          onLayout={(event) => setCardHeight(Math.ceil(event.nativeEvent.layout.height))}
        >
          <Text style={[styles.infoName, { color: c.text }]} numberOfLines={1}>
            {skin ? `${spec.name} · ${skin.title}` : spec.name}
          </Text>
          <Text style={[styles.infoSub, { color: c.textSecondary }]} numberOfLines={1}>
            {spec.manufacturer} · {spec.yearsBuilt}
          </Text>
          <View style={styles.chipsRow}>
            <SpecChip
              icon="ruler"
              label={`${spec.totalLengthM.toFixed(1)} m`}
              a11yLabel={`${spec.totalLengthM.toFixed(1)} metres long`}
            />
            <SpecChip icon="arrow.left.and.right" label={`${spec.widthM.toFixed(2)} m wide`} />
            <SpecChip icon="gauge.with.needle" label={`${spec.maxSpeedKmh} km/h`} />
          </View>
          {status === 'ready' && (
            <View style={styles.presetRow}>
              <Button
                title="Whole tram"
                onPress={() => onViewPreset('whole')}
                accessibilityLabel="Show the whole tram"
              />
              <Button
                title="Front"
                onPress={() => onViewPreset('front')}
                accessibilityLabel="Inspect the front of the tram"
              />
              <Button
                title="Rear"
                onPress={() => onViewPreset('rear')}
                accessibilityLabel="Inspect the rear of the tram"
              />
            </View>
          )}
          {status === 'ready' && (mechanismsAvailable.doors || mechanismsAvailable.indicators) && (
            <View style={styles.mechanisms}>
              <Text style={[styles.demoLabel, { color: c.textSecondary }]}>Demo</Text>
              {mechanismsAvailable.doors && (
                <View style={styles.mechanismRow}>
                  <Text style={[styles.mechanismLabel, { color: c.text }]}>Doors</Text>
                  <Switch
                    value={doorsOpen}
                    onValueChange={onDoorsChange}
                    accessibilityLabel="Open model doors"
                  />
                </View>
              )}
              {mechanismsAvailable.indicators && (
                <View style={styles.mechanismRow}>
                  <Text style={[styles.mechanismLabel, { color: c.text }]}>Indicators</Text>
                  <View style={styles.signalSegments}>
                    <SegmentedPills
                      appearance={scheme}
                      selectedKey={indicator}
                      onChange={onIndicatorChange}
                      segments={[
                        { key: 'left', label: 'Left' },
                        { key: 'off', label: 'Off' },
                        { key: 'right', label: 'Right' },
                      ]}
                    />
                  </View>
                </View>
              )}
            </View>
          )}
          {/* Gesture-only hint: hidden from VoiceOver, which orbits via the
              rotate actions on the model instead. */}
          <View
            style={styles.hintRow}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <SymbolView name="hand.draw" size={11} tintColor={c.textSecondary} />
            <Text
              style={[styles.hintText, { color: c.textSecondary }]}
              maxFontSizeMultiplier={TextScale.compact}
            >
              Drag to rotate · pinch to zoom
            </Text>
          </View>
        </View>
      </GlassPanel>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  centerOverlay: {
    alignItems: 'center',
    bottom: 0,
    gap: 10,
    justifyContent: 'center',
    left: 0,
    paddingHorizontal: 40,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  chip: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 10,
    flexDirection: 'row',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  chipText: { fontSize: 12, fontVariant: ['tabular-nums'], fontWeight: '600' },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  closeSlot: { position: 'absolute', right: 16 },
  errorTitle: { fontSize: 17, fontWeight: '700' },
  gl: { flex: 1 },
  hintRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 5,
    marginTop: 10,
  },
  hintText: { fontSize: 11 },
  presetRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  mechanisms: { marginTop: 10, gap: 8 },
  mechanismRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  mechanismLabel: { fontSize: 14, fontWeight: '500' },
  demoLabel: { fontSize: 11, fontWeight: '600' },
  signalSegments: { flex: 1, maxWidth: 245 },
  infoContent: { paddingHorizontal: 18, paddingVertical: 14 },
  infoGlass: { left: 16, position: 'absolute', right: 16 },
  infoName: { fontSize: 18, fontWeight: '700', letterSpacing: -0.3 },
  infoSub: { fontSize: 13, marginTop: 2 },
  loadingText: { fontSize: 13, textAlign: 'center' },
  root: { flex: 1 },
});
