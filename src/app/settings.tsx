// /settings form sheet — map preferences (light preset, route lines, heading
// lock) and an about section with attribution links, styled as iOS
// grouped-inset lists on Liquid Glass.
import Constants from 'expo-constants';
import * as Haptics from 'expo-haptics';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import * as WebBrowser from 'expo-web-browser';
import { Fragment, type ReactNode } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  useColorScheme,
  View,
} from 'react-native';

import { InsetGroup, RowSeparator, SectionLabel } from '@/components/favorites/InsetGroup';
import { SheetHeader } from '@/components/favorites/SheetHeader';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { SheetContent } from '@/components/ui/SheetContent';
import { Colors, Tram } from '@/constants/theme';
import { useSettingsStore, type LightPreset, type PositionMode } from '@/stores/settings';

/** Left inset aligning separators with row text (padding + icon + gap). */
const SEPARATOR_INSET = 16 + 29 + 12;

const LIGHT_PRESETS: { value: LightPreset; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'day', label: 'Day' },
  { value: 'dusk', label: 'Dusk' },
  { value: 'night', label: 'Night' },
];

const POSITION_MODES: { value: PositionMode; label: string }[] = [
  { value: 'smooth', label: 'Smooth' },
  { value: 'live', label: 'Live' },
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

function IconSquare({ name, color }: { name: SFSymbol; color: string }) {
  return (
    <View style={[styles.iconSquare, { backgroundColor: color }]}>
      <SymbolView name={name} size={16} tintColor="#FFFFFF" />
    </View>
  );
}

/** Standard grouped row: leading icon square, label, trailing accessory. */
function Row({
  icon,
  iconColor,
  label,
  children,
  onPress,
}: {
  icon: SFSymbol;
  iconColor: string;
  label: string;
  children?: ReactNode;
  onPress?: () => void;
}) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = Colors[scheme];
  const content = (
    <>
      <IconSquare name={icon} color={iconColor} />
      <Text style={[styles.rowLabel, { color: palette.text }]} numberOfLines={1}>
        {label}
      </Text>
      {children}
    </>
  );
  if (!onPress) return <View style={styles.row}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        pressed && {
          backgroundColor: scheme === 'dark' ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)',
        },
      ]}
    >
      {content}
    </Pressable>
  );
}

/** iOS-style segmented control (light preset, position mode). */
function Segments<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = Colors[scheme];
  return (
    <View
      style={[
        styles.segments,
        {
          backgroundColor:
            scheme === 'dark' ? 'rgba(118,118,128,0.24)' : 'rgba(118,118,128,0.14)',
        },
      ]}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => {
              if (selected) return;
              void Haptics.selectionAsync();
              onChange(option.value);
            }}
            style={[
              styles.segment,
              selected && {
                backgroundColor: scheme === 'dark' ? '#636366' : '#FFFFFF',
                boxShadow: '0 1px 4px rgba(0,0,0,0.14)',
              },
            ]}
          >
            <Text
              allowFontScaling={false}
              style={{
                color: selected ? palette.text : palette.textSecondary,
                fontSize: 13,
                fontWeight: selected ? '600' : '500',
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function LightPresetSegments() {
  const lightPreset = useSettingsStore((s) => s.lightPreset);
  const setLightPreset = useSettingsStore((s) => s.setLightPreset);
  return <Segments options={LIGHT_PRESETS} value={lightPreset} onChange={setLightPreset} />;
}

function PositionModeSegments() {
  const positionMode = useSettingsStore((s) => s.positionMode);
  const setPositionMode = useSettingsStore((s) => s.setPositionMode);
  return <Segments options={POSITION_MODES} value={positionMode} onChange={setPositionMode} />;
}

export default function SettingsScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = Colors[scheme];
  const showRouteLines = useSettingsStore((s) => s.showRouteLines);
  const followHeadingLock = useSettingsStore((s) => s.followHeadingLock);
  const setShowRouteLines = useSettingsStore((s) => s.setShowRouteLines);
  const setFollowHeadingLock = useSettingsStore((s) => s.setFollowHeadingLock);

  const version = Constants.expoConfig?.version ?? '1.0.0';

  const toggle = (setter: (v: boolean) => void) => (value: boolean) => {
    void Haptics.selectionAsync();
    setter(value);
  };

  return (
    <GlassPanel style={styles.sheet}>
      <SheetContent>
        <SheetHeader title="Settings" />
      </SheetContent>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.scrollBottom}
        showsVerticalScrollIndicator={false}
      >
        <SheetContent style={styles.content}>
        <View>
          <SectionLabel>Positioning</SectionLabel>
          <InsetGroup>
            <View style={styles.presetCell}>
              <View style={styles.presetHeader}>
                <IconSquare name="scope" color={Tram.onTime} />
                <Text style={[styles.rowLabel, { color: palette.text }]}>Tram positions</Text>
              </View>
              <PositionModeSegments />
            </View>
          </InsetGroup>
          <Text style={[styles.footnote, { color: palette.textSecondary }]}>
            Smooth interpolates motion between updates. Live shows exact reported
            positions and jumps on every update.
          </Text>
        </View>

        <View>
          <SectionLabel>Map</SectionLabel>
          <InsetGroup>
            <View style={styles.presetCell}>
              <View style={styles.presetHeader}>
                <IconSquare name="sun.max.fill" color={Tram.gold} />
                <Text style={[styles.rowLabel, { color: palette.text }]}>Light preset</Text>
              </View>
              <LightPresetSegments />
            </View>
            <RowSeparator inset={SEPARATOR_INSET} />
            <Row icon="point.topleft.down.to.point.bottomright.curvepath.fill" iconColor={Tram.pidRed} label="Route lines">
              <Switch
                value={showRouteLines}
                onValueChange={toggle(setShowRouteLines)}
                trackColor={{ true: Tram.pidRed }}
              />
            </Row>
            <RowSeparator inset={SEPARATOR_INSET} />
            <Row icon="location.north.line.fill" iconColor={Tram.night} label="Follow locks heading">
              <Switch
                value={followHeadingLock}
                onValueChange={toggle(setFollowHeadingLock)}
                trackColor={{ true: Tram.pidRed }}
              />
            </Row>
          </InsetGroup>
        </View>

        <View>
          <SectionLabel>About</SectionLabel>
          <InsetGroup>
            <View style={styles.blurbCell}>
              <Text style={[styles.blurbTitle, { color: palette.text }]}>Tram Spotter</Text>
              <Text style={[styles.blurb, { color: palette.textSecondary }]}>
                Watch every Prague tram glide in real time — live positions from
                Golemio, physics-smoothed between updates and rendered as 3D
                models over the city.
              </Text>
            </View>
          </InsetGroup>
        </View>

        <View>
          <SectionLabel>Data & attribution</SectionLabel>
          <InsetGroup>
            {ATTRIBUTIONS.map((item, i) => (
              <Fragment key={item.url}>
                {i > 0 && <RowSeparator inset={SEPARATOR_INSET} />}
                <Row
                  icon={item.icon}
                  iconColor={item.iconColor}
                  label={item.label}
                  onPress={() => void WebBrowser.openBrowserAsync(item.url)}
                >
                  <SymbolView
                    name="arrow.up.right"
                    size={13}
                    weight="semibold"
                    tintColor={palette.textSecondary}
                  />
                </Row>
              </Fragment>
            ))}
            <RowSeparator inset={SEPARATOR_INSET} />
            <Row icon="info.circle.fill" iconColor={palette.textSecondary} label="Version">
              <Text style={[styles.rowValue, { color: palette.textSecondary }]}>
                {version}
              </Text>
            </Row>
          </InsetGroup>
        </View>

        <Text style={[styles.footer, { color: palette.textSecondary }]}>
          Made with ❤️ for Prague trams
        </Text>
        </SheetContent>
      </ScrollView>
    </GlassPanel>
  );
}

const styles = StyleSheet.create({
  sheet: {
    flex: 1,
  },
  scrollBottom: {
    paddingBottom: 48,
  },
  content: {
    gap: 24,
    padding: 16,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    minHeight: 50,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  rowLabel: {
    flex: 1,
    fontSize: 16,
  },
  rowValue: {
    fontSize: 16,
    fontVariant: ['tabular-nums'],
  },
  iconSquare: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 7,
    height: 29,
    justifyContent: 'center',
    width: 29,
  },
  presetCell: {
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  presetHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  segments: {
    borderCurve: 'continuous',
    borderRadius: 10,
    flexDirection: 'row',
    padding: 2,
  },
  segment: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 8,
    flex: 1,
    justifyContent: 'center',
    paddingVertical: 7,
  },
  blurbCell: {
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  blurbTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  blurb: {
    fontSize: 14,
    lineHeight: 20,
  },
  footnote: {
    fontSize: 13,
    lineHeight: 18,
    marginHorizontal: 16,
    marginTop: 8,
  },
  footer: {
    fontSize: 13,
    textAlign: 'center',
  },
});
