// DEBUG OVERLAY — a live, utilitarian technical readout of the physics for
// the followed tram, drawn over the map when Settings ▸ Developer ▸ Debug mode
// is on. Deliberately NOT styled to the app's guidelines: dense monospace rows,
// lots of raw numbers — built to evaluate the physics from inside a real tram.
//
// UPDATE CADENCE — 10 Hz, but ONLY in the live readout. Debug mode is EXEMPT
// from the app's ≤1 Hz perf invariant exactly where the claim holds:
// `DebugLive` (rendered solely for the followed tram, expanded, not in guide
// mode) re-reads the fleet on a private 100 ms timer. Numeric text cannot make
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
//   • fleet.getDiagnostics(key) — the physics v3 readout: which curve is being
//     drawn, BOTH curves' positions and the signed gap between them, how much
//     horizon is left, how old the anchor/emission/bundle are, the clock offset
//     and the connection verdict;
//   • fleet.getState(key)       — next stop + ETA, delay, raw fix;
//   • runtime.physicsHealth     — fleet-wide fetch health (vehicles in the
//     bundle, consecutive failures, discontinuity count);
//   • OnlineLocator             — the rider's filtered GPS projected onto the
//     followed tram's shape = the REAL on-line position (ground truth: the
//     rider is physically in this tram).
//
// Diffs are signed: POSITIVE lag = the RENDERED tram is AHEAD of the real one.
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
import { genFromGenerator, type TrajectoryHealth } from '@/lib/physics/trajectoryStore';
import { Fonts } from '@/constants/theme';
import {
  projectOnlineDistAt,
  projectOnlineFix,
  useOnlineLocator,
  type OnlineFix,
  type OnlineLocator,
  type OnlineProjection,
} from '@/lib/motionlog';
import type { PhysicsDebugInfo, TramPublicState } from '@/lib/types';
import { useSelectionStore } from '@/stores/selection';
import { useSettingsStore, type PhysicsEngine } from '@/stores/settings';

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

// ── live snapshot (rebuilt at 10 Hz) ─────────────────────────────────────────

interface DebugSnapshot {
  nowMs: number;
  dbg: PhysicsDebugInfo | undefined;
  state: TramPublicState | undefined;
  /** Fleet-wide trajectory/fetch health (same for every tram). */
  health: TrajectoryHealth;
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
  const runtime = getRuntime();
  const fleet = runtime.fleet;
  const dbg = key ? fleet.getDiagnostics(key, nowMs) : undefined;
  const state = key ? fleet.getState(key, nowMs) : undefined;
  const geometry = key ? fleet.getGeometry(key) : undefined;
  const fix = locator.latest();
  const proj = fix ? projectOnlineFix(fix, geometry) : null;
  const baseReal = proj ? (proj.fDistM ?? proj.gpsDistM) : null;
  const realDistM = projectOnlineDistAt(baseReal, fix, nowMs);
  const realRawDistM = proj ? proj.gpsDistM : null;

  let nextStopDistM: number | null = null;
  if (geometry && dbg) {
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
    health: runtime.physicsHealth,
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

/**
 * Human-readable headline. The frozen states come FIRST: a tram standing still
 * because the curve ran out must never be mistaken for one standing at a stop.
 */
function phaseLabel(d: PhysicsDebugInfo): string {
  if (!d.hasGeometry) return 'NO GEOMETRY (raw dot — shape pending)';
  if (!d.hasTrajectory) return 'NO CURVES — frozen on the last raw fix';
  if (d.pastHorizon) return 'PAST HORIZON — frozen (no data beyond here)';
  switch (d.phase) {
    case 'terminal':
      return 'AT TERMINAL (end of trip)';
    case 'dwell':
      return 'STANDING AT A STOP';
    case 'cruise':
      return d.mode === 'smooth' ? 'RUNNING (smooth curve)' : 'RUNNING (fixed curve)';
    default:
      return 'NO PHASE (no geometry)';
  }
}

/** Whatever is currently notable about this tram, most-urgent first. */
function activeNotes(d: PhysicsDebugInfo): string[] {
  const out: string[] = [];
  if (d.connection !== 'live') out.push(d.connection.toUpperCase());
  if (!d.hasTrajectory) out.push('no published curves');
  else if (d.pastHorizon) out.push('frozen past horizon');
  if (d.discontinuity) out.push('discontinuity flagged');
  if (d.deltaM != null && Math.abs(d.deltaM) >= 1) {
    out.push(`smooth ${d.deltaM >= 0 ? 'ahead of' : 'behind'} fixed by ${num(Math.abs(d.deltaM), 1)}m`);
  }
  if (d.horizonLeftS != null && d.horizonLeftS < 15) {
    out.push(`horizon ${num(d.horizonLeftS, 1)}s left`);
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
// Sources: docs/research/physics-v3-protocol.md (the frozen client/server
// contract) and src/lib/physics/*.

interface GuideSection {
  title: string;
  /** [row label exactly as rendered live, plain-English explanation]. */
  rows: [string, string][];
}

const GUIDE_SECTIONS: GuideSection[] = [
  {
    title: 'CURVES',
    rows: [
      [
        'drawing',
        'Which published curve the map is currently showing: smooth (the continuity track) or fixed (the raw model opinion). The Settings switch picks it.',
      ],
      [
        'smooth',
        'Metres along the route on the SMOOTH curve. The server bakes the join between consecutive predictions into it, so it never teleports except at a flagged discontinuity.',
      ],
      [
        'fixed',
        'Metres along the route on the FIXED curve — the model’s raw opinion, which re-anchors on every fix and is allowed to jump to get there.',
      ],
      [
        'smooth−fixed',
        'The gap between the two curves right now. THIS is the number the whole comparison exists to produce: positive = the smooth curve is running ahead of the model’s opinion, negative = behind. Large values mean continuity is costing accuracy.',
      ],
      [
        'speed',
        'How fast the drawn tram is moving — measured from the curve itself (its slope over ±0.5 s), not modelled. Nothing on the client decides this.',
      ],
    ],
  },
  {
    title: 'HORIZON',
    rows: [
      [
        'horizon left',
        'Seconds of curve remaining. At zero the tram FREEZES where the data ended and dims — the client never animates beyond what the server predicted.',
      ],
      [
        'emission age',
        'How long ago the server published this trajectory. It is also the blend anchor: continuity is measured from this instant.',
      ],
      [
        'anchor age',
        'How old the AVL fix underneath these curves is. The curves are the server’s answer to "where is it now", given a fix this old.',
      ],
      ['AVL age', 'Age of the last raw reported position from the feed, independently of the curves.'],
      [
        'discontinuity',
        'Whether the server flagged THIS emission as a sanctioned break in continuity (trip change, or the model moved more than 150 m), plus how many have been seen this session. Smooth mode may jump once on a flagged emission; otherwise it must not.',
      ],
    ],
  },
  {
    title: 'CONNECTION',
    rows: [
      [
        'state',
        'live (bundle under 15 s), degraded (15–45 s — trams keep following their curves), or offline (over 45 s, or fetches failing — banner shown, trams freeze at the end of their curves).',
      ],
      [
        'bundle age',
        'Age of the newest trajectory bundle in server time. This — not "did the last fetch throw" — is what decides the state above, so a server answering 200 OK with stale data still reads as offline.',
      ],
      [
        'clock offset',
        'serverNow − this device’s clock, smoothed over the last few fetches. Every curve is evaluated at the CORRECTED time, which is what makes two phones draw identical trams.',
      ],
      ['vehicles', 'How many vehicles the newest bundle carried.'],
      ['fetch', 'Whether a fetch is in flight, or how many consecutive attempts have failed.'],
    ],
  },
  {
    title: 'RIDER GPS (m)',
    rows: [
      [
        'smooth−rider',
        'The honest one: the drawn position minus YOUR GPS position along the line. Positive = the app is drawing the tram ahead of the one you are sitting in.',
      ],
      ['smooth−fix', 'Drawn position minus the last real AVL fix.'],
      ['rider−fix', 'Your GPS position minus the AVL fix — how stale or wrong the feed itself is.'],
      [
        'rider filt / raw',
        'Your filtered GPS projected onto the shape, then the unfiltered value — compare them to see the outlier filter working.',
      ],
      ['GPS watch', 'Whether the phone’s location watch is running. Every rider row above needs it.'],
      ['accuracy', 'GPS horizontal accuracy. Above roughly 30 m the lag numbers get noisy.'],
      [
        'track offset',
        'How far off the rail your GPS is — filtered, then raw. Large values mean the projection is guessing.',
      ],
    ],
  },
  {
    title: 'NEXT STOP',
    rows: [
      ['stop', 'Next stop ahead of the drawn position.'],
      [
        'distance / eta',
        'Along-shape distance to it, then when the SMOOTH curve crosses that distance. The ETA is blank past the horizon — beyond the data we genuinely do not know.',
      ],
      ['delay', 'Schedule delay reported by the feed. Positive = late.'],
      [
        'state / phase',
        'Feed-reported state, then the derived phase: cruise, dwell (standing within 30 m of a stop), terminal (the last one), or unknown (no curves or no geometry).',
      ],
    ],
  },
];

/** Flattened label → explanation lookup used by `Row` in guide mode. */
const GUIDE: Record<string, string> = Object.fromEntries(GUIDE_SECTIONS.flatMap((s) => s.rows));

const PRIMER: [string, string][] = [
  [
    'THE PROBLEM',
    'The feed reports each tram only every ~20 s, and those positions are already seconds old. Everything you see moving between fixes has to be predicted.',
  ],
  [
    'WHO PREDICTS',
    'The SERVER does, for the whole fleet, every 5 s. It publishes each tram’s next ~120 seconds as a short list of (time, metres-along-route) keyframes. The app downloads one bundle for all trams.',
  ],
  [
    'WHAT THE APP DOES',
    'Almost nothing: it finds the two keyframes around "now", interpolates between them, and places that distance on the route polyline. No simulation, no controllers, no state — which is why the tram is always exactly on the rails and why backgrounding the app needs no catch-up.',
  ],
  [
    'TWO CURVES',
    'Each tram gets two: SMOOTH (continuity baked in — never teleports) and FIXED (the model’s raw opinion — re-anchors on every fix and jumps). The map draws one; this overlay always shows both, and their gap is the "smooth−fixed" number.',
  ],
  [
    'ONE CLOCK',
    'Curves are stamped in the server’s time, so the app measures its own clock error and evaluates at the corrected instant. Two phones with different clocks therefore draw the same tram in the same place.',
  ],
  [
    'HONESTY',
    'When the data stops arriving the trams follow their curves to the end and then FREEZE, dimmed, behind an explicit banner. Nothing is ever animated beyond what the server actually predicted.',
  ],
  [
    'GROUND TRUTH',
    'While you ride, your own GPS is projected onto the same line. "smooth−rider" is then the real error: positive means the app is drawing the tram ahead of the one you are in.',
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

/** Header-band abbreviations for the physics generation (the band is tight). */
const GEN_SHORT: Record<PhysicsEngine, string> = {
  current: 'cur',
  v3: 'v3',
  mix: 'mix',
};

/**
 * The active-generation readout, derived from the BUNDLE's `generator` field
 * rather than the setting that asked for it.
 *
 * The distinction is the whole point of the row. A `gen` the server does not
 * recognise is deliberately served the published bundle instead of an error,
 * so a client that printed its own request would show a confident "v3" while
 * rendering current physics — the one failure this readout exists to catch.
 * When the two disagree the row says so and warns; with no bundle yet (the
 * moment after a swap) it shows what is being waited for, which is not a fault.
 */
function genReadout(health: TrajectoryHealth): { value: string; warn: boolean } {
  if (health.bundleAgeS == null) return { value: `— want ${health.gen}`, warn: false };
  const confirmed = genFromGenerator(health.serverGen);
  const served = health.serverGen ?? 'published';
  if (confirmed !== health.gen) return { value: `${served} ≠ want ${health.gen}`, warn: true };
  return { value: served, warn: confirmed !== 'current' };
}

export function DebugOverlay() {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const followKey = useSelectionStore((s) => s.followTramKey);
  const selectedKey = useSelectionStore((s) => s.selectedTramKey);
  const positionMode = useSettingsStore((s) => s.positionMode);
  const physicsEngine = useSettingsStore((s) => s.physicsEngine);
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
          {/* Matches the in-world traces (DebugMapTraces). `*` marks the curve
              the map is actually drawing; FIX never gets one — no render mode
              shows the raw fix, and claiming otherwise would be a lie. */}
          <View style={styles.legend} pointerEvents="none">
            <Text style={[styles.legendText, styles.legendFix]}>● FIX</Text>
            <Text style={[styles.legendText, styles.legendFixed]}>
              ● FIXED{positionMode === 'fixed' ? '*' : ''}
            </Text>
            <Text style={[styles.legendText, styles.legendSmooth]}>
              ● SMOOTH{positionMode === 'smooth' ? '*' : ''}
            </Text>
          </View>
          {/* The REQUESTED generation — labelled `req:` because that is all it
              is. This band is the only part of the overlay visible while
              collapsed and with no tram followed, so it belongs here; what the
              server actually SERVED is on the CONNECTION card, read from the
              bundle. Never merge the two into one number. */}
          <Text
            style={[styles.genChip, physicsEngine !== 'current' && styles.genChipAlt]}
            numberOfLines={1}
          >
            req:{GEN_SHORT[physicsEngine]}
          </Text>
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
  const [dbg, setDbg] = useState<PhysicsDebugInfo | undefined>(undefined);

  useEffect(() => {
    const read = () => setDbg(getRuntime().fleet.getDiagnostics(tramKey, Date.now()));
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

  const dbg = snap?.dbg;
  const health = snap?.health;
  const fix = snap?.fix ?? null;
  const proj = snap?.proj ?? null;
  const realDistM = snap?.realDistM ?? null;
  const realRawDistM = snap?.realRawDistM ?? null;

  // Signed diffs (+ = the RENDERED tram is ahead of the real one).
  const lagM = dbg && realDistM != null ? dbg.simDistM - realDistM : null;
  const simVsObs = dbg ? dbg.simDistM - dbg.obsDistM : null;
  const realVsObs = realDistM != null && dbg ? realDistM - dbg.obsDistM : null;

  return (
    <ScrollView
      horizontal
      style={styles.scroll}
      contentContainerStyle={styles.liveDeck}
      showsHorizontalScrollIndicator={false}
    >
      {!dbg && <Text style={styles.note}>No state yet (waiting for a fix).</Text>}
      {dbg && health && (
        <>
          <View style={styles.debugCard}>
            <Text style={styles.phase}>{phaseLabel(dbg)}</Text>
            <SectionTitle>CURVES</SectionTitle>
            <Row label="drawing" value={dbg.mode} />
            <Row label="smooth" value={num(dbg.smoothDistM)} />
            <Row label="fixed" value={num(dbg.fixedDistM)} />
            <Row
              label="smooth−fixed"
              value={signed(dbg.deltaM, 1)}
              warn={dbg.deltaM != null && Math.abs(dbg.deltaM) > 80}
            />
            <Row label="speed" value={`${num(dbg.simSpeedKmh, 1)} km/h`} />
          </View>

          <View style={styles.debugCard}>
            <SectionTitle>HORIZON</SectionTitle>
            <Text style={styles.notes}>{activeNotes(dbg).join(' · ') || 'nominal'}</Text>
            <Row
              label="horizon left"
              value={dbg.horizonLeftS != null ? `${num(dbg.horizonLeftS, 1)}s` : '—'}
              warn={dbg.pastHorizon}
            />
            <Row label="emission age" value={dbg.emissionAgeS != null ? `${num(dbg.emissionAgeS, 1)}s` : '—'} />
            <Row label="anchor age" value={dbg.anchorAgeS != null ? `${num(dbg.anchorAgeS, 1)}s` : '—'} />
            <Row label="AVL age" value={`${num(dbg.fixAgeS, 1)}s`} />
            <Row label="discontinuity" value={`${dbg.discontinuity ? 'THIS' : 'no'} · ${dbg.discontinuitiesTotal} total`} />
          </View>

          <View style={styles.debugCard}>
            <SectionTitle>CONNECTION</SectionTitle>
            <Row
              label="state"
              value={dbg.connection}
              warn={dbg.connection !== 'live'}
            />
            <Row
              label="bundle age"
              value={dbg.bundleAgeS != null ? `${num(dbg.bundleAgeS, 1)}s` : 'none'}
              warn={dbg.bundleAgeS == null || dbg.bundleAgeS >= 15}
            />
            {/* Which generation built the bundle above — right next to its
                age, because after a swap the two are read together ("no
                bundle yet" is the swap, not a fault). Read from the payload,
                never from the setting: see genReadout. */}
            <Row label="engine gen" {...genReadout(health)} />
            <Row label="clock offset" value={`${signed(dbg.clockOffsetMs)}ms`} warn={health.clockImplausible} />
            <Row label="vehicles" value={num(health.vehicleCount)} />
            <Row
              label="fetch"
              value={health.consecutiveFailures > 0 ? `fail ×${health.consecutiveFailures}` : health.inFlight ? 'in flight' : 'ok'}
              warn={health.consecutiveFailures > 0}
            />
          </View>

          <View style={styles.debugCard}>
            <SectionTitle>RIDER GPS Δm</SectionTitle>
            <Row label="smooth−rider" value={signed(lagM)} warn={lagM != null && Math.abs(lagM) > 60} />
            <Row label="smooth−fix" value={signed(simVsObs)} />
            <Row label="rider−fix" value={signed(realVsObs)} />
            <Row label="rider filt / raw" value={`${num(realDistM)} / ${num(realRawDistM)}`} />
            <Row label="GPS watch" value={snap?.watchActive ? (fix ? 'live' : 'starting') : (snap?.watchError ?? 'off')} warn={!snap?.watchActive} />
            <Row label="accuracy" value={fix?.accuracyM != null ? `${num(fix.accuracyM)}m` : '—'} warn={fix?.accuracyM != null && fix.accuracyM > 30} />
            <Row label="track offset" value={`${num(proj?.fOffM, 1)} / ${num(proj?.gpsOffM, 1)}m`} />
          </View>

          <View style={styles.debugCard}>
            <SectionTitle>NEXT STOP</SectionTitle>
            <Row label="stop" value={dbg.nextStopName ?? '—'} />
            <Row label="distance / eta" value={`${num(snap?.nextStopDistM)}m / ${dbg.nextStopEtaS != null ? `${num(dbg.nextStopEtaS)}s` : '—'}`} />
            <Row label="delay" value={`${signed(dbg.delaySeconds)}s`} />
            <Row label="state / phase" value={`${dbg.statePosition} / ${dbg.phase}`} />
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
  legendFixed: { color: '#B7FF4A' },
  legendSmooth: { color: '#4DDBFF' },
  buildNumber: {
    color: '#FFD479',
    fontFamily: MONO,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
    fontWeight: '800',
  },
  // Muted while on the shipped engine, hot when the trams on screen are being
  // drawn by an experimental one — a screenshot should not need a caption.
  genChip: { color: '#7FB2D9', fontFamily: MONO, fontSize: 11, fontWeight: '800', marginRight: 6 },
  genChipAlt: { color: '#B7FF4A' },
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
