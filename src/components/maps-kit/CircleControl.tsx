// The right-edge vertical column of circular translucent map controls
// (IMG_0072/77): a 2D/3D toggle and the fused map+locate capsule. Three pieces:
//   • CircleControl  — one round glass button (or a borderless button inside a
//                      capsule); `active` fills it blue (locate while following).
//   • ControlCapsule — one continuous glass capsule wrapping stacked
//                      CircleControls, hairline-separated (the map+locate pill).
//   • ControlStack   — the absolutely-positioned top-right column.
// Chrome floats over the basemap, so appearance follows the MAP light preset.
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { createContext, useContext, type ReactNode } from 'react';
import { Pressable, StyleSheet, useColorScheme, View } from 'react-native';

import { GlassPanel } from '@/components/ui/GlassPanel';
import { Apple, appleScheme } from '@/constants/theme';

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
  /** Diameter — defaults to 46 (ignored inside a ControlCapsule, which sets it). */
  size?: number;
  appearance?: 'light' | 'dark';
}

export function CircleControl({
  symbol,
  label,
  onPress,
  active,
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
      accessibilityState={{ selected: !!active }}
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
            { width: dim - 8, height: dim - 8, borderRadius: (dim - 8) / 2 },
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
  /** Absolute top offset (caller adds safe-area inset). */
  topInset: number;
  /** Right inset — defaults to 12. */
  right?: number;
}

export function ControlStack({ children, topInset, right = 12 }: ControlStackProps) {
  return (
    <View pointerEvents="box-none" style={[styles.stack, { top: topInset, right, gap: CONTROL_GAP }]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  activeFill: {
    position: 'absolute',
    backgroundColor: Apple.blue,
  },
  capsule: { overflow: 'hidden' },
  capsuleSep: { height: StyleSheet.hairlineWidth, width: '100%' },
  stack: { position: 'absolute', alignItems: 'center' },
});
