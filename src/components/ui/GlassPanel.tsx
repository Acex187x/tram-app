// Liquid Glass surface with graceful degradation:
// iOS 26+ → real glass (expo-glass-effect); older iOS → blur; last resort → solid.
import { BlurView } from 'expo-blur';
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { type ReactNode, type Ref, useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  StyleSheet,
  useColorScheme,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import {
  contentBlurOverlayFor,
  contentGlassTintFor,
} from '@/components/ui/glass-appearance';

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
   * Strengthen the material behind same-scheme foreground when this panel
   * floats over high-contrast content such as a map or 3D scene. Ordinary
   * sheet glass intentionally leaves this off.
   */
  readableOverContent?: boolean;
  /**
   * Pin a system-derived appearance when a parent already owns the scheme.
   * Most callers should omit this and follow the device directly. Never derive
   * this value from basemap lighting: map style and application UI are separate.
   */
  appearance?: 'light' | 'dark';
  /**
   * Forwarded to whichever native view this panel resolves to.
   *
   * Load-bearing for `Animated.createAnimatedComponent(GlassPanel)`: Reanimated
   * attaches its per-frame prop updates to the HOST instance it gets through the
   * ref, so a wrapper that swallows the ref animates NOTHING (silently — no
   * warning, the style simply never lands). The map sheet animates this panel's
   * corner radii every frame of a drag, which is the only reason it exists.
   */
  ref?: Ref<View>;
}

export function GlassPanel({
  children,
  style,
  variant = 'regular',
  interactive,
  tintColor,
  readableOverContent = false,
  appearance,
  ref,
}: GlassPanelProps) {
  const systemScheme = useColorScheme();
  const scheme = appearance ?? (systemScheme === 'dark' ? 'dark' : 'light');
  /** What the NATIVE glass is told. See the `colorScheme` prop below. */
  const glassScheme: 'light' | 'dark' | 'auto' =
    appearance ?? (systemScheme === 'dark' || systemScheme === 'light' ? systemScheme : 'auto');
  const resolvedTintColor =
    tintColor ?? (readableOverContent ? contentGlassTintFor(scheme) : undefined);
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
        tintColor={resolvedTintColor}
        // PIN the appearance, never 'auto'. 'auto' maps to
        // UIUserInterfaceStyle.unspecified, i.e. "resolve light/dark yourself"
        // — from the inherited trait collection, which can briefly be stale on
        // a recycled native view. The panel's children are painted from the
        // same resolved scheme, so any divergence lands on screen as a MIXED
        // light/dark surface. Passing the system scheme explicitly
        // is the same intent the prop doc states ("follow the system scheme"),
        // just asserted instead of inferred. 'auto' survives only for the case
        // where the platform reports no scheme at all (null), where letting
        // UIKit resolve beats guessing light.
        colorScheme={glassScheme}
        ref={ref}
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
        // BlurView is a class component, so the ref is its instance rather than
        // a View — Reanimated handles exactly that (it calls the class's own
        // `getAnimatableRef` to reach the native blur view). The cast is only
        // about the two ref TYPES; the value is the one Reanimated expects.
        ref={ref as Ref<BlurView>}
        style={[styles.rounded, styles.clipped, style]}
      >
        {readableOverContent && (
          <View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: contentBlurOverlayFor(scheme) },
            ]}
          />
        )}
        {children}
      </BlurView>
    );
  }
  return (
    <View
      ref={ref}
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
