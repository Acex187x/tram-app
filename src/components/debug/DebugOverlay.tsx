// DEBUG OVERLAY — a live, utilitarian technical readout of the simulation for
// the followed tram, drawn over the map when Settings ▸ Developer ▸ Debug mode
// is on. Deliberately NOT styled to the app's guidelines: dense monospace rows,
// lots of numbers — built to evaluate the physics from inside a real tram.
//
// Data sources (all read at ~1 Hz — never per frame; perf invariant #1):
//   • engine.getDebugInfo(key) — internal sim state (phase, speeds, caps,
//     pace bias, and every active hold: fix-pin / stuck / junction-yield /
//     ahead-crawl / departure-burst / skip-roll / dwell);
//   • engine.getState(key)     — next stop + ETA, delay, raw fix;
//   • OnlineLocator (useOnlineLocator) — the rider's filtered GPS projected
//     onto the followed tram's shape = the REAL on-line position. The rider is
//     physically in this tram, so that projection is the ground truth.
//
// Diffs are signed: POSITIVE lag = the SIM is AHEAD of the real tram.
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getRuntime } from '@/hooks/tramData';
import { Fonts } from '@/constants/theme';
import { projectOnlineFix, useOnlineLocator } from '@/lib/motionlog';
import type { SimDebugInfo, TramPublicState } from '@/lib/types';
import { useSelectionStore } from '@/stores/selection';

const MONO = Fonts?.mono ?? 'monospace';
/** Overlay refresh cadence — 1 Hz (perf: never the frame path). */
const TICK_MS = 1_000;

/** Force a ~1 Hz re-render so the panel re-reads live engine/GPS state. */
function useSecondTick(): void {
  const [, setN] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setN((n) => n + 1), TICK_MS);
    return () => clearInterval(iv);
  }, []);
}

function num(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

/** Signed value (leading + on non-negative) — for diffs where sign is meaning. */
function signed(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(digits);
}

function secs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  return (ms / 1000).toFixed(0) + 's';
}

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
      if (d.errorM != null && d.errorM > 40) return 'BEHIND — catching up';
      if (d.vAllowedKmh != null && d.cruiseCapKmh != null && d.vAllowedKmh < d.cruiseCapKmh - 1)
        return 'BRAKING for curve / stop';
      return 'CRUISING';
    default:
      return 'NO SIM (raw dot — no geometry)';
  }
}

/** Active holds/regimes, plain words, most-urgent first. */
function activeNotes(d: SimDebugInfo, nowMs: number): string[] {
  const out: string[] = [];
  if (d.stuckAtM !== null) out.push(`stuck-hold @ ${num(d.stuckAtM)} m`);
  if (d.yieldHoldM !== null) out.push(`junction-yield → ${num(d.yieldHoldM)} m`);
  if (d.fixPinActive && d.fixStopDistM !== null) out.push(`fix-pin @ stop ${num(d.fixStopDistM)} m`);
  if (d.phase === 'dwell' && d.dwellUntilMs > 0) {
    const left = d.dwellUntilMs - nowMs;
    out.push(left > 0 ? `dwell ends in ${secs(left)}` : 'dwell (holding for fix)');
  }
  if (d.deepCrawl) out.push('deep-crawl backstop');
  else if (d.crawling) out.push('soft-yield (ahead)');
  if (d.burstActive) out.push('departure burst');
  if (d.skipRollActive) out.push('rolling thru skipped stop');
  if (nowMs - d.lastTeleportMs < 4_000) out.push('recent teleport');
  return out;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <Text style={styles.section}>{children}</Text>;
}

export function DebugOverlay() {
  useSecondTick();
  const insets = useSafeAreaInsets();
  const followKey = useSelectionStore((s) => s.followTramKey);
  const selectedKey = useSelectionStore((s) => s.selectedTramKey);
  const key = followKey ?? selectedKey;
  const locator = useOnlineLocator();
  const [collapsed, setCollapsed] = useState(false);

  const nowMs = Date.now();
  const engine = getRuntime().engine;
  const dbg: SimDebugInfo | undefined = key ? engine.getDebugInfo(key, nowMs) : undefined;
  const state: TramPublicState | undefined = key ? engine.getState(key, nowMs) : undefined;
  const geometry = key ? engine.getGeometry(key) : undefined;
  const fix = locator.latest();
  const proj = fix ? projectOnlineFix(fix, geometry) : null;

  // The on-line (real) position: filtered GPS on shape, else raw GPS on shape.
  const realDistM = proj ? (proj.fDistM ?? proj.gpsDistM) : null;
  // Signed diffs (+ = sim ahead).
  const lagM = dbg?.hasSim && realDistM != null ? dbg.simDistM - realDistM : null;
  const simVsObs = dbg?.hasSim ? dbg.simDistM - dbg.obsDistM : null;
  const realVsObs = realDistM != null && dbg ? realDistM - dbg.obsDistM : null;

  const header = key
    ? `DBG ${key}${state ? ` · L${state.snapshot.line} · ${state.model.id}` : ''}`
    : 'DEBUG — no tram followed';

  return (
    <View
      style={[styles.wrap, { top: insets.top + 4 }]}
      pointerEvents="box-none"
    >
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
                    No geometry loaded — showing raw AVL only (no simulation).
                  </Text>
                )}

                <SectionTitle>PHYSICS</SectionTitle>
                <Row label="sim speed" value={`${num(dbg.simSpeedKmh, 1)} km/h`} />
                <Row
                  label="caps allow/cruise"
                  value={`${num(dbg.vAllowedKmh, 1)} / ${num(dbg.cruiseCapKmh, 1)} km/h`}
                />
                <Row label="pace bias" value={num(dbg.paceBias, 2)} />
                <Row
                  label="error e = tgt−sim"
                  value={`${signed(dbg.errorM)} m ${
                    dbg.errorM == null ? '' : dbg.errorM > 0 ? '(behind)' : '(ahead)'
                  }`}
                />

                <SectionTitle>HOLDS / REGIME</SectionTitle>
                <Text style={styles.notes}>
                  {activeNotes(dbg, nowMs).join('  ·  ') || 'none — free cruise'}
                </Text>

                <SectionTitle>NEXT STOP</SectionTitle>
                <Row label="name" value={state?.nextStopName ?? '—'} />
                <Row
                  label="eta"
                  value={state?.nextStopEtaS != null ? `${num(state.nextStopEtaS)} s` : '—'}
                />
                <Row label="delay" value={state ? `${signed(state.snapshot.delaySeconds)} s` : '—'} />
                <Row label="last fix age" value={secs(dbg.fixAgeMs)} />

                <SectionTitle>POSITIONS (m along shape)</SectionTitle>
                <Row label="sim" value={num(dbg.simDistM)} />
                <Row label="golemio fix (obs)" value={num(dbg.obsDistM)} />
                <Row label="projection (live)" value={num(dbg.projDistM)} />
                <Row label="real (GPS on shape)" value={num(realDistM)} />

                <SectionTitle>DIFFS (+ = sim ahead)</SectionTitle>
                <Row label="sim − real (lag)" value={`${signed(lagM)} m`} />
                <Row label="sim − golemio" value={`${signed(simVsObs)} m`} />
                <Row label="real − golemio" value={`${signed(realVsObs)} m`} />
                <Row
                  label="deviation |sim−obs|"
                  value={state?.deviationM != null ? `${num(state.deviationM)} m` : '—'}
                />

                <SectionTitle>ON-LINE GPS</SectionTitle>
                <Row
                  label="watch"
                  value={
                    locator.active()
                      ? fix
                        ? 'live'
                        : 'starting…'
                      : (locator.error() ?? 'off')
                  }
                />
                <Row label="accuracy" value={fix?.accuracyM != null ? `${num(fix.accuracyM, 0)} m` : '—'} />
                <Row
                  label="gps speed"
                  value={fix?.speedMs != null ? `${num(fix.speedMs * 3.6, 1)} km/h` : '—'}
                />
                <Row
                  label="filter offset"
                  value={proj?.fOffM != null ? `${num(proj.fOffM, 1)} m` : '—'}
                />
                <Row label="filter reject" value={fix?.rej ?? 'accepted'} />
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
    width: 232,
  },
  panel: {
    backgroundColor: 'rgba(8,10,14,0.86)',
    borderColor: 'rgba(120,200,255,0.35)',
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  scroll: { maxHeight: 460 },
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
  label: { color: '#9AA7B4', fontFamily: MONO, fontSize: 10.5 },
  value: { color: '#EAF1F7', fontFamily: MONO, fontSize: 10.5, fontWeight: '600' },
  notes: { color: '#EAF1F7', fontFamily: MONO, fontSize: 10.5 },
  note: { color: '#9AA7B4', fontFamily: MONO, fontSize: 10, marginTop: 4 },
});
