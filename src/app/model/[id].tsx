// Full-screen interactive 3D tram viewer (fullScreenModal, registered in
// _layout as model/[id]). Renders ALL body sections of MODEL_SPECS[id] with
// expo-gl + three.js, laid nose-to-tail like a real consist (front = −Z, same
// convention as scripts/render-model.mjs). Orbit with a pan gesture, pinch to
// dolly, gentle turntable when untouched. Written defensively: every GL/GLB
// step is guarded — failures land in a friendly error state, never a crash.
import { Asset } from 'expo-asset';
import { GLView, type ExpoWebGLRenderingContext } from 'expo-gl';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
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
  IDLE_SPIN_DEG_PER_S,
  IDLE_SPIN_DELAY_MS,
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
import { MODEL_ASSETS, MODEL_SPECS } from '@/lib/fleet/modelSpecs';
import type { TramModelId, TramModelSpec } from '@/lib/types';

// React Native defines `navigator` without `userAgent`; GLTFLoader (r162)
// sniffs `navigator.userAgent.indexOf('Firefox')` and crashes on undefined.
const nav = globalThis.navigator as { userAgent?: string } | undefined;
if (nav && typeof nav.userAgent !== 'string') {
  try {
    Object.defineProperty(nav, 'userAgent', { value: 'ReactNative ExpoGL', configurable: true });
  } catch {
    // non-configurable navigator: GLTFLoader will fail loudly instead
  }
}

const CAMERA_FOV_DEG = 40;
/** Idle frame budget ≈ 30 fps; interacting renders at full rAF rate. */
const IDLE_FRAME_MS = 33;

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
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  background: THREE.Color;
  target: THREE.Vector3;
  raf: number;
  lastRenderMs: number;
  disposed: boolean;
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

/** Soft dark radial-gradient ground circle (fake contact shadow). */
function makeGroundCircle(radiusM: number): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uOpacity: { value: 0.3 } },
    vertexShader:
      'varying vec2 vUv;\n' +
      'void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader:
      'varying vec2 vUv;\n' +
      'uniform float uOpacity;\n' +
      'void main() {\n' +
      '  float d = length(vUv - 0.5) * 2.0;\n' +
      '  float a = uOpacity * smoothstep(1.0, 0.15, d);\n' +
      '  gl_FragColor = vec4(0.0, 0.0, 0.0, a);\n' +
      '}',
  });
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(radiusM, 48), material);
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

/** Load + parse every section GLB of a spec. Throws if none can be loaded. */
async function loadSections(spec: TramModelSpec): Promise<THREE.Group[]> {
  const loader = new GLTFLoader();
  const objects: THREE.Group[] = [];
  for (const section of spec.sections) {
    const moduleId = MODEL_ASSETS[section.modelKey];
    if (!moduleId) continue; // asset missing from the bundle — skip defensively
    const asset = Asset.fromModule(moduleId);
    await asset.downloadAsync();
    const uri = asset.localUri ?? asset.uri;
    const res = await fetch(uri);
    const buffer = await res.arrayBuffer();
    const gltf = await loader.parseAsync(buffer, '');
    objects.push(gltf.scene);
  }
  if (objects.length === 0) throw new Error(`no GLB sections loaded for ${spec.id}`);
  return objects;
}

function disposeSession(session: GlSession) {
  session.disposed = true;
  cancelAnimationFrame(session.raf);
  session.scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else if (material) material.dispose();
  });
  try {
    session.renderer.dispose();
  } catch {
    // renderer teardown after the GL context is already gone — ignore
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
        { backgroundColor: scheme === 'dark' ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.06)' },
      ]}
      accessible
      accessibilityLabel={a11yLabel ?? label}
    >
      <SymbolView name={icon} size={12} tintColor={c.textSecondary} />
      <Text
        style={[styles.chipText, { color: c.text }]}
        maxFontSizeMultiplier={TextScale.compact}
      >
        {label}
      </Text>
    </View>
  );
}

// ── screen ───────────────────────────────────────────────────────────────────

export default function ModelViewerScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const spec: TramModelSpec | undefined = MODEL_SPECS[id as TramModelId];
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const background = viewerBackgroundColor(scheme);

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  // Refs shared between gestures and the render loop (no re-renders per frame).
  const orbitRef = useRef<OrbitState>(INITIAL_ORBIT);
  const panStartRef = useRef<OrbitState>(INITIAL_ORBIT);
  const pinchStartRef = useRef<OrbitState>(INITIAL_ORBIT);
  const zoomClampRef = useRef({ min: 5, max: 120 });
  const activeGesturesRef = useRef(0);
  const lastInteractionRef = useRef(0);
  const backgroundRef = useRef(background);
  const sessionRef = useRef<GlSession | null>(null);
  const mountedRef = useRef(true);
  const reduceMotionRef = useRef(false);

  // Reduce Motion suppresses the endless turntable (the initial 3/4-front pose
  // is kept — drag still works). A ref, so the render loop reads it for free.
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        if (alive) reduceMotionRef.current = v;
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => {
      reduceMotionRef.current = v;
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  // Keep the render loop's background in sync with the system theme.
  useEffect(() => {
    backgroundRef.current = background;
  }, [background]);

  // Unknown / missing id → graceful back (route can be deep-linked).
  useEffect(() => {
    if (!spec) {
      if (router.canGoBack()) router.back();
      else router.replace('/');
    }
  }, [spec, router]);

  // Dispose GL resources on unmount (and flag so an in-flight setup bails).
  useEffect(
    () => () => {
      mountedRef.current = false;
      if (sessionRef.current) disposeSession(sessionRef.current);
      sessionRef.current = null;
    },
    [],
  );

  const onContextCreate = useCallback(
    async (gl: ExpoWebGLRenderingContext) => {
      if (!spec) return;
      let renderer: THREE.WebGLRenderer | null = null;
      try {
        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;
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
        const sections = await loadSections(spec);
        if (!mountedRef.current) {
          renderer.dispose();
          return;
        }
        const group = new THREE.Group();
        const extents = sections.map((obj) => {
          const box = new THREE.Box3().setFromObject(obj);
          return { minZ: box.min.z, maxZ: box.max.z };
        });
        const offsets = layoutSections(extents);
        sections.forEach((obj, i) => {
          obj.position.z = offsets[i];
          group.add(obj);
        });
        scene.add(group);

        const total = new THREE.Box3().setFromObject(group);
        const target = total.getCenter(new THREE.Vector3());
        const size = total.getSize(new THREE.Vector3());

        const ground = makeGroundCircle(Math.max(size.x, size.z) * 0.72);
        ground.position.set(target.x, total.min.y - 0.02, target.z);
        scene.add(ground);

        // expo-gl WebGL1 quirk (verified on-simulator): the scene stays blank
        // unless at least one MeshBasicMaterial object is drawn — it primes the
        // program pipeline for the PBR materials. A 1 cm cube hidden 1 m below
        // the ground disc costs nothing and makes everything render.
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
        zoomClampRef.current = { min: Math.max(2, r0 * ZOOM_MIN_FACTOR), max: r0 * ZOOM_MAX_FACTOR };

        const session: GlSession = {
          gl,
          renderer,
          scene,
          camera,
          background: backgroundColor,
          target,
          raf: 0,
          lastRenderMs: 0,
          disposed: false,
          bufW: width,
          bufH: height,
        };
        sessionRef.current = session;

        // ── render loop: full rate while touched, ~30 fps turntable idle ────
        const frame = () => {
          if (session.disposed) return;
          session.raf = requestAnimationFrame(frame);
          // expo-gl reallocates the drawing buffer on every native layout pass
          // (GLView.layoutSubviews), but three keeps the viewport and camera
          // aspect it was built with — an iPad rotation or Stage Manager resize
          // would stretch and clip the consist. Re-fit from expo-gl's own
          // numbers, before the idle-throttle return so a resize is picked up
          // even on a skipped frame.
          const bw = session.gl.drawingBufferWidth;
          const bh = session.gl.drawingBufferHeight;
          if (bw > 0 && bh > 0 && (bw !== session.bufW || bh !== session.bufH)) {
            session.bufW = bw;
            session.bufH = bh;
            session.renderer.setSize(bw, bh, false);
            session.camera.aspect = bw / Math.max(1, bh);
            session.camera.updateProjectionMatrix();
          }
          const now = Date.now();
          const interacting =
            activeGesturesRef.current > 0 || now - lastInteractionRef.current < 250;
          if (!interacting && now - session.lastRenderMs < IDLE_FRAME_MS) return;
          const dtS = Math.min(now - session.lastRenderMs, 100) / 1000;
          session.lastRenderMs = now;

          if (
            !reduceMotionRef.current &&
            !interacting &&
            now - lastInteractionRef.current > IDLE_SPIN_DELAY_MS
          ) {
            const o = orbitRef.current;
            orbitRef.current = { ...o, azimuthDeg: o.azimuthDeg + IDLE_SPIN_DEG_PER_S * dtS };
          }

          const pos = orbitToPosition(orbitRef.current, session.target);
          session.camera.position.set(pos.x, pos.y, pos.z);
          session.camera.lookAt(session.target);
          session.background.set(backgroundRef.current);
          session.renderer.render(session.scene, session.camera);
          session.gl.endFrameEXP();
        };
        lastInteractionRef.current = Date.now() - IDLE_SPIN_DELAY_MS; // start turntable immediately
        frame();
        setStatus('ready');
      } catch (e) {
        console.warn('[model-viewer] failed to build 3D scene', e);
        if (e instanceof Error) console.warn('[model-viewer] stack:', e.stack);
        try {
          renderer?.dispose();
        } catch {
          // best-effort cleanup on a half-initialized context
        }
        if (mountedRef.current) setStatus('error');
      }
    },
    [spec],
  );

  // ── gestures: pan = orbit, pinch = dolly (simultaneous, JS thread). Each
  // gesture owns its start state and merges only its own axes into the shared
  // orbit, so a two-finger orbit-while-zooming doesn't fight itself. ─────────
  const noteInteraction = useCallback(() => {
    lastInteractionRef.current = Date.now();
  }, []);
  const endGesture = useCallback(() => {
    activeGesturesRef.current = Math.max(0, activeGesturesRef.current - 1);
    noteInteraction();
  }, [noteInteraction]);

  /* eslint-disable react-hooks/refs -- the builder callbacks below are DEFERRED
     (they fire on touch, never during render), but the rule only sees closures
     handed to a function that IS called during render and has to assume the
     worst. The orbit deliberately lives in refs: the 60 fps GL loop reads it, so
     holding it in state would re-render the tree on every finger move (perf
     invariant #1). */
  const panGesture = Gesture.Pan()
    .runOnJS(true)
    .maxPointers(1)
    .onBegin(() => {
      activeGesturesRef.current += 1;
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
    })
    .onFinalize(endGesture);

  const pinchGesture = Gesture.Pinch()
    .runOnJS(true)
    .onBegin(() => {
      activeGesturesRef.current += 1;
      pinchStartRef.current = orbitRef.current;
      noteInteraction();
    })
    .onUpdate((e) => {
      const { min, max } = zoomClampRef.current;
      const o = pinchOrbit(pinchStartRef.current, e.scale, min, max);
      orbitRef.current = { ...orbitRef.current, radiusM: o.radiusM };
    })
    .onFinalize(endGesture);

  const gesture = Gesture.Simultaneous(panGesture, pinchGesture);
  /* eslint-enable react-hooks/refs */

  // Non-gesture orbiting for VoiceOver. Touching lastInteractionRef makes the
  // loop render at full rate for 250 ms so the nudge is actually drawn.
  const onRotateAction = (e: AccessibilityActionEvent) => {
    const o = orbitRef.current;
    const delta = e.nativeEvent.actionName === 'increment' ? ROTATE_ACTION_DEG : -ROTATE_ACTION_DEG;
    orbitRef.current = { ...o, azimuthDeg: normalizeAzimuthDeg(o.azimuthDeg + delta) };
    lastInteractionRef.current = Date.now();
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
          style={styles.gl}
          accessible
          accessibilityRole="image"
          accessibilityLabel={`3D model of ${spec.name}, ${spec.manufacturer}, ${spec.totalLengthM.toFixed(1)} metres long`}
          accessibilityActions={ROTATE_ACTIONS}
          onAccessibilityAction={onRotateAction}
        >
          <GestureDetector gesture={gesture}>
            <GLView style={styles.gl} msaaSamples={4} onContextCreate={onContextCreate} />
          </GestureDetector>
        </View>
      )}

      {status === 'loading' && (
        <View style={styles.centerOverlay} pointerEvents="none">
          <ActivityIndicator size="large" color={c.textSecondary} />
          <Text style={[styles.loadingText, { color: c.textSecondary }]}>Building {spec.name}…</Text>
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
        <View style={styles.infoContent}>
          <Text style={[styles.infoName, { color: c.text }]} numberOfLines={1}>
            {spec.name}
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
  hintRow: { alignItems: 'center', flexDirection: 'row', gap: 5, marginTop: 10 },
  hintText: { fontSize: 11 },
  infoContent: { paddingHorizontal: 18, paddingVertical: 14 },
  infoGlass: { left: 16, position: 'absolute', right: 16 },
  infoName: { fontSize: 18, fontWeight: '700', letterSpacing: -0.3 },
  infoSub: { fontSize: 13, marginTop: 2 },
  loadingText: { fontSize: 13, textAlign: 'center' },
  root: { flex: 1 },
});
