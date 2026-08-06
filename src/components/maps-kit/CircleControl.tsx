// The right-edge vertical column of circular translucent map controls
// (IMG_0072/77): a 2D/3D toggle and the fused map+locate capsule. Three pieces:
//   • CircleControl  — one round glass button (or a borderless button inside a
//                      capsule); `active` fills it blue (locate while following).
//   • ControlCapsule — one continuous glass capsule wrapping stacked
//                      CircleControls, hairline-separated (the map+locate pill).
//   • ControlStack   — the absolutely-positioned top-right column.
// Appearance follows the system theme through the shared chrome context.
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { createContext, useContext, type ReactNode } from 'react';
import { Pressable, StyleSheet, useColorScheme, View } from 'react-native';
import Animated, { type AnimatedStyle } from 'react-native-reanimated';
import type { StyleProp, ViewStyle } from 'react-native';

import { GlassPanel } from '@/components/ui/GlassPanel';
import { appleScheme } from '@/constants/theme';

/** Default control diameter — one shared axis with the native compass ornament. */
export const CONTROL_SIZE = 46;
/** Vertical gap between stacked controls / capsule buttons. */
export const CONTROL_GAP = 10;

interface CapsuleCtx {
  inCapsule: boolean;
  appearance: 'light' | 'dark';
  size: number;
}
const CapsuleContext = createContext<CapsuleCtx | null>(null);

export interface CircleControlProps {
  symbol: SFSymbol;
  label: string;
  onPress: () => void;
  /** Blue-filled active state (e.g. locate while following the user). */
  active?: boolean;
  /** Announces a menu/popover this button owns as expanded or collapsed. */
  expanded?: boolean;
  /** Diameter — defaults to 46 (ignored inside a ControlCapsule, which sets it). */
  size?: number;
  appearance?: 'light' | 'dark';
}

export function CircleControl({
  symbol,
  label,
  onPress,
  active,
  expanded,
  size,
  appearance,
}: CircleControlProps) {
  const cap = useContext(CapsuleContext);
  const system = useColorScheme() === 'dark' ? 'dark' : 'light';
  const scheme = appearance ?? cap?.appearance ?? system;
  const dim = size ?? cap?.size ?? CONTROL_SIZE;
  const c = appleScheme(scheme);
  const glyphColor = active ? '#FFFFFF' : c.text;

  const button = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active, expanded }}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [
        { width: dim, height: dim, opacity: pressed ? 0.6 : 1 },
        styles.center,
      ]}
    >
      {active && (
        <View
          style={[
            styles.activeFill,
            {
              width: dim - 8,
              height: dim - 8,
              borderRadius: (dim - 8) / 2,
              backgroundColor: c.blue,
            },
          ]}
        />
      )}
      <SymbolView name={symbol} size={19} weight="medium" tintColor={glyphColor} />
    </Pressable>
  );

  // Inside a capsule: no glass of its own (the capsule provides one shared glass).
  if (cap?.inCapsule) return button;

  return (
    <GlassPanel
      variant="regular"
      interactive
      readableOverContent
      appearance={scheme}
      style={{ borderRadius: dim / 2 }}
    >
      {button}
    </GlassPanel>
  );
}

export interface ControlCapsuleProps {
  /** CircleControls to stack in one continuous glass capsule. */
  children: ReactNode;
  appearance?: 'light' | 'dark';
  size?: number;
}

export function ControlCapsule({ children, appearance, size = CONTROL_SIZE }: ControlCapsuleProps) {
  const system = useColorScheme() === 'dark' ? 'dark' : 'light';
  const scheme = appearance ?? system;
  const c = appleScheme(scheme);
  const kids = Array.isArray(children) ? children : [children];

  return (
    <CapsuleContext.Provider value={{ inCapsule: true, appearance: scheme, size }}>
      <GlassPanel
        variant="regular"
        interactive
        readableOverContent
        appearance={scheme}
        style={[styles.capsule, { width: size, borderRadius: size / 2 }]}
      >
        {kids.map((child, i) => (
          <View key={i}>
            {i > 0 && <View style={[styles.capsuleSep, { backgroundColor: c.separator }]} />}
            {child}
          </View>
        ))}
      </GlassPanel>
    </CapsuleContext.Provider>
  );
}

export interface ControlStackProps {
  children: ReactNode;
  /** Absolute top offset (caller adds safe-area inset). Mutually exclusive with `bottom`. */
  topInset?: number;
  /** Absolute bottom offset — anchors the column bottom-right (Apple Maps). */
  bottom?: number;
  /** Right inset — defaults to 12. */
  right?: number;
  /**
   * Reanimated style driving the column as it rides with the home sheet
   * (translateY + opacity per detent). Applied on the UI thread — no per-frame
   * React (docs/performance.md invariant #1).
   */
  animatedStyle?: StyleProp<AnimatedStyle<ViewStyle>>;
}

export function ControlStack({ children, topInset, bottom, right = 12, animatedStyle }: ControlStackProps) {
  // Bottom-anchored (Apple Maps, bottom-right) or top-anchored. Children keep
  // their source order top-to-bottom either way (normal column); when pinned to
  // `bottom` the last child sits nearest the sheet.
  const anchor = bottom != null ? { bottom } : { top: topInset };
  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.stack, { right, gap: CONTROL_GAP }, anchor, animatedStyle]}
    >
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  activeFill: { position: 'absolute' },
  capsule: { overflow: 'hidden' },
  capsuleSep: { height: StyleSheet.hairlineWidth, width: '100%' },
  stack: { position: 'absolute', alignItems: 'center' },
});
