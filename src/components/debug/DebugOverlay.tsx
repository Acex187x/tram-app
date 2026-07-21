// DEBUG OVERLAY — a live, utilitarian technical readout of the simulation for
// the followed tram, drawn over the map when Settings ▸ Developer ▸ Debug mode
// is on. Deliberately NOT styled to the app's guidelines: dense monospace rows,
// lots of raw numbers — built to evaluate the physics from inside a real tram.
//
// UPDATE CADENCE — INSTANT (~60 fps). Debug mode is EXEMPT from the app's ≤1 Hz
// perf invariant: while mounted the overlay drives its OWN requestAnimationFrame
// loop and re-reads the engine every frame, so the panel tracks the 60 Hz
// physics with zero smoothing/throttle. (subscribeFrame drops to ~10 Hz at far
// zoom — a private rAF keeps the readout at display rate regardless.) The GPS
// on-line position is read every frame too and forward-extrapolated between the
// ~1 Hz foreground fixes (projectOnlineDistAt) so the "real" distance advances
// smoothly instead of stepping once a second. Re-rendering ~60×/s is fine here:
// one small panel, debug-only, mounted just for the followed tram.
//
// Data sources:
//   • engine.getDebugInfo(key) — raw INTERNAL sim state (phase, every speed &
//     cap, curvature, pace bias, the pace error, and every active hold with
//     numbers: fix-pin / stuck / junction-yield / crawl / burst / skip-roll /
//     dwell / teleport);
//   • engine.getState(key)     — next stop + ETA, delay, raw fix;
//   • OnlineLocator            — the rider's filtered GPS projected onto the
//     followed tram's shape = the REAL on-line position (ground truth: the
//     rider is physically in this tram).
//
// Diffs are signed: POSITIVE lag = the SIM is AHEAD of the real tram.
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getRuntime } from '@/hooks/tramData';
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

const MONO = Fonts?.mono ?? 'monospace';

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

/** Seconds, 0 decimals (from ms). */
function sec0(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  return (ms / 1000).toFixed(0) + 's';
}

// ── live snapshot (rebuilt every frame) ──────────────────────────────────────

interface DebugSnapshot {
  nowMs: number;
  dbg: SimDebugInfo | undefined;
  state: TramPublicState | undefined;
  fix: OnlineFix | null;
  proj: OnlineProjection | null;
  /** Filtered on-line distance, forward-extrapolated to now (smooth 60 fps). */
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
      if (d.deepCrawl) return 'FAR AHEAD — crawling (walking pace)';
      if (d.crawling) return 'AHEAD OF REALITY — easing off';
      if (d.burstActive) return 'DEPARTURE BURST (brisk exit)';
      if (d.skipRollActive) return 'ROLLING through skipped stop';
      if (d.errorM != null && d.errorM > 40) return 'BEHIND — catching up';
      if (d.vAllowedKmh != null && d.cruiseCapKmh != null && d.vAllowedKmh < d.cruiseCapKmh - 1)
        return 'BRAKING for curve / stop';
      return 'CRUISING';
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
  if (d.deepCrawl) out.push('deep-crawl');
  else if (d.crawling) out.push('soft-yield');
  if (d.burstActive) out.push('depart-burst');
  if (d.skipRollActive) out.push('skip-roll');
  if (d.lastTeleportMs > 0 && nowMs - d.lastTeleportMs < 4_000) {
    out.push(`teleport ${sec1(nowMs - d.lastTeleportMs)} ago`);
  }
  return out;
}

// ── rows ─────────────────────────────────────────────────────────────────────

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
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

export function DebugOverlay() {
  const insets = useSafeAreaInsets();
  const followKey = useSelectionStore((s) => s.followTramKey);
  const selectedKey = useSelectionStore((s) => s.selectedTramKey);
  const key = followKey ?? selectedKey;
  const locator = useOnlineLocator();
  const [collapsed, setCollapsed] = useState(false);
  const [snap, setSnap] = useState<DebugSnapshot | null>(null);

  // Instant ~60 fps loop: re-read the engine + GPS every frame while mounted.
  // Debug mode is exempt from the ≤1 Hz invariant (this whole component only
  // exists while Settings ▸ Debug is on). rAF is display-rate and self-cancels
  // when JS is suspended; the cleanup stops it the moment debug mode turns off.
  useEffect(() => {
    let raf = 0;
    let alive = true;
    const loop = () => {
      if (!alive) return;
      setSnap(buildSnapshot(key ?? null, locator));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [key, locator]);

  const nowMs = snap?.nowMs ?? Date.now();
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

  const header = key
    ? `DBG ${key}${state ? ` · L${state.snapshot.line} · ${state.model.id}` : ''}`
    : 'DEBUG — no tram followed';

  return (
    <View style={[styles.wrap, { top: insets.top + 4 }]} pointerEvents="box-none">
      <Pressable
        onPress={() => setCollapsed((c) => !c)}
        style={styles.panel}
        accessibilityRole="button"
        accessibilityLabel="Toggle debug overlay"
      >
        <View style={styles.headerRow}>
          <Text style={styles.header} numberOfLines={1}>
            {header}
          </Text>
          <Text style={styles.hint}>{collapsed ? '▸' : '▾'}</Text>
        </View>

        {!key && (
          <Text style={styles.note}>Tap a tram and Follow it to inspect its physics.</Text>
        )}

        {key && collapsed && (
          <Text style={styles.collapsed} numberOfLines={1}>
            {dbg ? phaseLabel(dbg) : '…'} · lag {signed(lagM)}m · {num(dbg?.simSpeedKmh, 0)}km/h
          </Text>
        )}

        {key && !collapsed && (
          <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
            {!dbg && <Text style={styles.note}>No state yet (waiting for a fix).</Text>}
            {dbg && (
              <>
                <Text style={styles.phase}>{phaseLabel(dbg)}</Text>
                {!dbg.hasSim && (
                  <Text style={styles.note}>
                    No geometry loaded — raw AVL only (no simulation).
                  </Text>
                )}

                <SectionTitle>SPEED</SectionTitle>
                <Row
                  label="sim"
                  value={`${num(dbg.simSpeedKmh, 1)} km/h  ${num(dbg.simSpeedMs, 2)} m/s`}
                />
                <Row label="cruise target" value={`${num(dbg.cruiseTargetKmh, 1)} km/h`} />
                <Row label="vAllowed (envelope)" value={`${num(dbg.vAllowedKmh, 1)} km/h`} />
                <Row label="cruiseCap" value={`${num(dbg.cruiseCapKmh, 1)} km/h`} />
                <Row label="zone cap" value={`${num(dbg.zoneCapKmh, 1)} km/h`} />
                <Row
                  label="curve cap"
                  value={`${num(dbg.curveCapKmh, 1)} km/h  R${
                    dbg.curveRadiusM != null ? num(dbg.curveRadiusM, 0) + 'm' : '∞'
                  }`}
                  warn={dbg.curveRadiusM != null && dbg.curveRadiusM < 120}
                />
                <Row
                  label="κ · bias · tod"
                  value={`${num(dbg.curveKappa, 3)} · ${num(dbg.paceBias, 2)} · ${num(
                    dbg.todPaceFactor,
                    2,
                  )}`}
                />

                <SectionTitle>ERROR (m)</SectionTitle>
                <Row
                  label="e = tgt−sim"
                  value={`${signed(dbg.errorM)} ${
                    dbg.errorM == null ? '' : dbg.errorM > 0 ? '(behind)' : '(ahead)'
                  }`}
                  warn={dbg.errorM != null && Math.abs(dbg.errorM) > 60}
                />
                <Row label="lag  sim−real" value={signed(lagM)} warn={lagM != null && Math.abs(lagM) > 60} />
                <Row label="sim−golemio" value={signed(simVsObs)} />
                <Row label="real−golemio" value={signed(realVsObs)} />
                <Row
                  label="deviation |sim−obs|"
                  value={state?.deviationM != null ? num(state.deviationM) : '—'}
                />

                <SectionTitle>POSITIONS (m along shape)</SectionTitle>
                <Row label="sim" value={num(dbg.simDistM)} />
                <Row label="target" value={num(dbg.targetDistM)} />
                <Row label="golemio fix (obs)" value={num(dbg.obsDistM)} />
                <Row label="projection (live)" value={num(dbg.projDistM)} />
                <Row label="real (GPS filt)" value={num(realDistM)} />
                <Row label="real (GPS raw)" value={num(realRawDistM)} />
                <Row label="minStopDist" value={num(dbg.minStopDistM)} />

                <SectionTitle>HOLDS / REGIME</SectionTitle>
                <Text style={styles.notes}>
                  {activeNotes(dbg, nowMs).join('  ·  ') || 'none — free cruise'}
                </Text>
                <Row
                  label="fix-pin"
                  value={
                    dbg.fixStopDistM != null
                      ? `@${num(dbg.fixStopDistM)}m ${dbg.fixPinActive ? 'ACTIVE' : 'stale'}`
                      : '—'
                  }
                />
                <Row label="stuck @" value={dbg.stuckAtM != null ? `${num(dbg.stuckAtM)}m` : '—'} />
                <Row
                  label="yield hold @"
                  value={dbg.yieldHoldM != null ? `${num(dbg.yieldHoldM)}m` : '—'}
                />
                <Row
                  label="dwell left"
                  value={
                    dbg.phase === 'dwell' && dbg.dwellUntilMs > 0
                      ? sec1(dbg.dwellUntilMs - nowMs)
                      : '—'
                  }
                />
                <Row
                  label="burst / skip-roll →"
                  value={`${dbg.burstActive ? num(dbg.burstUntilM) + 'm' : '—'} / ${
                    dbg.skipRollActive ? num(dbg.skipRollUntilM) + 'm' : '—'
                  }`}
                />
                <Row
                  label="crawl / deep"
                  value={`${dbg.crawling ? 'yes' : 'no'} / ${dbg.deepCrawl ? 'yes' : 'no'}`}
                />
                <Row
                  label="teleport ago"
                  value={dbg.lastTeleportMs > 0 ? sec1(nowMs - dbg.lastTeleportMs) : '—'}
                />

                <SectionTitle>NEXT STOP / SCHEDULE</SectionTitle>
                <Row label="name" value={state?.nextStopName ?? '—'} />
                <Row
                  label="dist"
                  value={snap?.nextStopDistM != null ? `${num(snap.nextStopDistM)} m` : '—'}
                />
                <Row
                  label="eta"
                  value={state?.nextStopEtaS != null ? `${num(state.nextStopEtaS)} s` : '—'}
                />
                <Row label="delay" value={`${signed(dbg.delaySeconds)} s`} />
                <Row label="state / phase" value={`${dbg.statePosition} / ${dbg.phase}`} />
                <Row label="fix age (lat-adj)" value={`${sec1(dbg.fixAgeMs)} (${sec1(dbg.staleFixAgeMs)})`} />

                <SectionTitle>GPS ON-LINE</SectionTitle>
                <Row
                  label="watch"
                  value={snap?.watchActive ? (fix ? 'live' : 'starting…') : (snap?.watchError ?? 'off')}
                  warn={!snap?.watchActive}
                />
                <Row
                  label="accuracy"
                  value={fix?.accuracyM != null ? `${num(fix.accuracyM, 0)} m` : '—'}
                  warn={fix?.accuracyM != null && fix.accuracyM > 30}
                />
                <Row
                  label="gps / filt speed"
                  value={`${fix?.speedMs != null ? num(fix.speedMs * 3.6, 1) : '—'} / ${
                    fix?.fSpeedMs != null ? num(fix.fSpeedMs * 3.6, 1) : '—'
                  } km/h`}
                />
                <Row
                  label="offset filt / raw"
                  value={`${proj?.fOffM != null ? num(proj.fOffM, 1) : '—'} / ${
                    proj?.gpsOffM != null ? num(proj.gpsOffM, 1) : '—'
                  } m`}
                />
                <Row label="filter" value={fix?.rej ? `REJECT ${fix.rej}` : 'accepted'} warn={!!fix?.rej} />
                <Row label="gps fix age" value={fix ? sec1(nowMs - fix.t) : '—'} />
              </>
            )}
          </ScrollView>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 6,
    // Narrow enough to leave the right-side map controls reachable.
    width: 236,
  },
  panel: {
    backgroundColor: 'rgba(8,10,14,0.88)',
    borderColor: 'rgba(120,200,255,0.35)',
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  scroll: { maxHeight: 520 },
  headerRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  header: { color: '#6BE6A6', flex: 1, fontFamily: MONO, fontSize: 11, fontWeight: '700' },
  hint: { color: '#7FB2D9', fontFamily: MONO, fontSize: 11, paddingLeft: 6 },
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
