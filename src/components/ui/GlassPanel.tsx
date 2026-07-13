// Liquid Glass surface with graceful degradation:
// iOS 26+ → real glass (expo-glass-effect); older iOS → blur; last resort → solid.
import { BlurView } from 'expo-blur';
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { type ReactNode, useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  StyleSheet,
  useColorScheme,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

const glassSupported = isGlassEffectAPIAvailable() && isLiquidGlassAvailable();

let reduceTransparencyCache = false;
AccessibilityInfo.isReduceTransparencyEnabled()
  .then((v) => {
    reduceTransparencyCache = v;
  })
  .catch(() => {});

export interface GlassPanelProps {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** 'regular' (default) for legible chrome over the map, 'clear' for thin pills. */
  variant?: 'regular' | 'clear';
  /** Glass reacts to touches (buttons). */
  interactive?: boolean;
  tintColor?: string;
  /**
   * Force the panel's light/dark appearance instead of following the system
   * scheme. The MAP chrome passes the map's resolved light preset here — the
   * panels float over the basemap, so a dark-mode phone over a daytime map
   * must still get LIGHT glass with dark content (and vice versa at night).
   */
  appearance?: 'light' | 'dark';
}

export function GlassPanel({
  children,
  style,
  variant = 'regular',
  interactive,
  tintColor,
  appearance,
}: GlassPanelProps) {
  const systemScheme = useColorScheme();
  const scheme = appearance ?? (systemScheme === 'dark' ? 'dark' : 'light');
  const [reduceTransparency, setReduceTransparency] = useState(reduceTransparencyCache);

  useEffect(() => {
    let mounted = true;
    // Panels mounted before the module-level query resolves would otherwise be
    // stuck on the stale `false` seed (the change listener only fires on later
    // toggles). Re-query on mount and adopt the result.
    AccessibilityInfo.isReduceTransparencyEnabled()
      .then((v) => {
        reduceTransparencyCache = v;
        if (mounted) setReduceTransparency(v);
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceTransparencyChanged', (v) => {
      reduceTransparencyCache = v;
      setReduceTransparency(v);
    });
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  if (glassSupported && !reduceTransparency) {
    return (
      <GlassView
        glassEffectStyle={variant}
        isInteractive={interactive}
        tintColor={tintColor}
        colorScheme={appearance ?? 'auto'}
        style={[styles.rounded, style]}
      >
        {children}
      </GlassView>
    );
  }
  if (!reduceTransparency) {
    return (
      <BlurView
        intensity={variant === 'clear' ? 35 : 60}
        tint={scheme === 'dark' ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
        style={[styles.rounded, styles.clipped, style]}
      >
        {children}
      </BlurView>
    );
  }
  return (
    <View
      style={[
        styles.rounded,
        { backgroundColor: scheme === 'dark' ? 'rgba(28,28,30,0.94)' : 'rgba(248,248,250,0.96)' },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  rounded: { borderRadius: 20 },
  clipped: { overflow: 'hidden' },
});
