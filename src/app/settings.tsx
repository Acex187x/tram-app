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
import { Colors, Tram } from '@/constants/theme';
import { useSettingsStore, type LightPreset } from '@/stores/settings';

/** Left inset aligning separators with row text (padding + icon + gap). */
const SEPARATOR_INSET = 16 + 29 + 12;

const LIGHT_PRESETS: { value: LightPreset; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'day', label: 'Day' },
  { value: 'dusk', label: 'Dusk' },
  { value: 'night', label: 'Night' },
];

const ATTRIBUTIONS: { icon: SFSymbol; iconColor: string; label: string; url: string }[] = [
  {
    icon: 'antenna.radiowaves.left.and.right',
    iconColor: Tram.onTime,
    label: 'Golemio API — live positions',
    url: 'https://api.golemio.cz/docs/openapi/',
  },
  {
    icon: 'tram.fill',
    iconColor: Tram.pidRed,
    label: 'PID open data — routes & stops',
    url: 'https://pid.cz/o-systemu/opendata/',
  },
  {
    icon: 'globe.europe.africa.fill',
    iconColor: Tram.night,
    label: 'Mapbox — maps & 3D terrain',
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

/** iOS-style segmented control for the map light preset. */
function LightPresetSegments() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = Colors[scheme];
  const lightPreset = useSettingsStore((s) => s.lightPreset);
  const setLightPreset = useSettingsStore((s) => s.setLightPreset);
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
      {LIGHT_PRESETS.map((preset) => {
        const selected = preset.value === lightPreset;
        return (
          <Pressable
            key={preset.value}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => {
              if (selected) return;
              void Haptics.selectionAsync();
              setLightPreset(preset.value);
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
              {preset.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
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
      <SheetHeader title="Settings" />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
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
            <RowSeparator inset={SEPARATOR_INSET} />
            <Row icon="info.circle.fill" iconColor={palette.textSecondary} label="Version">
              <Text style={[styles.rowValue, { color: palette.textSecondary }]}>
                {version}
              </Text>
            </Row>
            {ATTRIBUTIONS.map((item) => (
              <Fragment key={item.url}>
                <RowSeparator inset={SEPARATOR_INSET} />
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
          </InsetGroup>
        </View>

        <Text style={[styles.footer, { color: palette.textSecondary }]}>
          Made with ❤️ for Prague trams
        </Text>
      </ScrollView>
    </GlassPanel>
  );
}

const styles = StyleSheet.create({
  sheet: {
    flex: 1,
  },
  content: {
    gap: 24,
    padding: 16,
    paddingBottom: 48,
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
  footer: {
    fontSize: 13,
    textAlign: 'center',
  },
});
