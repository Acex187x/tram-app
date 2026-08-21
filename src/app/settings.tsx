// /settings form sheet — map preferences (light preset, route lines, heading
// lock), tram-icon packs, motion-data export, and attribution — re-skinned to
// Apple Maps' "Preferences" grammar (IMG_0076): a large-title SheetHeader with a
// circular X, uppercase SectionLabels over rounded InsetGroups, native Switch
// rows and blue-checkmark selection rows.
// Every settings-store write is byte-identical to before — this is chrome only.
import Constants from 'expo-constants';
import * as Haptics from 'expo-haptics';
import { router, type Href } from 'expo-router';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import * as WebBrowser from 'expo-web-browser';
import { Fragment } from 'react';
import {
  ActionSheetIOS,
  Alert,
  Pressable,
  Share,
  StyleSheet,
  Switch,
  Text,
  useColorScheme,
  View,
} from 'react-native';

import { TramFace } from '@/components/tram/TramFace';
import {
  InsetGroup,
  InsetRow,
  RowSeparator,
  SectionLabel,
} from '@/components/ui/Inset';
import { SheetHeader } from '@/components/ui/SheetHeader';
import { SheetSurface } from '@/components/ui/SheetSurface';
import { appleScheme, Tram, Type } from '@/constants/theme';
import { ICON_PACKS, ICON_PACK_IDS } from '@/lib/fleet/iconPacks';
import { useMotionLog, type MotionFileInfo } from '@/lib/motionlog';
import type { TramModelId } from '@/lib/types';
import { useSettingsStore, type LightPreset } from '@/stores/settings';

const LIGHT_PRESETS: { value: LightPreset; label: string; icon: SFSymbol; tint: string }[] = [
  { value: 'auto', label: 'Automatic', icon: 'wand.and.stars', tint: Tram.night },
  { value: 'day', label: 'Day', icon: 'sun.max.fill', tint: Tram.gold },
  { value: 'dusk', label: 'Dusk', icon: 'sunset.fill', tint: Tram.late },
  { value: 'night', label: 'Night', icon: 'moon.stars.fill', tint: Tram.night },
];

const ATTRIBUTIONS: { icon: SFSymbol; iconColor: string; label: string; url: string }[] = [
  {
    icon: 'antenna.radiowaves.left.and.right',
    iconColor: Tram.onTime,
    label: 'Golemio — Prague data platform',
    url: 'https://golemio.cz',
  },
  {
    icon: 'tram.fill',
    iconColor: Tram.pidRed,
    label: 'PID open data',
    url: 'https://pid.cz/o-systemu/opendata/',
  },
  {
    icon: 'globe.europe.africa.fill',
    iconColor: Tram.night,
    label: 'Mapbox',
    url: 'https://www.mapbox.com/about/maps/',
  },
];

/** Footnote text under a grouped section. */
function Footnote({ children }: { children: string }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  return (
    <Text style={[styles.footnote, { color: appleScheme(scheme).secondary }]}>{children}</Text>
  );
}

function ThemedSwitch({
  label,
  value,
  onValueChange,
}: {
  /** Accessible name — InsetRow's trailing slot is its own a11y element, so an
   *  unlabeled switch would announce as a bare "Switch, on". */
  label: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
}) {
  return (
    <Switch
      accessibilityLabel={label}
      value={value}
      onValueChange={(v) => {
        void Haptics.selectionAsync();
        onValueChange(v);
      }}
      trackColor={{ true: Tram.pidRed }}
    />
  );
}

// ── Positioning ──────────────────────────────────────────────────────────────

/**
 * The whole positioning UI: one switch between the server's two published
 * curves (docs/research/physics-v3-protocol.md). Default OFF = the smooth
 * continuity track; ON = the model's raw opinion, which is more accurate the
 * instant a fix lands and visibly jumps to get there.
 */
function PositionModeSection() {
  const positionMode = useSettingsStore((s) => s.positionMode);
  const setPositionMode = useSettingsStore((s) => s.setPositionMode);
  return (
    <View style={styles.section}>
      <SectionLabel>Tram positions</SectionLabel>
      <InsetGroup>
        <InsetRow
          icon="scope"
          iconTint={Tram.pidRed}
          title="Более точное положение"
          trailing={
            <ThemedSwitch
              label="Более точное положение"
              value={positionMode === 'fixed'}
              onValueChange={(on) => setPositionMode(on ? 'fixed' : 'smooth')}
            />
          }
        />
      </InsetGroup>
      <Footnote>
        По умолчанию трамваи движутся по сглаженной траектории — без рывков между обновлениями.
        Включите, чтобы показывать положение, которое сервер считает наиболее точным: оно ближе к
        реальности сразу после обновления, но заметно прыгает.
      </Footnote>
    </View>
  );
}

// ── Map appearance ───────────────────────────────────────────────────────────

function LightPresetSection() {
  const lightPreset = useSettingsStore((s) => s.lightPreset);
  const setLightPreset = useSettingsStore((s) => s.setLightPreset);
  return (
    <View style={styles.section}>
      <SectionLabel>Map lighting</SectionLabel>
      <InsetGroup>
        {LIGHT_PRESETS.map((preset, i) => (
          <Fragment key={preset.value}>
            {i > 0 && <RowSeparator inset={16 + 29 + 12} />}
            <InsetRow
              icon={preset.icon}
              iconTint={preset.tint}
              title={preset.label}
              checked={lightPreset === preset.value}
              onPress={() => {
                if (lightPreset === preset.value) return;
                void Haptics.selectionAsync();
                setLightPreset(preset.value);
              }}
            />
          </Fragment>
        ))}
      </InsetGroup>
    </View>
  );
}

function MapSection() {
  const showRouteLines = useSettingsStore((s) => s.showRouteLines);
  const followHeadingLock = useSettingsStore((s) => s.followHeadingLock);
  const setShowRouteLines = useSettingsStore((s) => s.setShowRouteLines);
  const setFollowHeadingLock = useSettingsStore((s) => s.setFollowHeadingLock);
  return (
    <View style={styles.section}>
      <SectionLabel>Map</SectionLabel>
      <InsetGroup>
        <InsetRow
          icon="point.topleft.down.to.point.bottomright.curvepath.fill"
          iconTint={Tram.pidRed}
          title="Route lines"
          trailing={
            <ThemedSwitch
              label="Route lines"
              value={showRouteLines}
              onValueChange={setShowRouteLines}
            />
          }
        />
        <RowSeparator inset={16 + 29 + 12} />
        <InsetRow
          icon="location.north.line.fill"
          iconTint={Tram.night}
          title="Follow locks heading"
          trailing={
            <ThemedSwitch
              label="Follow locks heading"
              value={followHeadingLock}
              onValueChange={setFollowHeadingLock}
            />
          }
        />
      </InsetGroup>
    </View>
  );
}

// ── Tram icons ───────────────────────────────────────────────────────────────

/** Models shown in each pack's live preview strip (varied silhouettes). */
const PACK_PREVIEW_MODELS: TramModelId[] = ['t3', '15t', '52t'];

/** VoiceOver route to the magnifier — the pack row is one a11y element. */
const PACK_ACTIONS = [{ name: 'preview', label: 'Preview icons up close' }];

function IconPackSection() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  const iconPack = useSettingsStore((s) => s.iconPack);
  const setIconPack = useSettingsStore((s) => s.setIconPack);

  return (
    <View style={styles.section}>
      <SectionLabel>Tram icons</SectionLabel>
      <InsetGroup>
        {ICON_PACK_IDS.map((packId, i) => {
          const meta = ICON_PACKS[packId].meta;
          const selected = packId === iconPack;
          const onPreview = () => {
            void Haptics.selectionAsync();
            router.push(`/icon-preview/${packId}` as Href);
          };
          return (
            <Fragment key={packId}>
              {i > 0 && <RowSeparator inset={16} />}
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={meta.name}
                accessibilityActions={PACK_ACTIONS}
                onAccessibilityAction={({ nativeEvent }) => {
                  if (nativeEvent.actionName === 'preview') onPreview();
                }}
                onPress={() => {
                  if (selected) return;
                  void Haptics.selectionAsync();
                  setIconPack(packId);
                }}
                style={({ pressed }) => [styles.packRow, pressed && styles.pressed]}
              >
                <View style={styles.packPreview}>
                  {PACK_PREVIEW_MODELS.map((modelId) => (
                    <TramFace key={modelId} pack={packId} modelId={modelId} size={34} />
                  ))}
                </View>
                <View style={styles.packTexts}>
                  <Text style={[styles.packName, { color: c.text }]} numberOfLines={1}>
                    {meta.name}
                  </Text>
                  <Text
                    style={[Type.footnote, styles.packDescription, { color: c.secondary }]}
                    numberOfLines={2}
                  >
                    {meta.description}
                  </Text>
                </View>
                {/* Reachable in VoiceOver through the row's 'preview' action. */}
                <Pressable
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  hitSlop={8}
                  onPress={onPreview}
                  style={({ pressed }) => [
                    styles.previewButton,
                    { backgroundColor: c.fillSecondary },
                    pressed && styles.pressed,
                  ]}
                >
                  <SymbolView
                    name="magnifyingglass"
                    size={14}
                    weight="semibold"
                    tintColor={c.secondary}
                  />
                </Pressable>
                {selected && (
                  <SymbolView name="checkmark" size={16} weight="semibold" tintColor={c.blue} />
                )}
              </Pressable>
            </Fragment>
          );
        })}
      </InsetGroup>
      <Footnote>
        Changes the tram faces on map badges and everywhere a tram portrait appears. Tap the
        magnifier to see a pack up close.
      </Footnote>
    </View>
  );
}

// ── Motion data ──────────────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function shareFile(uri: string): Promise<void> {
  try {
    await Share.share({ url: uri });
  } catch {
    // user cancelled or share unavailable — nothing to do
  }
}

/** Share newest file directly; if several, pick from a native action sheet. */
function pickAndShare(files: MotionFileInfo[], title: string): void {
  if (files.length === 0) {
    Alert.alert('Nothing to export', `No ${title.toLowerCase()} have been recorded yet.`);
    return;
  }
  if (files.length === 1) {
    void shareFile(files[0].uri);
    return;
  }
  const options = [...files.map((f) => f.name), 'Cancel'];
  ActionSheetIOS.showActionSheetWithOptions(
    { title, options, cancelButtonIndex: options.length - 1 },
    (index) => {
      if (index != null && index < files.length) void shareFile(files[index].uri);
    },
  );
}

const SEPARATOR_INSET = 16 + 29 + 12;

function MotionDataSection() {
  const c = appleScheme(useColorScheme() === 'dark' ? 'dark' : 'light');
  const log = useMotionLog();
  const stats = log.stats();
  const passiveFleetLogging = useSettingsStore((s) => s.passiveFleetLogging);
  const setPassiveFleetLogging = useSettingsStore((s) => s.setPassiveFleetLogging);

  const onExportLogs = () => {
    void Haptics.selectionAsync();
    log.flush();
    pickAndShare(log.listLogFiles(), 'Motion logs');
  };
  const onExportRides = () => {
    void Haptics.selectionAsync();
    log.flush();
    pickAndShare(log.listRideFiles(), 'Ride recordings');
  };
  const onClear = () => {
    Alert.alert(
      'Clear motion data',
      'Delete all motion logs and ride recordings? This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            log.clearAll();
          },
        },
      ],
    );
  };

  const hasData = stats.totalBytes > 0 || stats.riding;
  const exportGlyph = (
    <SymbolView name="square.and.arrow.up" size={16} weight="semibold" tintColor={c.secondary} />
  );

  return (
    <View style={styles.section}>
      <SectionLabel>Motion data</SectionLabel>
      <InsetGroup>
        <InsetRow
          icon="waveform.path.ecg"
          iconTint={Tram.onTime}
          title="Passive fleet logging"
          trailing={
            <ThemedSwitch
              label="Passive fleet logging"
              value={passiveFleetLogging}
              onValueChange={setPassiveFleetLogging}
            />
          }
        />
        <RowSeparator inset={SEPARATOR_INSET} />
        <InsetRow
          icon="record.circle"
          iconTint={Tram.veryLate}
          title="Recorded rides"
          value={stats.rideCount > 0 ? `${stats.rideCount}` : '—'}
          chevron
          onPress={() => {
            void Haptics.selectionAsync();
            router.push('/rides' as Href);
          }}
        />
        <RowSeparator inset={SEPARATOR_INSET} />
        <InsetRow
          icon="waveform.path.ecg"
          iconTint={Tram.onTime}
          title="Export motion logs"
          value={stats.logCount > 0 ? `${stats.logCount}` : '—'}
          trailing={exportGlyph}
          onPress={onExportLogs}
        />
        <RowSeparator inset={SEPARATOR_INSET} />
        <InsetRow
          icon="record.circle"
          iconTint={Tram.veryLate}
          title="Export ride recordings"
          value={stats.rideCount > 0 ? `${stats.rideCount}` : '—'}
          trailing={exportGlyph}
          onPress={onExportRides}
        />
        <RowSeparator inset={SEPARATOR_INSET} />
        <InsetRow
          icon="internaldrive"
          iconTint={Tram.night}
          title="Storage used"
          value={formatBytes(stats.totalBytes)}
        />
        {hasData && (
          <>
            <RowSeparator inset={SEPARATOR_INSET} />
            <InsetRow
              icon="trash.fill"
              iconTint={c.red}
              title="Clear motion data"
              destructive
              onPress={onClear}
            />
          </>
        )}
      </InsetGroup>
      <Footnote>
        Passive fleet logging collects full-fleet deviation logs for physics calibration, ~25 MB/h
        (on by default during the single-user calibration phase). Ride recordings capture GPS
        against the simulated position and work independently of the toggle. Nothing leaves the
        device until you export it.
      </Footnote>
    </View>
  );
}

// ── Developer ────────────────────────────────────────────────────────────────

function DeveloperSection() {
  const debugMode = useSettingsStore((s) => s.debugMode);
  const setDebugMode = useSettingsStore((s) => s.setDebugMode);
  // The "Backend feed" toggle is gone (2026-08-08): the app streams from the
  // Tram Spotter server unconditionally — there is no device-side Golemio
  // polling to switch back to.
  return (
    <View style={styles.section}>
      <SectionLabel>Developer</SectionLabel>
      <InsetGroup>
        <InsetRow
          icon="ladybug.fill"
          iconTint={Tram.veryLate}
          title="Debug mode"
          trailing={<ThemedSwitch label="Debug mode" value={debugMode} onValueChange={setDebugMode} />}
        />
      </InsetGroup>
      <Footnote>
        Debug mode overlays a live technical readout of the simulation on the followed tram.
      </Footnote>
    </View>
  );
}

// ── About & attribution ──────────────────────────────────────────────────────

function AboutSection() {
  const c = appleScheme(useColorScheme() === 'dark' ? 'dark' : 'light');
  const version = Constants.expoConfig?.version ?? '1.0.0';
  return (
    <>
      <View style={styles.section}>
        <SectionLabel>About</SectionLabel>
        <InsetGroup>
          <View style={styles.blurbCell}>
            <Text style={[styles.blurbTitle, { color: c.text }]}>Tram Spotter</Text>
            <Text style={[styles.blurb, { color: c.secondary }]}>
              Watch every Prague tram glide in real time — live positions from Golemio,
              physics-smoothed between updates and rendered as 3D models over the city.
            </Text>
          </View>
        </InsetGroup>
      </View>

      <View style={styles.section}>
        <SectionLabel>Data & attribution</SectionLabel>
        <InsetGroup>
          {ATTRIBUTIONS.map((item, i) => (
            <Fragment key={item.url}>
              {i > 0 && <RowSeparator inset={SEPARATOR_INSET} />}
              <InsetRow
                icon={item.icon}
                iconTint={item.iconColor}
                title={item.label}
                onPress={() => void WebBrowser.openBrowserAsync(item.url)}
                trailing={
                  <SymbolView
                    name="arrow.up.right"
                    size={13}
                    weight="semibold"
                    tintColor={c.secondary}
                  />
                }
              />
            </Fragment>
          ))}
          <RowSeparator inset={SEPARATOR_INSET} />
          <InsetRow icon="info.circle.fill" iconTint={c.secondary} title="Version" value={version} />
        </InsetGroup>
      </View>

      <Text style={[styles.footer, { color: c.secondary }]}>Made with ❤️ for Prague trams</Text>
    </>
  );
}

export default function SettingsScreen() {
  return (
    <SheetSurface header={<SheetHeader title="Settings" />}>
      <PositionModeSection />
      <LightPresetSection />
      <MapSection />
      <IconPackSection />
      <MotionDataSection />
      <DeveloperSection />
      <AboutSection />
    </SheetSurface>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8 },
  // A group FOOTER: same edge as the SectionLabel that opens the group, which
  // is the sheet's content edge now (see Inset.tsx). Was indented 16 past it.
  footnote: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
  },
  pressed: { opacity: 0.55 },
  packRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    minHeight: 64,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  packPreview: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 2,
  },
  packTexts: { flex: 1, gap: 2 },
  packName: { fontSize: 17, fontWeight: '600' },
  packDescription: { lineHeight: 16 },
  previewButton: {
    alignItems: 'center',
    borderRadius: 15,
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
  blurbCell: {
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  blurbTitle: { fontSize: 17, fontWeight: '700' },
  blurb: { fontSize: 15, lineHeight: 21 },
  footer: {
    fontSize: 13,
    textAlign: 'center',
    marginTop: 4,
  },
});
