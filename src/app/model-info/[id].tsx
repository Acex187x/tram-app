// Model reference screen ("about this tram", the big version): history, fun
// facts, spec table and Prague-service notes for one tram model. Full-screen
// push registered in _layout as model-info/[id]; navigate with
// router.push('/model-info/' + modelId). Content lives in
// '@/lib/fleet/modelHistory'; header art is the model's TramFace.
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { InsetGroup, RowSeparator, SectionLabel } from '@/components/favorites/InsetGroup';
import { TramFace } from '@/components/tram/TramFace';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { SheetContent } from '@/components/ui/SheetContent';
import { Colors, Tram } from '@/constants/theme';
import { MODEL_HISTORY, type ModelHistory } from '@/lib/fleet/modelHistory';
import { MODEL_SPECS } from '@/lib/fleet/modelSpecs';
import type { TramModelId } from '@/lib/types';

export default function ModelInfoScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const history: ModelHistory | undefined = MODEL_HISTORY[id as TramModelId];
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const background = scheme === 'dark' ? '#0B0B0D' : '#F2F2F6';

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
  const has3d = MODEL_SPECS[modelId] != null;
  const paragraphs = history.summary.split('\n\n');

  const onBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  return (
    <View style={[styles.root, { backgroundColor: background }]}>
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: insets.bottom + 32, paddingTop: insets.top + 56 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <SheetContent style={styles.column}>
          {/* ── Header: face + name + maker/years ────────────────────────── */}
          <View style={styles.header}>
            <TramFace modelId={modelId} size={112} />
            <Text style={[styles.title, { color: c.text }]}>{history.title}</Text>
            <Text style={[styles.subtitle, { color: c.textSecondary }]}>
              {history.maker}
            </Text>
            <Text style={[styles.years, { color: c.textSecondary }]}>{history.years}</Text>

            {has3d && (
              <GlassPanel variant="clear" interactive style={styles.viewerButtonGlass}>
                <Pressable
                  onPress={() => router.push(`/model/${modelId}`)}
                  style={({ pressed }) => [styles.viewerButton, pressed && { opacity: 0.6 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`View ${history.title} in 3D`}
                >
                  <SymbolView name="cube.transparent" size={15} tintColor={Tram.liveryRed} />
                  <Text style={[styles.viewerButtonText, { color: c.text }]}>View in 3D</Text>
                </Pressable>
              </GlassPanel>
            )}
          </View>

          {/* ── About & history ──────────────────────────────────────────── */}
          <SectionLabel>About & history</SectionLabel>
          <InsetGroup style={styles.group}>
            <View style={styles.cardPadding}>
              {paragraphs.map((paragraph, i) => (
                <Text
                  key={i}
                  style={[
                    styles.paragraph,
                    { color: c.text },
                    i < paragraphs.length - 1 && styles.paragraphGap,
                  ]}
                >
                  {paragraph}
                </Text>
              ))}
            </View>
          </InsetGroup>

          {/* ── Fun facts ────────────────────────────────────────────────── */}
          <SectionLabel>Fun facts</SectionLabel>
          <InsetGroup style={styles.group}>
            {history.funFacts.map((fact, i) => (
              <View key={i}>
                {i > 0 && <RowSeparator inset={44} />}
                <View style={styles.factRow}>
                  <SymbolView
                    name="sparkles"
                    size={16}
                    tintColor={Tram.gold}
                    style={styles.factIcon}
                  />
                  <Text style={[styles.factText, { color: c.text }]}>{fact}</Text>
                </View>
              </View>
            ))}
          </InsetGroup>

          {/* ── Specifications ───────────────────────────────────────────── */}
          <SectionLabel>Specifications</SectionLabel>
          <InsetGroup style={styles.group}>
            {history.specs.map((spec, i) => (
              <View key={spec.label}>
                {i > 0 && <RowSeparator />}
                <View style={styles.specRow}>
                  <Text style={[styles.specLabel, { color: c.textSecondary }]}>{spec.label}</Text>
                  <Text style={[styles.specValue, { color: c.text }]}>{spec.value}</Text>
                </View>
              </View>
            ))}
          </InsetGroup>

          {/* ── Service in Prague ────────────────────────────────────────── */}
          <SectionLabel>Service in Prague</SectionLabel>
          <InsetGroup style={styles.group}>
            <View style={styles.cardPadding}>
              <Text style={[styles.paragraph, { color: c.text }]}>{history.pragueService}</Text>
            </View>
          </InsetGroup>

          <Text style={[styles.sourcesNote, { color: c.textSecondary }]}>
            Compiled from DPP, Škoda Transportation and public transit-history sources.
            Figures marked ≈ are approximate or vary between batches.
          </Text>
        </SheetContent>
      </ScrollView>

      {/* Back — floats over the scroll, top-left */}
      <GlassPanel
        variant="clear"
        interactive
        style={[styles.backGlass, { top: insets.top + 8 }]}
      >
        <Pressable
          onPress={onBack}
          hitSlop={10}
          style={({ pressed }) => [styles.backPress, pressed && { opacity: 0.6 }]}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <SymbolView name="chevron.left" size={17} tintColor={c.text} />
        </Pressable>
      </GlassPanel>
    </View>
  );
}

const styles = StyleSheet.create({
  backGlass: { borderRadius: 20, left: 16, position: 'absolute' },
  backPress: { alignItems: 'center', height: 40, justifyContent: 'center', width: 40 },
  cardPadding: { paddingHorizontal: 16, paddingVertical: 14 },
  column: { paddingHorizontal: 16 },
  factIcon: { marginTop: 2, width: 20 },
  factRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  factText: { flex: 1, fontSize: 14, lineHeight: 20 },
  group: { marginBottom: 24 },
  header: { alignItems: 'center', marginBottom: 28 },
  paragraph: { fontSize: 15, lineHeight: 22 },
  paragraphGap: { marginBottom: 14 },
  root: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  sourcesNote: {
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: 16,
    textAlign: 'center',
  },
  specLabel: { fontSize: 14 },
  specRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    minHeight: 42,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  specValue: { flex: 1, fontSize: 14, fontWeight: '500', textAlign: 'right' },
  subtitle: { fontSize: 14, marginTop: 4, textAlign: 'center' },
  title: { fontSize: 28, fontWeight: '700', letterSpacing: -0.4, marginTop: 14, textAlign: 'center' },
  viewerButton: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  viewerButtonGlass: { borderRadius: 999, marginTop: 16 },
  viewerButtonText: { fontSize: 14, fontWeight: '600' },
  years: { fontSize: 13, marginTop: 2, textAlign: 'center' },
});
