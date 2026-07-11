# Expo SDK 57 iOS-Native / Liquid Glass UI — Implementation Cheat-Sheet

Digest of the official Expo skills (`expo-native-ui` 1.1.1, `expo-ui` 1.0.0, `expo-router` 1.0.1, `expo-dev-client` 1.1.0, `expo-data-fetching` 1.0.0 — plugin cache `expo/1.7.0`) plus the actual API surface of the installed packages in this repo. Target: production Expo SDK 57 iOS app (RN 0.86, React 19.2, new architecture) rendering Prague trams on a 3D Mapbox map with a maximally iOS-native Liquid Glass shell.

> **Source-of-truth rule (from the skills):** `@expo/ui` and `expo-glass-effect` are versioned *with the SDK*. The installed package's `.d.ts` in `node_modules` is authoritative for your version; the online docs track "latest". Everything below was read from the installed 57.0.x packages in this repo. Do not guess prop names — they are transcribed verbatim here.

## 0. Installed versions in this repo (verified from `node_modules`)

| Package | Version | Notes |
|---|---|---|
| `expo` | 57.0.4 | |
| `@expo/ui` | 57.0.4 | universal + `swift-ui` + `community` all present |
| `expo-glass-effect` | 57.0.0 | GlassView/GlassContainer, iOS 26+ only |
| `expo-router` | 57.0.4 | |
| `expo-symbols` | 57.0.0 | installed (SymbolView) — **present despite native-ui skill nudging you to `expo-image` `sf:`** |
| `expo-image` | 57.0.0 | can render SF Symbols via `source="sf:name"` |
| `react-native` | 0.86.0 | |
| `react` / `react-dom` | 19.2.3 | |
| `react-native-reanimated` | 4.5.0 | |
| `react-native-worklets` | 0.10.0 | required for `useNativeState` synchronous UI-thread updates |
| `react-native-screens` | 4.25.2 | powers Stack, form sheets, toolbars |
| `react-native-safe-area-context` | 5.7.0 | |

**NOT installed yet (implementer must add):** `expo-blur` (glass fallback), `@rnmapbox/maps` (the map), `@tanstack/react-query` (recommended for polling). See §7 and Risks.

---

## 1. `expo-glass-effect` — Liquid Glass (iOS 26+)

Import path: `import { GlassView, GlassContainer, isLiquidGlassAvailable, isGlassEffectAPIAvailable } from 'expo-glass-effect';`

Native iOS liquid glass via `UIVisualEffectView`. **iOS 26+ only.** On older iOS / Android it silently falls back to a plain RN `View` (the `.tsx` non-iOS build just renders `<View {...props} />`), so props like `glassEffectStyle` are simply ignored — you must provide your own visual fallback (BlurView / solid) if you want glass-like appearance pre-iOS-26.

### `GlassView` props (exact, from `GlassView.types.ts`)

```ts
type GlassStyle = 'clear' | 'regular' | 'none';

type GlassEffectStyleConfig = {
  style: GlassStyle;
  animate?: boolean;            // default false
  animationDuration?: number;   // seconds; system default if unset
};

type GlassColorScheme = 'auto' | 'light' | 'dark';

type GlassViewProps = {
  glassEffectStyle?: GlassStyle | GlassEffectStyleConfig; // default 'regular'
  tintColor?: string;
  isInteractive?: boolean;      // default false — enables press/deform response
  colorScheme?: GlassColorScheme; // default 'auto' — override when app has its own theme toggle
  ref?: Ref<View>;
} & ViewProps;                  // accepts style, children, etc.
```

- **`regular` vs `clear`:** `regular` is the default frosted material that adapts contrast to the backdrop — use for chrome that sits over the map and must stay legible (control clusters, cards, sheet backgrounds). `clear` is a thinner, more transparent glass — use for elements over high-contrast/imagery where you want the map to read through strongly (e.g. a floating pill on a dark map). `none` disables the effect (renders inert).
- **`isInteractive`:** set to `true` for anything pressable (glass buttons/FABs) so the glass reacts to touch like native iOS 26 controls. Wrap a `Pressable` inside the `GlassView`.
- **`tintColor`:** adds a colored wash — good for a branded accent FAB, but keep subtle for legibility.
- **Rounded corners** work directly via `style={{ borderRadius }}` — unlike `BlurView`, `GlassView` does **not** need `overflow:'hidden'`.

### `GlassContainer` props (from `GlassContainer.types.ts`)

```ts
type GlassContainerProps = {
  spacing?: number;   // distance at which child glass elements begin to merge; default undefined
  ref?: Ref<View>;
} & ViewProps;
```

Wrap multiple `GlassView`s in a `GlassContainer` to get the native "gooey merge" where nearby glass elements fuse as they approach (`spacing` controls the merge threshold). Ideal for a cluster of map control buttons that should coalesce.

### Availability checks (call BEFORE rendering glass to avoid iOS-26-beta crashes)

```ts
import { isLiquidGlassAvailable, isGlassEffectAPIAvailable } from 'expo-glass-effect';
```

- `isGlassEffectAPIAvailable()` — the API actually exists on this device. **Some iOS 26 betas ship without it and crash** (expo/expo#40911). Guard with this if targeting betas.
- `isLiquidGlassAvailable()` — the app is *using* the Liquid Glass design (components available). May also be `true` when accessibility transparency-limiting is on. To detect the user disabling glass via accessibility, additionally check `AccessibilityInfo.isReduceTransparencyEnabled()`.

### Recommended fallback wrapper (from `visual-effects.md`) — needs `expo-blur`

```tsx
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { BlurView } from 'expo-blur'; // NOT yet installed — `npx expo install expo-blur`

function AdaptiveGlass({ children, style }) {
  if (isLiquidGlassAvailable()) return <GlassView style={style}>{children}</GlassView>;
  return <BlurView tint="systemMaterial" intensity={80} style={style}>{children}</BlurView>;
}
```

### Glass button pattern (map FAB)

```tsx
<GlassView isInteractive style={{ borderRadius: 50 }}>
  <Pressable style={{ padding: 12 }} onPress={onPress}>
    <SymbolView name="location.fill" tintColor={colors.label} size={24} />
  </Pressable>
</GlassView>
```

---

## 2. `@expo/ui` — real SwiftUI from React

Two layers. **Decision order: use universal first; drop to `swift-ui` only when universal lacks what you need** (accepts an `.ios.tsx`/`.android.tsx` split). Every tree — universal OR platform — must be wrapped in `Host`, and **`Host` is always imported from the universal root `@expo/ui`**, never from `@expo/ui/swift-ui`.

- Universal: `import { Host, Column, Row, Button, Text, List, ListItem, Picker, Slider, Switch, BottomSheet, FieldGroup, Icon, ... } from '@expo/ui';`
- iOS-only SwiftUI: `import { ... } from '@expo/ui/swift-ui';` and modifiers from `@expo/ui/swift-ui/modifiers`.
- Drop-in community swaps: `@expo/ui/community/<name>`.

> Works in Expo Go on SDK 56+, but this app uses a dev client (Mapbox is native), so that's moot.
> **`@expo/ui/swift-ui` is iOS-only** — importing it in code that runs on Android crashes with "Unable to get view config". Isolate in `.ios.tsx` files in `components/` (NOT in `app/` — Expo Router rejects platform-extension route files), or guard with `Platform.OS === 'ios'`.

### 2a. Universal components (SDK 56+) — exact props

Exported from `@expo/ui` root: `Host, Column, Row, Spacer, ScrollView, Text, Icon, Button, Switch, Checkbox, Slider, TextInput, Picker, BottomSheet, Collapsible, List, ListItem, FieldGroup, RNHostView, useNativeState` (State).

**`Host`** (`UniversalHostProps extends ViewProps`) — the required root:
```ts
matchContents?: boolean | { vertical?: boolean; horizontal?: boolean }; // size RN view to native content; set once on mount
colorScheme?: 'light' | 'dark';   // force appearance for subtree (omit = follow device)
seedColor?: ColorValue;           // iOS: applied as SwiftUI tint, themes buttons/switches/sliders
layoutDirection?: 'leftToRight' | 'rightToLeft';
ignoreSafeArea?: 'all' | 'keyboard'; // set once on mount
useViewportSizeMeasurement?: ...; onLayout / onLayoutContent; style;
```
Use `<Host matchContents>` when embedding a small native island (e.g. a control) inline; give it an explicit `style` height when it must fill a region.

**`Button`** (`ButtonProps extends UniversalBaseProps`):
```ts
label?: string;                 // or use children
children?: React.ReactNode;     // when provided, label ignored
onPress?: () => void;
variant?: 'filled' | 'outlined' | 'text';  // default 'filled'
// + UniversalBaseProps: style, disabled, hidden, onAppear, onDisappear, testID
```

**`Picker`** (`PickerProps<T = string|number>`) + `Picker.Item`:
```ts
selectedValue: T;
onValueChange: (value: T) => void;
appearance?: 'wheel' | 'menu';  // default 'menu' (compact dropdown); 'wheel' = iOS rotor
enabled?: boolean;              // default true
children?: ReactNode;           // <Picker.Item label value />
// Picker.Item: { label: string; value: string|number }
```
```tsx
<Picker selectedValue={line} onValueChange={setLine} appearance="menu">
  <Picker.Item label="Tram 22" value="22" />
  <Picker.Item label="Tram 9"  value="9" />
</Picker>
```

**`Slider`** (`SliderProps`): `value, onValueChange, min, max, step, disabled, testID`.

**`Switch`** (`SwitchProps`): `value, onValueChange, label, disabled, testID`.

**`BottomSheet`** (`BottomSheetProps`) — universal, self-managed visibility:
```ts
isPresented: boolean;
onDismiss: () => void;          // required — fired on swipe-down / overlay tap
children?: React.ReactNode;
showDragIndicator?: boolean;    // default true
snapPoints?: SnapPoint[];       // omit = auto-size to content
testID?: string;
// SnapPoint = 'half' | 'full' | { fraction: number } | { height: number }
//   ({fraction}/{height} are iOS/web only; Android snaps to nearest half/full)
```
> For the tram app, a route-driven **Expo Router form sheet** (§4) is usually the better fit for the map-detail sheet because it integrates with navigation/back. Use `@expo/ui` `BottomSheet` only for a purely local, non-routed sheet.

**`List` + `ListItem`** (grouped rows):
```ts
// List: { children; testID }   — plus swift-ui List supports selection (see 2b)
// ListItem:
children?: ReactNode;           // headline
onPress?: () => void;           // whole-row tap
leading?: ReactNode;            // or <ListItem.Leading>
trailing?: ReactNode;           // or <ListItem.Trailing>
supportingText?: string | ReactNode; // subtitle, or <ListItem.Supporting>
// Slots: ListItem.Leading / ListItem.Trailing / ListItem.Supporting
```
> **Perf warning (skill):** `List` is NOT for large datasets — each `ListItem` is a JS-thread JSX node. For a long list of trams/stops use RN `FlatList`/`SectionList`, not `@expo/ui` `List`.

**`FieldGroup`** — the universal grouped **settings form** (SwiftUI `Form` analog). Use this for a settings/preferences screen:
```ts
// FieldGroup: { children }  (non-section children render inline, like SwiftUI Form)
// FieldGroup.Section: { children; title?: string; titleUppercase?: boolean (ignored on iOS) }
// FieldGroup.SectionHeader / FieldGroup.SectionFooter: { children }
```
```tsx
<Host style={{ flex: 1 }}>
  <FieldGroup>
    <FieldGroup.Section title="Map">
      <Switch value={show3D} onValueChange={setShow3D} label="3D buildings" />
      <Picker selectedValue={style} onValueChange={setStyle}>...</Picker>
    </FieldGroup.Section>
    <FieldGroup.Section title="Alerts">
      <Switch value={notify} onValueChange={setNotify} label="Delay alerts" />
    </FieldGroup.Section>
  </FieldGroup>
</Host>
```

**`Icon`** — native SF Symbol (iOS) / vector drawable (Android):
```tsx
<Icon name={Icon.select({ ios: 'tram.fill', android: import('@expo/material-symbols/tram.xml') })} size={24} color="orange" />
```

**`TextInput` + `useNativeState`** (only if you need flicker-free UI-thread text, e.g. formatting-as-you-type): `value`/`selection` take an `ObservableState` from `useNativeState`, NOT a plain string; `onChangeText` is a `'worklet'`. Requires `react-native-worklets` (installed). For ordinary search, RN `Stack.SearchBar` (§4) is simpler.

### 2b. Platform-specific `@expo/ui/swift-ui` (iOS-only, richer SwiftUI)

Available components in this install (`node_modules/@expo/ui/build/swift-ui`): `Host, VStack, HStack, LazyVStack, LazyHStack, Grid, Group, ScrollView, Form, Section, List (List.ForEach), Text, Label, LabeledContent, Image, Button, Picker, Slider, Stepper, Toggle, SyncToggle, TextField, SecureField, ColorPicker, DatePicker, Divider, Spacer, Menu, ContextMenu, ConfirmationDialog, Alert, Popover, BottomSheet, DisclosureGroup, ControlGroup, ProgressView, Gauge, Chart, Link, ShareLink, TabView, Namespace, Mask, Overlay, SwipeActions, GlassEffectContainer, ContentUnavailableView, AccessoryWidgetBackground, Shapes, RNHostView` + modifiers.

Notable for this app (drop down only when universal falls short):

- **`ContextMenu`** — SwiftUI long-press context menu with a preview, richer than the universal layer. (Also see Expo Router `Link.Menu` in §4 for navigation-attached menus.)
- **`BottomSheet`** (swift-ui) — controlled sheet with more control than universal:
  ```ts
  { isPresented: boolean; onIsPresentedChange: (v:boolean)=>void; onDismiss?; fitToContents?; children }
  ```
- **`Section`** (swift-ui) — `{ title?; header?; footer?; isExpanded?; onIsExpandedChange? }` — collapsible form sections.
- **`List`** (swift-ui) — supports `selection?: (string|number)[]` + `onSelectionChange`, and `List.ForEach`. Native edit/selection.
- **`Picker`** (swift-ui) — `{ systemImage?: SFSymbol; label?; selection?: T; onSelectionChange?(T) }`.
- **`Button`** (swift-ui) — `{ onPress?; systemImage?: SFSymbol; role?: 'default'|'cancel'|'destructive'; label?; children? }`.
- **`Slider`** (swift-ui) — richer than universal: `{ value?; step?; min?; max?; lowerLimit?; upperLimit?; label?; minimumValueLabel?; maximumValueLabel?; onValueChange?; onEditingChanged? }`.
- **`GlassEffectContainer`** — SwiftUI-tree equivalent of `expo-glass-effect`'s container; use inside a SwiftUI tree.
- **`ContentUnavailableView`** — native empty state ("No trams nearby").
- **`Chart`, `Gauge`, `ProgressView`** — native charts/indicators for a tram-detail screen.
- **`RNHostView`** — embed an RN component (e.g. a Mapbox marker callout) inside a SwiftUI tree: `<Host><VStack><RNHostView matchContents><Pressable/></RNHostView></VStack></Host>`.

Before writing swift-ui code, run the skill's lister for exact modifier list:
`node <expo-ui-skill-root>/scripts/list-components.js /Users/acex/git/fable-spots-the-tram --docs`

### 2c. Drop-in replacements (only if migrating off an RN community lib)

`@expo/ui/community/<name>` — API-compatible swaps: `bottom-sheet` (`import BottomSheet, { BottomSheetView }`), `datetime-picker` (default), `masked-view` (`{ MaskedView }`), `menu` (`{ MenuView }`), `pager-view` (default), `picker` (`{ Picker }`), `segmented-control` (default), `slider` (default). Not part of the universal-vs-platform decision — only for replacing an existing dependency.

---

## 3. `expo-symbols` (SF Symbols) — installed, and the `expo-image` alternative

Two valid ways to render SF Symbols; both installed:

1. **`expo-image` `sf:` source** — the native-ui skill's stated preference ("`expo-image` with `source="sf:name"` for SF Symbols, not `expo-symbols` or `@expo/vector-icons`"). Simplest for static icons in RN layout.
2. **`expo-symbols` `SymbolView`** — used throughout the visual-effects/glass examples; richer (animation, weight, palette). Use when you want animations or multicolor.

`import { SymbolView, type SFSymbol } from 'expo-symbols';`

`SymbolViewProps` (exact):
```ts
name: SFSymbol | { ios?: SFSymbol; android?; web? };
fallback?: React.ReactNode;
type?: 'monochrome' | 'hierarchical' | 'palette' | 'multicolor';
scale?: 'default' | 'unspecified' | 'small' | 'medium' | 'large';
weight?: 'ultraLight'|'thin'|'light'|'regular'|'medium'|'semibold'|'bold'|'heavy'|'black'|'unspecified';
colors?: ColorValue | ColorValue[];
size?: number;
tintColor?: ColorValue;
resizeMode?: ContentMode; // 'scaleAspectFit' etc.
animationSpec?: {           // effect { type: 'bounce'|'pulse'|'scale', ... }, repeating, repeatCount, speed, variableAnimationSpec }
};
& ViewProps
```
Relevant SF Symbols for a tram app: `tram.fill`, `tram.fill.tunnel`, `location.fill`, `location.north.line.fill`, `mappin.and.ellipse`, `clock.fill`, `arrow.triangle.turn.up.right.diamond.fill`, `line.3.horizontal.decrease`, `star`, `star.fill`, `gear`, `xmark`.

In `NativeTabs`/toolbars, pass SF names to `sf=` / `icon=` props directly (no import needed).

---

## 4. `expo-router` — map-as-root + modals/sheets, NativeTabs, header search, Link previews

Import roots: `import { Link, Stack, Color } from 'expo-router';` · `import { NativeTabs } from 'expo-router/unstable-native-tabs';` · `import { Stack } from 'expo-router/stack';`. **SDK 56+: never import `@react-navigation/*` directly — use `expo-router/react-navigation`.**

### 4a. Map as root screen with a form sheet floating over it (THE core pattern)

The tram app wants the full-screen Mapbox map always visible, with a draggable detail sheet that lets you keep panning the map beneath it. Use a **native form sheet** with `sheetLargestUndimmedDetentIndex` so the map stays interactive:

```tsx
// app/_layout.tsx
import { Stack } from 'expo-router';
export default function Layout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />                 {/* full-screen map */}
      <Stack.Screen
        name="tram/[id]"                             {/* detail sheet over the map */}
        options={{
          presentation: 'formSheet',
          sheetAllowedDetents: [0.2, 0.5, 1.0],       // 3 stops
          sheetLargestUndimmedDetentIndex: 1,         // map stays pannable at detents 0 & 1, dims at full
          sheetGrabberVisible: true,
          headerTransparent: true,
          contentStyle: { backgroundColor: 'transparent' }, // -> liquid glass sheet bg on iOS 26+
        }}
      />
    </Stack>
  );
}
```

- **`contentStyle: { backgroundColor: 'transparent' }` makes the sheet background liquid glass on iOS 26+** (skill-confirmed). Style your own content container's background instead.
- `sheetLargestUndimmedDetentIndex` (zero-indexed) is the key to "pan the map behind the sheet."
- Sheet content root must be `flex: 1` for footer positioning to work.
- `presentation: 'modal'` for a full-cover modal (settings, route planner) that shouldn't keep the map interactive.

### 4b. NativeTabs (iOS 26 liquid-glass tab bar, auto)

`import { NativeTabs } from 'expo-router/unstable-native-tabs';` — SDK 55+ syntax uses compound components:

```tsx
<NativeTabs minimizeBehavior="onScrollDown">
  <NativeTabs.Trigger name="(map)">
    <NativeTabs.Trigger.Icon sf="map.fill" md="map" />
    <NativeTabs.Trigger.Label>Map</NativeTabs.Trigger.Label>
  </NativeTabs.Trigger>
  <NativeTabs.Trigger name="(favorites)" role="favorites">
    <NativeTabs.Trigger.Icon sf="star.fill" md="star" />
    <NativeTabs.Trigger.Label>Favorites</NativeTabs.Trigger.Label>
  </NativeTabs.Trigger>
  <NativeTabs.Trigger name="(search)" role="search">   {/* keep search LAST */}
    <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
  </NativeTabs.Trigger>
</NativeTabs>
```

- Tab bar **auto-adopts liquid glass on iOS 26+** — no config.
- `role="search"` integrates the tab with a header search bar; put it last.
- `NativeTabs.BottomAccessory` renders content above the tab bar (iOS 26+), perfect for a persistent "nearest tram" mini-bar; `NativeTabs.BottomAccessory.usePlacement()` returns `'regular'|'inline'`. **Two instances render at once — keep its state in props/context/store, not local state.**
- Tabs must be **static** (no runtime add/remove — remounts navigator, loses state). `hidden` only at initial render.
- `<NativeTabs tintColor={...}>` — use `DynamicColorIOS({light,dark})` for a tint that adapts to glass.
- NativeTabs render no headers — nest a `<Stack>` inside each tab group for titles/headers.
- Wrap the app in a `ThemeProvider` (from `expo-router/react-navigation`) or header buttons flicker across tab switches.
- **Caveat for a map tab:** the map screen has no ScrollView; if the tab bar goes unexpectedly transparent on iOS ≤18 set `disableTransparentOnScrollEdge: true` on that Trigger. Android max 5 tabs.

### 4c. Header search bar

Prefer `Stack.SearchBar` (skill's stated preference). Two APIs:

```tsx
// Declarative, in the screen body (iOS):
<Stack.SearchBar placeholder="Search lines & stops" onChangeText={(e) => setQ(e.nativeEvent.text)} />
```
or via options:
```tsx
<Stack.Screen options={{ headerSearchBarOptions: {
  placeholder: 'Search', onChangeText: (e)=>setQ(e.nativeEvent.text),
  hideWhenScrolling: true, placement: 'automatic', // 'inline' | 'stacked'
  onCancelButtonPress: ()=>setQ(''),
}}} />
```
A reusable `useSearch()` hook pattern (wraps `navigation.setOptions`) + debounce are in the search reference. With `NativeTabs` + a `role="search"` tab, the search bar combines with the tab bar.

### 4d. Toolbars (native header/bottom bars over the map)

`Stack.Toolbar` (iOS only, SDK 55+) — put map controls in a native bottom toolbar:
```tsx
<Stack.Toolbar placement="bottom">   {/* 'left' | 'right' | 'bottom'(default) */}
  <Stack.Toolbar.Button icon="location.fill" onPress={recenter} />
  <Stack.Toolbar.Menu icon="line.3.horizontal.decrease">
    <Stack.Toolbar.MenuAction icon="tram" isOn>Trams</Stack.Toolbar.MenuAction>
    <Stack.Toolbar.MenuAction icon="bus">Buses</Stack.Toolbar.MenuAction>
  </Stack.Toolbar.Menu>
  <Stack.Toolbar.Spacer />
</Stack.Toolbar>
```
- `Button` props: `icon, image, onPress, disabled, hidden, variant('plain'|'done'|'prominent'), tintColor, selected, separateBackground`.
- All `Stack.Toolbar.*` must be **direct children** of `Stack.Toolbar` (can't be nested in your own wrapper component — extract the whole `<Stack.Toolbar>…</Stack.Toolbar>` instead).
- `placement="bottom"` only works inside a **screen** component, not a layout file.
- Header `Spacer` needs explicit `width`. `Badge` only on `left`/`right`.

### 4e. Link previews + context menus (peek at a tram/stop before navigating)

```tsx
<Link href={`/tram/${id}`}>
  <Link.Trigger><Pressable><TramRow/></Pressable></Link.Trigger>
  <Link.Preview />                         {/* iOS peek preview of the destination */}
  <Link.Menu>
    <Link.MenuAction title="Favorite" icon="star" onPress={fav} />
    <Link.MenuAction title="Hide line" icon="eye.slash" destructive onPress={hide} />
  </Link.Menu>
</Link>
```
The skill says: add `Link.Preview` and `Link.Menu` frequently — it's the idiomatic iOS peek/pop + long-press menu. Also `Link.AppleZoom` exists for fluid zoom transitions (iOS 18+).

### 4f. Route structure suggestion for this app

```
app/
  _layout.tsx            <NativeTabs> (Map / Favorites / Search) wrapped in ThemeProvider
  (map)/
    _layout.tsx          <Stack headerShown:false> (root map + sheets/modals)
    index.tsx            full-screen Mapbox map (root "/")
    tram/[id].tsx        formSheet detail (undimmed so map pans behind)
    settings.tsx         presentation:'modal' -> FieldGroup form
  (favorites)/ _layout.tsx + index.tsx
  (search)/ _layout.tsx + index.tsx  (role="search")
```
Rules: routes only in `app/`; never co-locate components/types there; keep `.ios.tsx` SwiftUI islands in `components/`; kebab-case filenames; always match a `/` route.

---

## 5. Theming — semantic iOS colors, dark mode

Use the **`Color` API from `expo-router`** (type-safe wrapper over `PlatformColor`), not raw `PlatformColor`. It resolves on-device and auto-adapts to light/dark + accessibility, so you don't maintain hex tables.

```tsx
// theme/colors.ts
import { Platform } from 'react-native';
import { Color } from 'expo-router';

export const colors = {
  label:            Platform.select({ ios: Color.ios.label,             android: Color.android.dynamic.onSurface,        default: '#000' })!,
  secondaryLabel:   Platform.select({ ios: Color.ios.secondaryLabel,    android: Color.android.dynamic.onSurfaceVariant, default: '#3c3c43' })!,
  separator:        Platform.select({ ios: Color.ios.separator,         android: Color.android.dynamic.outlineVariant,   default: '#c6c6c8' })!,
  systemBackground: Platform.select({ ios: Color.ios.systemBackground,  android: Color.android.dynamic.surface,          default: '#fff' })!,
  systemBlue:       Platform.select({ ios: Color.ios.systemBlue,        android: Color.android.dynamic.primary,          default: '#007aff' })!,
};
```

- iOS re-resolves these automatically on theme change. **On Android, call `useColorScheme()` inside any component using them** so it re-renders (React Compiler memoization).
- **Do NOT pass `Color`/`PlatformColor` into Reanimated styles** — use static colors in animated styles (map marker animations, etc.).
- `Platform.select({...})!` returns `string | OpaqueColorValue`; some third-party props want a plain `string` (e.g. `expo-image` `tintColor`) — cast: `colors.label as string`.
- For NativeTabs tint that adapts to glass, use `DynamicColorIOS({ light, dark })`.
- Glass surfaces: prefer `glassEffectStyle` / `BlurView tint="systemMaterial"` which adapt to dark mode automatically rather than hardcoded translucent hexes.

---

## 6. Styling rules (Apple HIG, from native-ui skill)

- **No CSS/Tailwind** — inline styles only (StyleSheet.create only if reuse is faster).
- Prefer flex `gap` over margins; padding over margin.
- `{ borderCurve: 'continuous' }` on rounded corners (not capsules).
- Shadows: CSS `boxShadow` string (`'0 1px 2px rgba(0,0,0,0.05)'`), never legacy RN `shadow*`/`elevation`.
- Safe area: use `ScrollView`/`FlatList` `contentInsetAdjustmentBehavior="automatic"` (NOT `SafeAreaView`); account for both top & bottom insets. For non-scroll map screen, rely on stack header/tab insets or `react-native-safe-area-context`.
- A Stack screen's first child should almost always be a ScrollView with `contentInsetAdjustmentBehavior="automatic"` — but the **map screen is the exception** (full-bleed map, no scroll; drive insets via glass overlays positioned with safe-area insets).
- Always use a **navigation stack title** (`Stack.Title` / `Stack.Screen.Title`), not a custom on-page text header.
- `useWindowDimensions()` over `Dimensions.get()`; flexbox over `Dimensions`.
- `process.env.EXPO_OS` over `Platform.OS`; `React.use` over `useContext`.
- `<Text selectable>` on copyable data (tram IDs, times); `{ fontVariant: ['tabular-nums'] }` on counters/times.
- Haptics: use `expo-haptics` conditionally on iOS for delight.

---

## 7. Data fetching — recommendation for polling the tram API

Skill guidance: **avoid `axios`, prefer `expo/fetch`.** Decision tree says: **complex app → React Query (TanStack Query); simpler → SWR or custom hooks.** A real-time vehicle-position app (frequent polling, caching, dedup, refetch, offline, background) is squarely "complex" → **use `@tanstack/react-query`** (not yet installed — `npx expo install @tanstack/react-query`).

Why React Query here:
- `refetchInterval` gives clean polling (e.g. every 2–5s for vehicle positions) with automatic pause when the app backgrounds.
- Automatic request dedup + `staleTime` caching + `AbortController` cancellation (it cancels in-flight on unmount/refetch automatically).
- Built-in retry/backoff and error/loading states.

Setup (from skill):
```tsx
// app/_layout.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5*60*1000, retry: 2 } } });
// wrap the whole app: <QueryClientProvider client={queryClient}> ... </QueryClientProvider>
```
Polling query:
```tsx
const { data } = useQuery({
  queryKey: ['vehicles', bbox],
  queryFn: ({ signal }) => fetch(`${API}/vehiclepositions?...`, { signal }).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json();
  }),
  refetchInterval: 3000,          // poll every 3s
  refetchIntervalInBackground: false,
});
```
Notes:
- **Always check `response.ok`** before `.json()` (skill "common mistake").
- API config via `EXPO_PUBLIC_` env vars, inlined at build time; restart dev server after `.env` edits. Golemio needs an API key header — a read-scoped key can be `EXPO_PUBLIC_`, but a sensitive key should go through an API route (non-prefixed env), not the client bundle.
- Tokens/secrets → `expo-secure-store`, never AsyncStorage.
- Offline: `@react-native-community/netinfo` for status + React Query persistence (see `offline-and-cancellation.md`).
- **Caveat:** for a smooth-moving map you'll interpolate positions between polls on the client (Reanimated / rAF) rather than re-rendering markers on every fetch — React Query supplies the keyframes, not the per-frame animation.

Alternative (if you want to avoid the dep): plain `expo/fetch` inside a custom `useVehicles()` hook with `setInterval` + `AbortController` + `AppState` gating. Works, but you reimplement dedup/backoff/background-pause that React Query gives free.

---

## 8. Dev client build — iOS simulator with CNG

This app **requires a dev client** (Mapbox native module + config plugins; not in Expo Go). Continuous Native Generation (CNG) means `ios/` is generated, not committed.

Local run loop (fastest iteration — no EAS cost):
```bash
npx expo install <native deps>      # e.g. @rnmapbox/maps, expo-blur, @tanstack/react-query
npx expo prebuild                    # generate ios/ (and android/) from app.json/config plugins (CNG)
# or: npx expo prebuild --clean      # nuke & regenerate when native config changed
npx expo run:ios                     # build + install + launch on the iOS simulator, starts Metro
# target a specific sim:
npx expo run:ios --device "iPhone 16 Pro"
npx expo run:ios --configuration Release   # test a release build locally
```
- `npx expo run:ios` implicitly prebuilds if `ios/` is missing; run `prebuild` explicitly to inspect generated native config or after changing plugins.
- After the dev client is installed once, day-to-day you only need Metro: `npx expo start --dev-client` (rebuild natively only when native deps/config change).
- **Mapbox needs a download token** in the Podfile/gradle — it's a config-plugin/env setup (`RNMapboxMapsDownloadToken`); prebuild wires it via the `@rnmapbox/maps` plugin in `app.json`. iOS 26 + liquid glass require **Xcode 26 SDK**; build against it so glass renders.

EAS (paid; for TestFlight/device distribution — task #11):
```jsonc
// eas.json
{ "cli": { "version": ">= 16.0.1", "appVersionSource": "remote" },
  "build": { "development": { "autoIncrement": true, "developmentClient": true },
             "production": { "autoIncrement": true } },
  "submit": { "production": {}, "development": {} } }
```
```bash
eas build -p ios --profile development            # cloud dev client
eas build -p ios --profile development --local     # local .ipa/.app (needs Xcode)
eas build -p ios --profile development --submit    # build + TestFlight in one step
# install a local sim build:
tar -xzf build-*.tar.gz && xcrun simctl install booted ./path/to/App.app
```
`developmentClient: true` bundles `expo-dev-client`; `autoIncrement` bumps build numbers; `appVersionSource: "remote"` = EAS is version source of truth. Clear cache with `--clear-cache`; fix signing via `eas credentials`.

---

## Quick import reference (copy-paste)

```ts
import { GlassView, GlassContainer, isLiquidGlassAvailable, isGlassEffectAPIAvailable } from 'expo-glass-effect';
import { Host, Column, Row, Text, Button, Switch, Slider, Picker, List, ListItem, BottomSheet, FieldGroup, Icon, useNativeState } from '@expo/ui';
import { VStack, HStack, Section, ContextMenu, ContentUnavailableView, Chart, GlassEffectContainer, RNHostView } from '@expo/ui/swift-ui'; // iOS-only files
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Link, Stack, Color } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { ThemeProvider, DarkTheme, DefaultTheme } from 'expo-router/react-navigation';
import { useQuery, QueryClient, QueryClientProvider } from '@tanstack/react-query'; // add dep
```
