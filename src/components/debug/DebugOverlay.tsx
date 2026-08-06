// DEBUG OVERLAY — a live, utilitarian technical readout of the simulation for
// the followed tram, drawn over the map when Settings ▸ Developer ▸ Debug mode
// is on. Deliberately NOT styled to the app's guidelines: dense monospace rows,
// lots of raw numbers — built to evaluate the physics from inside a real tram.
//
// UPDATE CADENCE — 10 Hz, but ONLY in the live readout. Debug mode is EXEMPT
// from the app's ≤1 Hz perf invariant exactly where the claim holds:
// `DebugLive` (rendered solely for the followed tram, expanded, not in guide
// mode) re-reads the engine on a private 100 ms timer. Numeric text cannot make
// useful use of display-rate React commits; the former display loop rebuilt four
// cards and dozens of Text nodes ~60 times/s and could pin Hermes when the
// persisted debug setting reopened. The GPS on-line position is read at 10 Hz
// and forward-extrapolated between the ~1 Hz foreground fixes
// (projectOnlineDistAt) so the "real" distance still advances smoothly instead of
// stepping once a second. The collapsed one-liner and the guide render nothing
// that changes at 60 Hz, so they run at 1 Hz and hold NO GPS watch: unmounting
// DebugLive releases the locator and clears the timer.
//
// Data sources:
//   • engine.getDebugInfo(key) — raw INTERNAL sim state (phase, every speed &
//     cap, curvature, pace bias, the smoother regime + predictor error, and
//     every active hold with numbers: fix-pin / stuck / junction-yield /
//     skip-roll / dwell / teleport);
//   • engine.getState(key)     — next stop + ETA, delay, raw fix;
//   • OnlineLocator            — the rider's filtered GPS projected onto the
//     followed tram's shape = the REAL on-line position (ground truth: the
//     rider is physically in this tram).
//
// Diffs are signed: POSITIVE lag = the SIM is AHEAD of the real tram.
import { createContext, useContext, useEffect, useState } from 'react';
import Constants from 'expo-constants';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getRuntime, useTramState } from '@/hooks/tramData';
import { useNowMs } from '@/hooks/uiClock';
import { Fonts } from '@/constants/theme';
import {
  projectOnlineDistAt,
  projectOnlineFix,
  useOnlineLocator,
  type OnlineFix,
  type OnlineLocator,
  type OnlineProjection,
} from '@/lib/motionlog';
import type { SimDebugInfo, TramPublicState } from '@/lib/types';
import { useSelectionStore } from '@/stores/selection';
import { useSettingsStore } from '@/stores/settings';

const MONO = Fonts?.mono ?? 'monospace';
/** Fast enough for numeric diagnostics, ~6x fewer React commits than display rate. */
export const DEBUG_LIVE_INTERVAL_MS = 100;

// ── formatting ───────────────────────────────────────────────────────────────

function num(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

/** Signed value (leading + on non-negative) — for diffs where sign is meaning. */
function signed(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(digits);
}

/** Seconds, 1 decimal (from ms). */
function sec1(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  return (ms / 1000).toFixed(1) + 's';
}

// ── live snapshot (rebuilt at 10 Hz) ─────────────────────────────────────────

interface DebugSnapshot {
  nowMs: number;
  dbg: SimDebugInfo | undefined;
  state: TramPublicState | undefined;
  fix: OnlineFix | null;
  proj: OnlineProjection | null;
  /** Filtered on-line distance, forward-extrapolated to the current sample. */
  realDistM: number | null;
  /** Raw GPS projected on the shape (non-extrapolated). */
  realRawDistM: number | null;
  /** Along-shape distance to the next stop ahead of the sim, m. */
  nextStopDistM: number | null;
  watchActive: boolean;
  watchError: string | null;
}

/** Read everything fresh for `key` at the current instant. Pure (no writes). */
function buildSnapshot(key: string | null, locator: OnlineLocator): DebugSnapshot {
  const nowMs = Date.now();
  const engine = getRuntime().engine;
  const dbg = key ? engine.getDebugInfo(key, nowMs) : undefined;
  const state = key ? engine.getState(key, nowMs) : undefined;
  const geometry = key ? engine.getGeometry(key) : undefined;
  const fix = locator.latest();
  const proj = fix ? projectOnlineFix(fix, geometry) : null;
  const baseReal = proj ? (proj.fDistM ?? proj.gpsDistM) : null;
  const realDistM = projectOnlineDistAt(baseReal, fix, nowMs);
  const realRawDistM = proj ? proj.gpsDistM : null;

  let nextStopDistM: number | null = null;
  if (geometry && dbg?.hasSim) {
    for (const st of geometry.stops) {
      if (st.distM > dbg.simDistM + 0.5) {
        nextStopDistM = st.distM - dbg.simDistM;
        break;
      }
    }
  }
  return {
    nowMs,
    dbg,
    state,
    fix,
    proj,
    realDistM,
    realRawDistM,
    nextStopDistM,
    watchActive: locator.active(),
    watchError: locator.error(),
  };
}

// ── phase / regime words ─────────────────────────────────────────────────────

/** Human-readable phase headline. */
function phaseLabel(d: SimDebugInfo): string {
  switch (d.phase) {
    case 'terminal':
      return 'AT TERMINAL (end of trip)';
    case 'dwell':
      return d.fixPinActive ? 'HOLDING AT STOP (fix says standing)' : 'DWELLING AT STOP (boarding)';
    case 'cruise':
      if (d.stuckAtM !== null) return 'STUCK — holding at fix (jam / light)';
      if (d.yieldHoldM !== null) return 'YIELDING at junction';
      if (d.regime === 'hold-follow') return 'HOLDING WITH REALITY (predictor standing)';
      if (d.regime === 'yield') return 'AHEAD OF REALITY — easing off';
      if (d.regime === 'catchup') return 'BEHIND — catching up';
      if (d.skipRollUntilM > d.simDistM) return 'ROLLING through skipped stop';
      if (d.vAllowedKmh != null && d.cruiseCapKmh != null && d.vAllowedKmh < d.cruiseCapKmh - 1)
        return 'BRAKING for curve / stop';
      return 'TRACKING the predictor';
    default:
      return 'NO SIM (raw dot — no geometry)';
  }
}

/** Active holds/regimes, plain words + numbers, most-urgent first. */
function activeNotes(d: SimDebugInfo, nowMs: number): string[] {
  const out: string[] = [];
  if (d.stuckAtM !== null) out.push(`stuck-hold @ ${num(d.stuckAtM)}m`);
  if (d.yieldHoldM !== null) out.push(`junction-yield → ${num(d.yieldHoldM)}m`);
  if (d.fixPinActive && d.fixStopDistM !== null) out.push(`fix-pin @ ${num(d.fixStopDistM)}m`);
  if (d.phase === 'dwell' && d.dwellUntilMs > 0) {
    const left = d.dwellUntilMs - nowMs;
    out.push(left > 0 ? `dwell ${sec1(left)} left` : 'dwell (holding for fix)');
  }
  if (d.regime != null && d.regime !== 'track') out.push(d.regime);
  if (d.skipRollUntilM > d.simDistM) out.push('skip-roll');
  if (d.lastTeleportMs > 0 && nowMs - d.lastTeleportMs < 4_000) {
    out.push(`teleport ${sec1(nowMs - d.lastTeleportMs)} ago`);
  }
  return out;
}

// ── guide mode ───────────────────────────────────────────────────────────────
//
// Every row knows how to explain ITSELF. `GUIDE_SECTIONS` is the single source
// of truth — it pairs each row's label (exactly as the live readout renders it)
// with a plain sentence. `Row` looks its own label up, so a label can never
// drift away from its documentation, and guide mode renders the sections
// directly without duplicating the list.
//
// Sources: docs/decisions/interpolation-engine.md (the engine's decision record)
// and src/lib/engine/{tramSim,speedProfile}.ts.

interface GuideSection {
  title: string;
  /** [row label exactly as rendered live, plain-English explanation]. */
  rows: [string, string][];
}

const GUIDE_SECTIONS: GuideSection[] = [
  {
    title: 'SPEED',
    rows: [
      ['sim', 'How fast the simulated tram is actually moving right now.'],
      [
        'cruise target',
        'The speed the controller is aiming for: the track cruise reference (42 km/h) scaled by the catch-up factor, this car’s learned pace bias and the time-of-day factor.',
      ],
      [
        'vAllowed (envelope)',
        'The hard braking envelope — the fastest you may go here and still stop at 1.2 m/s² for every limit within 400 m. Pace NEVER multiplies this; it is what stops a late tram sailing into a platform.',
      ],
      ['cruiseCap', 'Track speed limit at this point: the lower of the zone cap and the curve cap.'],
      [
        'zone cap',
        'Network default 50 km/h, dropping to 31 km/h inside the city-centre box during the day (07:00–19:00).',
      ],
      [
        'curve cap',
        'Speed limit from the rail curvature — slow enough that lateral acceleration stays comfortable, times a 0.85 realism factor. R is the curve radius; small R = tight curve.',
      ],
      [
        'κ · bias · tod',
        'Curvature (rad/m) · this car’s learned pace multiplier (1 = profile pace) · the time-of-day factor (peaks slow, nights fast).',
      ],
    ],
  },
  {
    title: 'ERROR (m)',
    rows: [
      [
        'e = tgt−sim',
        'Target minus simulated position. Positive = the sim is BEHIND where it should be and will catch up; negative = ahead, and it will ease off.',
      ],
      [
        'lag  sim−real',
        'The honest one: simulated position minus YOUR GPS position along the line. Positive = the app is drawing the tram ahead of the one you are sitting in.',
      ],
      ['sim−golemio', 'Simulated position minus the last real AVL fix, dead-reckoned forward.'],
      ['real−golemio', 'Your GPS position minus the AVL fix — how stale or wrong the feed itself is.'],
      [
        'deviation |sim−obs|',
        'Unsigned sim-vs-observation gap — the number the tram card shows as “sim offset”.',
      ],
    ],
  },
  {
    title: 'POSITIONS (m along shape)',
    rows: [
      ['target', 'Where the controller currently wants the tram to be.'],
      ['golemio fix (obs)', 'Last real reported position from the AVL feed, as metres along the shape.'],
      ['projection (live)', 'That fix dead-reckoned forward to now — what “Live” position mode draws.'],
      [
        'real (GPS filt)',
        'Your filtered GPS projected onto the tram’s shape. Ground truth: you are physically in this tram.',
      ],
      ['real (GPS raw)', 'The same, unfiltered — compare with the filtered value to see the filter working.'],
      [
        'minStopDist',
        'Stops closer than this are ignored by the braking envelope, so an already-served stop cannot pin the tram in place.',
      ],
    ],
  },
  {
    title: 'HOLDS / REGIME',
    rows: [
      ['fix-pin', 'The feed says the tram is standing at a stop, so the sim is pinned there instead of rolling on.'],
      ['stuck @', 'The tram has not moved between fixes (jam or a long light), so the sim holds at that distance.'],
      ['yield hold @', 'Holding short of a junction to let the crossing movement clear.'],
      ['dwell left', 'Time remaining in the boarding dwell at the current stop.'],
      [
        'regime',
        'How the smooth marker chases the predictor: track (in-band), catchup (behind, bounded by observed free-running pace), yield (ahead, easing off), hold-follow (reality is standing — close onto it and stand too).',
      ],
      [
        'teleport ago',
        'How long since the sim was hard-snapped to a fix — the last resort when it is hopelessly wrong.',
      ],
    ],
  },
  {
    title: 'NEXT STOP / SCHEDULE',
    rows: [
      ['name', 'Next stop ahead of the simulated position.'],
      ['dist', 'Along-shape distance from the sim to that stop.'],
      ['eta', 'Estimated seconds to it at the current pace.'],
      ['delay', 'Schedule delay reported by the feed. Positive = late.'],
      [
        'state / phase',
        'Feed-reported state, then the sim’s own phase: cruise, dwell (at a stop), terminal (end of trip), or unknown (no geometry — raw dot only).',
      ],
      [
        'fix age (lat-adj)',
        'Age of the last fix, and in brackets the latency-adjusted age the controller actually uses.',
      ],
    ],
  },
  {
    title: 'GPS ON-LINE',
    rows: [
      ['watch', 'Whether the phone’s location watch is running. Every “real” row above needs it.'],
      ['accuracy', 'GPS horizontal accuracy. Above roughly 30 m the lag numbers get noisy.'],
      ['gps / filt speed', 'Raw GPS speed, then the filtered speed the projection uses.'],
      [
        'offset filt / raw',
        'How far off the rail your GPS is — filtered, then raw. Large values mean the projection is guessing.',
      ],
      ['filter', 'Whether the last fix was accepted, or why the outlier filter rejected it.'],
      ['gps fix age', 'How long since the last accepted GPS fix.'],
    ],
  },
];

/** Flattened label → explanation lookup used by `Row` in guide mode. */
const GUIDE: Record<string, string> = Object.fromEntries(GUIDE_SECTIONS.flatMap((s) => s.rows));

const PRIMER: [string, string][] = [
  [
    'THE PROBLEM',
    'The feed reports each tram only every ~20 s, and those positions are already seconds old. Everything you see moving is simulated between fixes.',
  ],
  [
    'ONE NUMBER',
    'Each tram is simulated as a single distance along its route polyline, so it is always exactly on the rails and can never reverse or cut a corner.',
  ],
  [
    'SPEED',
    'The predictor estimates the REAL tram: it cruises at its learned pace under the braking envelope. The smooth marker then chases the predictor. The envelope always wins, which is why a late tram still brakes properly into stops.',
  ],
  [
    'CATCH-UP',
    'The smoother compares the predictor position with its own (that is "errPred"). Behind → it speeds up, bounded by observed free-running pace; ahead → it eases off; reality standing → it closes onto the platform and stands too. It never jumps unless hopelessly wrong, which shows up as a teleport.',
  ],
  [
    'HOLDS',
    'Stops, jams, junctions and departures are modelled as explicit holds. The HOLDS section names whichever one is active and the number it is holding at.',
  ],
  [
    'GROUND TRUTH',
    'While you ride, your own GPS is projected onto the same line. "lag sim−real" is then the real error: positive means the app is drawing the tram ahead of the one you are in.',
  ],
];

/** True while the panel is showing explanations instead of live values. */
const GuideContext = createContext(false);

// ── rows ─────────────────────────────────────────────────────────────────────

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  const guide = useContext(GuideContext);
  if (guide) {
    return (
      <View style={styles.guideRow}>
        <Text style={styles.guideLabel}>{label}</Text>
        <Text style={styles.guideHelp}>{GUIDE[label] ?? '(undocumented)'}</Text>
      </View>
    );
  }
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, warn && styles.valueWarn]}>{value}</Text>
    </View>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <Text style={styles.section}>{children}</Text>;
}

// ── component ────────────────────────────────────────────────────────────────

/** collapsed → one summary line · live → the readout · guide → what it all means. */
type DebugMode = 'collapsed' | 'live' | 'guide';

export function DebugOverlay() {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const followKey = useSelectionStore((s) => s.followTramKey);
  const selectedKey = useSelectionStore((s) => s.selectedTramKey);
  const positionMode = useSettingsStore((s) => s.positionMode);
  const key = followKey ?? selectedKey;
  // 1 Hz — the header only needs line + model, not a per-frame read.
  const state = useTramState(key);
  const [mode, setMode] = useState<DebugMode>('live');
  const collapsed = mode === 'collapsed';
  const guide = mode === 'guide';
  // Native CFBundleVersion proves which binary is installed on the device.
  const buildNumber = Constants.platform?.ios?.buildNumber ?? '?';

  const header = key
    ? `DBG ${key}${state ? ` · L${state.snapshot.line} · ${state.model.id}` : ''}`
    : 'DEBUG — no tram followed';

  // A compact command deck across the top. It deliberately overlays the app's
  // normal chrome: debug mode owns this band, rather than forcing the map UI to
  // reflow around a diagnostic tool.
  const maxPanelH = Math.min(224, Math.round(windowHeight * 0.28));

  return (
    <View
      style={[styles.wrap, { top: insets.top + 4, maxHeight: maxPanelH }]}
      pointerEvents="box-none"
    >
      <View style={[styles.panel, { maxHeight: maxPanelH }]}>
        <View style={styles.headerRow}>
          <Pressable
            onPress={() => setMode(collapsed ? 'live' : 'collapsed')}
            style={styles.headerTap}
            accessibilityRole="button"
            accessibilityLabel="Collapse or expand the debug overlay"
          >
            <Text style={styles.header} numberOfLines={1}>
              {header}
            </Text>
          </Pressable>
          <View style={styles.legend} pointerEvents="none">
            <Text style={[styles.legendText, styles.legendFix]}>
              ● FIX{positionMode === 'raw' ? '*' : ''}
            </Text>
            <Text style={[styles.legendText, styles.legendLive]}>
              ● LIVE{positionMode === 'live' ? '*' : ''}
            </Text>
            <Text style={[styles.legendText, styles.legendSmooth]}>
              ● SMOOTH{positionMode === 'smooth' ? '*' : ''}
            </Text>
          </View>
          <Text style={styles.buildNumber}>B{buildNumber}</Text>
          {/* Guide mode: swaps every live value for a sentence explaining what
              that variable means, plus a primer on how the engine works. */}
          <Pressable
            onPress={() => setMode(guide ? 'live' : 'guide')}
            style={styles.hintTap}
            accessibilityRole="button"
            accessibilityLabel={guide ? 'Show live values' : 'Explain these values'}
          >
            <Text style={[styles.hint, guide && styles.hintActive]}>{guide ? '↩' : '?'}</Text>
          </Pressable>
          <Pressable
            onPress={() => setMode(collapsed ? 'live' : 'collapsed')}
            style={styles.hintTap}
            accessibilityRole="button"
            accessibilityLabel="Collapse or expand the debug overlay"
          >
            <Text style={styles.hint}>{collapsed ? '▸' : '▾'}</Text>
          </Pressable>
        </View>

        {!key && !guide && (
          <Text style={styles.note}>Tap a tram and Follow it to inspect its physics.</Text>
        )}

        {key && collapsed && <DebugCollapsed tramKey={key} />}

        {!collapsed && guide && <DebugGuide />}

        {key && !collapsed && !guide && <DebugLive tramKey={key} />}
      </View>
    </View>
  );
}

/**
 * The collapsed one-liner: nothing here changes faster than the engine's own
 * phase, so it reads at 1 Hz and holds NO GPS watch (the `lag` figure was the
 * only value that needed one — it lives in the expanded readout).
 */
function DebugCollapsed({ tramKey }: { tramKey: string }) {
  const [dbg, setDbg] = useState<SimDebugInfo | undefined>(undefined);

  useEffect(() => {
    const read = () => setDbg(getRuntime().engine.getDebugInfo(tramKey, Date.now()));
    read();
    const id = setInterval(read, 1_000);
    return () => clearInterval(id);
  }, [tramKey]);

  return (
    <Text style={styles.collapsed} numberOfLines={1}>
      {dbg ? phaseLabel(dbg) : '…'} · {num(dbg?.simSpeedKmh, 0)} km/h
    </Text>
  );
}

/** Guide mode: static text only — no engine reads, no GPS, no loop. */
function DebugGuide() {
  return (
    <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
      <GuideContext.Provider value>
        <SectionTitle>HOW THE ENGINE WORKS</SectionTitle>
        {PRIMER.map(([title, body]) => (
          <View key={title} style={styles.guideRow}>
            <Text style={styles.guideLabel}>{title}</Text>
            <Text style={styles.guideHelp}>{body}</Text>
          </View>
        ))}
        <GuideBody />
      </GuideContext.Provider>
    </ScrollView>
  );
}

/**
 * The live readout — and the ONLY holder of the 10 Hz loop and the foreground
 * GPS watch. It is mounted solely for an expanded, non-guide panel with a tram
 * followed, which is the case the file header's perf exemption describes;
 * unmounting it releases the locator (stopping the watch) and clears the timer.
 */
function DebugLive({ tramKey }: { tramKey: string }) {
  const locator = useOnlineLocator();
  const [snap, setSnap] = useState<DebugSnapshot | null>(null);

  // Numeric diagnostics update at 10 Hz. The old display-rate loop
  // forced a complete React card/text reconciliation at display rate even
  // though the values are formatted to 0–2 decimals. This timer is owned by
  // the mounted live panel and cleared immediately on collapse/guide/debug-off.
  useEffect(() => {
    const read = () => setSnap(buildSnapshot(tramKey, locator));
    read();
    const id = setInterval(read, DEBUG_LIVE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [tramKey, locator]);

  // Pre-first-sample fallback only (the timer stamps every later nowMs): the
  // shared 1 Hz clock, since Date.now() during render is an impure read.
  const clockNowMs = useNowMs();
  const nowMs = snap?.nowMs ?? clockNowMs;
  const dbg = snap?.dbg;
  const state = snap?.state;
  const fix = snap?.fix ?? null;
  const proj = snap?.proj ?? null;
  const realDistM = snap?.realDistM ?? null;
  const realRawDistM = snap?.realRawDistM ?? null;

  // Signed diffs (+ = sim ahead of the real tram).
  const lagM = dbg?.hasSim && realDistM != null ? dbg.simDistM - realDistM : null;
  const simVsObs = dbg?.hasSim ? dbg.simDistM - dbg.obsDistM : null;
  const realVsObs = realDistM != null && dbg ? realDistM - dbg.obsDistM : null;

  return (
    <ScrollView
      horizontal
      style={styles.scroll}
      contentContainerStyle={styles.liveDeck}
      showsHorizontalScrollIndicator={false}
    >
      {!dbg && <Text style={styles.note}>No state yet (waiting for a fix).</Text>}
      {dbg && (
        <>
          <View style={styles.debugCard}>
            <Text style={styles.phase}>{phaseLabel(dbg)}</Text>
            {!dbg.hasSim && <Text style={styles.note}>Raw AVL only — geometry pending.</Text>}
            <SectionTitle>MOTION</SectionTitle>
            <Row label="sim" value={`${num(dbg.simSpeedKmh, 1)} km/h`} />
            <Row label="target" value={`${num(dbg.cruiseTargetKmh, 1)} km/h`} />
            <Row label="allowed / cruise" value={`${num(dbg.vAllowedKmh, 0)} / ${num(dbg.cruiseCapKmh, 0)}`} />
            <Row label="zone / curve" value={`${num(dbg.zoneCapKmh, 0)} / ${num(dbg.curveCapKmh, 0)}`} />
            <Row label="bias · tod" value={`${num(dbg.paceBias, 2)} · ${num(dbg.todPaceFactor, 2)}`} />
          </View>

          <View style={styles.debugCard}>
            <SectionTitle>TRACKING Δm</SectionTitle>
            <Row label="target−smooth" value={signed(dbg.errPredM)} warn={dbg.errPredM != null && Math.abs(dbg.errPredM) > 60} />
            <Row label="smooth−rider" value={signed(lagM)} warn={lagM != null && Math.abs(lagM) > 60} />
            <Row label="smooth−fix" value={signed(simVsObs)} />
            <Row label="rider−fix" value={signed(realVsObs)} />
            <Row label="smooth" value={num(dbg.simDistM)} />
            <Row label="live / fix" value={`${num(dbg.projDistM)} / ${num(dbg.obsDistM)}`} />
            <Row label="rider filt / raw" value={`${num(realDistM)} / ${num(realRawDistM)}`} />
          </View>

          <View style={styles.debugCard}>
            <SectionTitle>REGIME</SectionTitle>
            <Text style={styles.notes}>{activeNotes(dbg, nowMs).join(' · ') || 'free cruise'}</Text>
            <Row label="fix pin" value={dbg.fixStopDistM != null ? `@${num(dbg.fixStopDistM)} ${dbg.fixPinActive ? 'ON' : 'stale'}` : '—'} />
            <Row label="stuck / yield" value={`${num(dbg.stuckAtM)} / ${num(dbg.yieldHoldM)}`} />
            <Row label="regime" value={dbg.regime ?? '—'} />
            <Row label="dwell left" value={dbg.phase === 'dwell' ? sec1(dbg.dwellUntilMs - nowMs) : '—'} />
            <Row label="teleport ago" value={dbg.lastTeleportMs > 0 ? sec1(nowMs - dbg.lastTeleportMs) : '—'} />
          </View>

          <View style={styles.debugCard}>
            <SectionTitle>NEXT / DEVICE GPS</SectionTitle>
            <Row label="stop" value={state?.nextStopName ?? '—'} />
            <Row label="distance / eta" value={`${num(snap?.nextStopDistM)}m / ${num(state?.nextStopEtaS)}s`} />
            <Row label="delay" value={`${signed(dbg.delaySeconds)}s`} />
            <Row label="AVL age" value={`${sec1(dbg.fixAgeMs)} (${sec1(dbg.staleFixAgeMs)})`} />
            <Row label="GPS watch" value={snap?.watchActive ? (fix ? 'live' : 'starting') : (snap?.watchError ?? 'off')} warn={!snap?.watchActive} />
            <Row label="accuracy" value={fix?.accuracyM != null ? `${num(fix.accuracyM)}m` : '—'} warn={fix?.accuracyM != null && fix.accuracyM > 30} />
            <Row label="track offset" value={`${num(proj?.fOffM, 1)} / ${num(proj?.gpsOffM, 1)}m`} />
          </View>
        </>
      )}
    </ScrollView>
  );
}

/**
 * Guide mode's body: the SAME sections and labels as the live readout, rendered
 * from GUIDE_SECTIONS. `Row` swaps the value for the explanation via context, so
 * there is exactly one list of labels in this file.
 */
function GuideBody() {
  return (
    <>
      {GUIDE_SECTIONS.map((section) => (
        <View key={section.title}>
          <SectionTitle>{section.title}</SectionTitle>
          {section.rows.map(([label]) => (
            <Row key={label} label={label} value="" />
          ))}
        </View>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 6,
    right: 6,
    zIndex: 1000,
  },
  panel: {
    backgroundColor: 'rgba(8,10,14,0.88)',
    borderColor: 'rgba(120,200,255,0.35)',
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  // Bounded by the panel's own maxHeight (screen-derived), NOT a fixed cap —
  // the old maxHeight:520 silently cut off the GPS section on every device.
  scroll: { flexShrink: 1 },
  liveDeck: { gap: 7, paddingBottom: 2 },
  debugCard: {
    backgroundColor: 'rgba(23,31,40,0.82)',
    borderColor: 'rgba(120,200,255,0.18)',
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 7,
    paddingBottom: 6,
    width: 236,
  },
  headerRow: { alignItems: 'center', flexDirection: 'row' },
  headerTap: { flex: 1, justifyContent: 'center', minHeight: 44 },
  // 44×44 pt minimum touch target — the glyphs stay 11 pt, the box does not.
  hintTap: { alignItems: 'center', justifyContent: 'center', minHeight: 44, minWidth: 44 },
  hintActive: { color: '#FFD479' },
  // Guide mode: label above, explanation wrapped beneath it (full width).
  guideRow: { marginBottom: 7 },
  guideLabel: { color: '#6BE6A6', fontFamily: MONO, fontSize: 10.5, fontWeight: '700' },
  guideHelp: { color: '#C6D2DE', fontFamily: MONO, fontSize: 10, lineHeight: 13.5, marginTop: 1 },
  header: { color: '#6BE6A6', flex: 1, fontFamily: MONO, fontSize: 11, fontWeight: '700' },
  legend: { flexDirection: 'row', gap: 6, marginHorizontal: 8 },
  legendText: { fontFamily: MONO, fontSize: 9, fontWeight: '800' },
  legendFix: { color: '#FF4FA3' },
  legendLive: { color: '#B7FF4A' },
  legendSmooth: { color: '#4DDBFF' },
  buildNumber: {
    color: '#FFD479',
    fontFamily: MONO,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
    fontWeight: '800',
  },
  hint: { color: '#7FB2D9', fontFamily: MONO, fontSize: 11 },
  collapsed: { color: '#DDE6EE', fontFamily: MONO, fontSize: 10.5, marginTop: 3 },
  phase: { color: '#FFD479', fontFamily: MONO, fontSize: 11, fontWeight: '700', marginTop: 4 },
  section: {
    color: '#7FB2D9',
    fontFamily: MONO,
    fontSize: 9.5,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 1,
    marginTop: 7,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 0.5 },
  label: { color: '#9AA7B4', fontFamily: MONO, fontSize: 10.5, flexShrink: 0 },
  value: { color: '#EAF1F7', fontFamily: MONO, fontSize: 10.5, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  valueWarn: { color: '#FF8F6B' },
  notes: { color: '#EAF1F7', fontFamily: MONO, fontSize: 10.5 },
  note: { color: '#9AA7B4', fontFamily: MONO, fontSize: 10, marginTop: 4 },
});
