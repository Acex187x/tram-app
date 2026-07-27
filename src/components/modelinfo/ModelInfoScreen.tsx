// Model reference screen ("about this tram") — rendered as a REAL native
// SwiftUI grouped-inset list (@expo/ui/swift-ui). The whole page is one native
// `List` (listStyle 'insetGrouped'), so the section cards, hairlines, uppercase
// headers, device-matched corner radii and light/dark colors are all system-
// drawn rather than re-created in JS.
//
// Order (per product spec): header (face + name + maker/years + View-in-3D) →
// Characteristics (the unified label→value grid, identical rows for every model
// so two types compare row-for-row) → About & history → Fun facts → Service in
// Prague. Content lives in '@/lib/fleet/modelHistory'; navigate with
// router.push('/model-info/' + modelId).
//
// iOS-only app: importing '@expo/ui/swift-ui' directly is safe here (there is no
// Android/web build; jest runs under jest-expo/ios and never imports this file).
import { Host } from '@expo/ui';
import {
  Button,
  HStack,
  Image,
  Label,
  LabeledContent,
  List,
  RNHostView,
  Section,
  Spacer,
  Text as UIText,
  VStack,
} from '@expo/ui/swift-ui';
import {
  buttonStyle,
  font,
  foregroundStyle,
  listRowBackground,
  listRowSeparator,
  listStyle,
  multilineTextAlignment,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, useColorScheme, View } from 'react-native';

import { TramFace } from '@/components/tram/TramFace';
import { Colors, Tram } from '@/constants/theme';
import {
  MODEL_HISTORY,
  MODEL_UNIFIED_SPECS,
  SPEC_ROWS,
  type ModelHistory,
} from '@/lib/fleet/modelHistory';
import { MODEL_SPECS } from '@/lib/fleet/modelSpecs';
import type { TramModelId } from '@/lib/types';

export default function ModelInfoScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const history: ModelHistory | undefined = MODEL_HISTORY[id as TramModelId];
  const router = useRouter();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const background = Colors[scheme].background === '#000000' ? '#000000' : '#F2F2F7';

  // Unknown / missing id → graceful back (the route can be deep-linked).
  useEffect(() => {
    if (!history) {
      if (router.canGoBack()) router.back();
      else router.replace('/');
    }
  }, [history, router]);

  if (!history) {
    return <View style={[styles.root, { backgroundColor: background }]} />;
  }

  const modelId = id as TramModelId;
  const specs = MODEL_UNIFIED_SPECS[modelId];
  const has3d = MODEL_SPECS[modelId] != null;
  const paragraphs = history.summary.split('\n\n');

  return (
    <View style={[styles.root, { backgroundColor: background }]}>
      {/* The system nav bar owns the title and the back button. It also gives
          the List a real top inset, so rows no longer scroll under a floating
          control. Regular (not large) title: the route is pushed INSIDE the
          tram form sheet, where a large-title band reads as fallen-down. */}
      <Stack.Screen
        options={{ headerShown: true, headerLargeTitleEnabled: false, headerBackTitle: 'Tram' }}
      />
      <Stack.Title>{history.title}</Stack.Title>

      <Host style={styles.host} useViewportSizeMeasurement>
        <List modifiers={[listStyle('insetGrouped')]}>
          {/* ── Header: face + name + maker/years + View in 3D ───────────── */}
          <Section>
            <HStack
              modifiers={[
                listRowBackground('clear'),
                listRowSeparator('hidden', 'all'),
              ]}
            >
              <Spacer />
              <VStack alignment="center" spacing={8}>
                <RNHostView matchContents>
                  <TramFace modelId={modelId} size={116} />
                </RNHostView>
                <UIText modifiers={[font({ textStyle: 'title2', weight: 'bold' })]}>
                  {history.title}
                </UIText>
                <UIText
                  modifiers={[font({ textStyle: 'subheadline' }), foregroundStyle('secondary')]}
                >
                  {history.maker}
                </UIText>
                <UIText
                  modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}
                >
                  {history.years}
                </UIText>
                {has3d && (
                  <Button
                    label="View in 3D"
                    systemImage="cube.transparent"
                    onPress={() => router.push(`/model/${modelId}`)}
                    modifiers={[buttonStyle('bordered'), tint(Tram.liveryRed)]}
                  />
                )}
              </VStack>
              <Spacer />
            </HStack>
          </Section>

          {/* ── Characteristics — the unified, comparable grid ───────────── */}
          <Section title="Characteristics">
            {SPEC_ROWS.map((row) => (
              <LabeledContent key={row.key} label={row.label}>
                <UIText modifiers={[multilineTextAlignment('trailing'), foregroundStyle('secondary')]}>
                  {specs[row.key]}
                </UIText>
              </LabeledContent>
            ))}
          </Section>

          {/* ── About & history ──────────────────────────────────────────── */}
          <Section title="About & history">
            {paragraphs.map((paragraph, i) => (
              <UIText key={i}>{paragraph}</UIText>
            ))}
          </Section>

          {/* ── Fun facts ────────────────────────────────────────────────── */}
          <Section title="Fun facts">
            {history.funFacts.map((fact, i) => (
              <Label
                key={i}
                title={fact}
                icon={<Image systemName="sparkles" color={Tram.gold} />}
              />
            ))}
          </Section>

          {/* ── Service in Prague (+ sources footnote) ───────────────────── */}
          <Section
            title="Service in Prague"
            footer={
              <UIText modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>
                Compiled from DPP, Škoda Transportation and Wikipedia spec sheets. Figures marked ≈
                are approximate or vary between batches; “n/a” means not published.
              </UIText>
            }
          >
            <UIText>{history.pragueService}</UIText>
          </Section>
        </List>
      </Host>
    </View>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1 },
  root: { flex: 1 },
});
