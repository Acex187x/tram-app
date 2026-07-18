// Tram sheet header — the "portrait card" top of the tram detail sheet.
// Left: line badge inline with the headsign, model + reg line, and ONE quiet
// caption row that merges what used to be two white pills + the deviation line
// (freshness · delay · sim honesty). Right: the model's TramFace portrait in a
// clear-glass squircle — tapping it opens the full-screen 3D viewer (the
// established face → 3D entry, ux-screens §9). Below: a single 38pt segmented
// glass capsule with the remaining actions (Favorite | Line N | About).
//
// The delay is deliberately demoted: plain text, grey while on time, tinted
// only when meaningfully late (>60 s), and it re-earns a small filled pill only
// past 180 s — big delays deserve attention even in a quiet layout. Under width
// pressure the sim-offset fragment truncates first; freshness and delay never do.
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { TramFace } from '@/components/tram/TramFace';
import { AcSnowflake } from '@/components/tram/TramModelImage';
import { delayColor, delayLabel } from '@/components/ui/DelayPill';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { LineBadge } from '@/components/ui/LineBadge';
import { Colors, Tram } from '@/constants/theme';
import type { TramPublicState } from '@/lib/types';
import { useSettingsStore } from '@/stores/settings';

// ── live caption ─────────────────────────────────────────────────────────────

/** Now-ms ticking every second, for the "updated Ns ago" freshness label. */
function useNowTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** '8 s' / '2 m' age label for the last real AVL observation. */
function fmtAge(ageS: number): string {
  if (ageS < 120) return `${ageS} s`;
  return `${Math.floor(ageS / 60)} m`;
}

/**
 * One 12pt caption line replacing the old live-row pills + deviation row:
 * [antenna] updated 8 s ago · on time · sim ±12 m
 */
function LiveCaption({ state }: { state: TramPublicState }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const positionMode = useSettingsStore((s) => s.positionMode);

  const nowMs = useNowTick();
  // Age of the last REAL AVL observation (origin_timestamp), live-ticking.
  const updatedAgoS = Math.max(0, Math.round((nowMs - state.snapshot.observedAtMs) / 1000));
  const fresh = updatedAgoS <= 15;

  const delayS = state.snapshot.delaySeconds;
  const dLabel = delayLabel(delayS);
  // Grey while fine; color only when meaningfully late. Past 3 min the delay
  // re-earns a small filled pill — honesty beats quietness for big delays.
  const delayTint = delayS > 60 ? delayColor(delayS) : c.textSecondary;
  const bigDelay = delayS > 180;

  // Sim honesty: interpolation drift in Smooth, raw-fix notice in Live.
  const honesty =
    positionMode === 'live'
      ? 'raw position'
      : state.deviationM != null
        ? `sim ±${Math.round(state.deviationM)} m`
        : null;
  const honestyA11y =
    positionMode === 'live'
      ? 'showing raw reported position'
      : state.deviationM != null
        ? `simulation offset ${Math.round(state.deviationM)} meters`
        : null;

  return (
    <View
      style={styles.caption}
      accessible
      accessibilityLabel={`Updated ${updatedAgoS} seconds ago, ${dLabel}${
        honestyA11y ? `, ${honestyA11y}` : ''
      }`}
    >
      <SymbolView
        name="antenna.radiowaves.left.and.right"
        size={12}
        tintColor={fresh ? Tram.onTime : c.textSecondary}
      />
      <Text style={[styles.captionText, { color: c.text }]} allowFontScaling={false}>
        updated {fmtAge(updatedAgoS)} ago
      </Text>
      <Text style={[styles.captionDot, { color: c.textSecondary }]} allowFontScaling={false}>
        ·
      </Text>
      {bigDelay ? (
        <View style={styles.delayPill}>
          <Text style={styles.delayPillText} allowFontScaling={false}>
            {dLabel}
          </Text>
        </View>
      ) : (
        <Text style={[styles.captionText, { color: delayTint }]} allowFontScaling={false}>
          {dLabel}
        </Text>
      )}
      {honesty != null && (
        <>
          <Text style={[styles.captionDot, { color: c.textSecondary }]} allowFontScaling={false}>
            ·
          </Text>
          <Text
            style={[styles.captionText, styles.captionHonesty, { color: c.textSecondary }]}
            numberOfLines={1}
            allowFontScaling={false}
          >
            {honesty}
          </Text>
        </>
      )}
    </View>
  );
}

// ── actions capsule ──────────────────────────────────────────────────────────

interface ActionsCapsuleProps {
  line: string;
  isFavorite: boolean;
  onFavorite: () => void;
  onShowLine: () => void;
  onAbout: () => void;
}

/** One 38pt segmented glass capsule: Favorite | Line N | About ›. */
function ActionsCapsule({ line, isFavorite, onFavorite, onShowLine, onAbout }: ActionsCapsuleProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const separator = scheme === 'dark' ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.1)';
  const favTint = isFavorite ? Tram.gold : c.text;

  return (
    <GlassPanel variant="clear" interactive style={styles.capsule}>
      <View style={styles.capsuleRow}>
        <Pressable
          onPress={onFavorite}
          style={({ pressed }) => [styles.segment, pressed && styles.segmentPressed]}
          accessibilityRole="button"
          accessibilityLabel={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          accessibilityState={{ selected: isFavorite }}
        >
          <SymbolView name={isFavorite ? 'star.fill' : 'star'} size={15} tintColor={favTint} />
          <Text style={[styles.segmentLabel, { color: favTint }]} allowFontScaling={false}>
            Favorite
          </Text>
        </Pressable>
        <View style={[styles.segmentDivider, { backgroundColor: separator }]} />
        <Pressable
          onPress={onShowLine}
          style={({ pressed }) => [styles.segment, pressed && styles.segmentPressed]}
          accessibilityRole="button"
          accessibilityLabel={`Show line ${line}`}
        >
          <SymbolView name="map.fill" size={15} tintColor={c.text} />
          <Text style={[styles.segmentLabel, { color: c.text }]} allowFontScaling={false}>
            Line {line}
          </Text>
        </Pressable>
        <View style={[styles.segmentDivider, { backgroundColor: separator }]} />
        <Pressable
          onPress={onAbout}
          style={({ pressed }) => [styles.segment, pressed && styles.segmentPressed]}
          accessibilityRole="button"
          accessibilityLabel="About this tram model"
        >
          <SymbolView name="info.circle" size={15} tintColor={c.text} />
          <Text style={[styles.segmentLabel, { color: c.text }]} allowFontScaling={false}>
            About
          </Text>
          <SymbolView name="chevron.right" size={10} tintColor={c.textSecondary} />
        </Pressable>
      </View>
    </GlassPanel>
  );
}

// ── header ───────────────────────────────────────────────────────────────────

export interface TramSheetHeaderProps {
  state: TramPublicState;
  isFavorite: boolean;
  onFavorite: () => void;
  onShowLine: () => void;
  onAbout: () => void;
}

export function TramSheetHeader({
  state,
  isFavorite,
  onFavorite,
  onShowLine,
  onAbout,
}: TramSheetHeaderProps) {
  const router = useRouter();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];

  const onPortrait = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(`/model/${state.model.id}`);
  };

  return (
    <>
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <View style={styles.titleRow}>
            <LineBadge line={state.snapshot.line} size="lg" />
            <Text style={[styles.headsign, { color: c.text }]} numberOfLines={2}>
              {state.snapshot.headsign}
            </Text>
          </View>
          <View style={styles.subtitleRow}>
            {/* No numberOfLines: the subtitle wraps rather than ellipsize, so
                the full registration number is always visible. */}
            <Text style={[styles.subtitle, { color: c.textSecondary }]}>
              {state.model.name}
              {state.snapshot.registrationNumber != null &&
                ` · #${state.snapshot.registrationNumber}`}
            </Text>
            <AcSnowflake airConditioned={state.snapshot.airConditioned} size={11} />
          </View>
          <LiveCaption state={state} />
        </View>
        {/* The portrait: TramFace in a clear-glass squircle → 3D viewer. */}
        <Pressable
          onPress={onPortrait}
          style={({ pressed }) => [styles.portraitPress, pressed && styles.portraitPressed]}
          accessibilityRole="button"
          accessibilityLabel={`View ${state.model.name} in 3D`}
          hitSlop={4}
        >
          <GlassPanel variant="clear" style={styles.portraitGlass}>
            <TramFace modelId={state.model.id} size={76} />
          </GlassPanel>
        </Pressable>
      </View>
      <ActionsCapsule
        line={state.snapshot.line}
        isFavorite={isFavorite}
        onFavorite={onFavorite}
        onShowLine={onShowLine}
        onAbout={onAbout}
      />
    </>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
  },
  headerLeft: { flex: 1, gap: 5 },
  titleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  headsign: {
    flex: 1,
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.4,
  },
  subtitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 5,
  },
  subtitle: { flexShrink: 1, fontSize: 13, lineHeight: 17 },
  caption: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
    minHeight: 16,
  },
  captionText: { fontSize: 12, fontVariant: ['tabular-nums'] },
  // The sim-offset fragment yields first under width pressure; freshness and
  // delay never truncate.
  captionHonesty: { flexShrink: 1 },
  captionDot: { fontSize: 12 },
  delayPill: {
    backgroundColor: Tram.veryLate,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  delayPillText: { color: '#FFFFFF', fontSize: 11, fontWeight: '600' },
  portraitPress: { alignSelf: 'flex-start' },
  portraitPressed: { transform: [{ scale: 0.96 }] },
  portraitGlass: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 28,
    height: 96,
    justifyContent: 'center',
    width: 96,
  },
  capsule: { borderRadius: 19 },
  capsuleRow: {
    alignItems: 'stretch',
    flexDirection: 'row',
    minHeight: 38,
  },
  segment: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 5,
    justifyContent: 'center',
    paddingHorizontal: 4,
    paddingVertical: 9,
  },
  segmentPressed: { opacity: 0.55 },
  segmentDivider: {
    alignSelf: 'stretch',
    marginVertical: 6,
    width: StyleSheet.hairlineWidth,
  },
  segmentLabel: { fontSize: 12, fontWeight: '600' },
});
