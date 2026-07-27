// "About this tram" — the Apple Maps grouped-inset spec block for the tram
// card (the "Good to Know" / spec-sheet region of a place detail, IMG_0078).
//
// ── THE PLAQUE ──────────────────────────────────────────────────────────────
// The illustration used to be a centred `ModelPreviewButton` floating above four
// one-fact InsetRows, which wasted the whole right half of the card on empty
// space and left the picture aligned with nothing. It is now a PLAQUE: art on
// the left, the model's identity and its four key facts on the right, the whole
// row being the 3D affordance (a `rotate.3d` chevron-analogue closes it). Two
// text lines carry what four rows used to:
//
//     manufacturer · yearsBuilt
//     totalLengthM m · sectionsLabel · maxSpeedKmh km/h
//
// NOTE: there is deliberately NO seat/capacity figure. `TramModelSpec` has no
// such field anywhere in the fleet registry, and inventing or stubbing one on a
// spec plaque would be exactly the kind of fake datum ux-screens §8 forbids.
//
// Below the plaque, an explicit "Model info & history" row (the fleet page at
// /model-info/[id]), then the low-floor + per-vehicle amenity badges sourced
// from the live snapshot, and the model's fun fact as an italic footer.
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { TramModelImage, tramModelImageSource } from '@/components/tram/TramModelImage';
import { InsetGroup, InsetRow, RowSeparator } from '@/components/ui/Inset';
import { appleScheme, Radii, TextScale, Tram } from '@/constants/theme';
import type { TramModelSpec, TramSnapshot } from '@/lib/types';

/** Illustration height inside the plaque; the face closeups are ~square, so the
 *  art slot is that × `MODEL_IMAGE_ASPECT` and nothing is letterboxed. */
const PLAQUE_ART_H = 64;
const PLAQUE_ART_W = 70;

export interface AboutTramCardProps {
  model: TramModelSpec;
  snapshot: TramSnapshot;
}

interface AmenityChipProps {
  icon: SFSymbol;
  label: string;
  /** Wording when the amenity is absent — the state is spelled out, not dimmed. */
  absentLabel: string;
  /** true = present, false = absent, null = unknown (chip is omitted). */
  active: boolean | null;
}

function AmenityChip({ icon, label, absentLabel, active }: AmenityChipProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  // Unknown gets no chip at all: a muted one is indistinguishable from "absent".
  if (active == null) return null;
  const tint = active ? c.text : c.secondary;
  return (
    <View
      style={[styles.chip, { backgroundColor: c.fillTertiary }]}
      accessible
      accessibilityLabel={`${label}: ${active ? 'yes' : 'no'}`}
    >
      <SymbolView name={icon} size={13} weight="semibold" tintColor={tint} />
      <Text style={[styles.chipText, { color: tint }]} maxFontSizeMultiplier={TextScale.compact}>
        {active ? label : absentLabel}
      </Text>
    </View>
  );
}

export function AboutTramCard({ model, snapshot }: AboutTramCardProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);

  const sectionsLabel =
    model.sections.length === 1 ? 'single body' : `${model.sections.length} sections`;

  const hasArt = tramModelImageSource(model.id) != null;

  return (
    <View style={styles.wrap}>
      <InsetGroup>
        <Pressable
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            router.push(`/model/${model.id}`);
          }}
          accessibilityRole="button"
          accessibilityLabel={`${model.name}, ${model.manufacturer}, built ${model.yearsBuilt}, ${model.totalLengthM} metres, ${sectionsLabel}, top speed ${model.maxSpeedKmh} kilometres per hour. View in 3D`}
          style={({ pressed }) => [
            styles.plaque,
            pressed && { backgroundColor: c.fillHighlight },
          ]}
        >
          <View style={styles.plaqueArt}>
            {hasArt ? (
              <TramModelImage modelId={model.id} height={PLAQUE_ART_H} />
            ) : (
              // No bundled illustration: a placeholder slab of the same box, so
              // the row never collapses lopsided around a missing asset.
              <View style={[styles.plaqueArtEmpty, { backgroundColor: c.fillTertiary }]}>
                <SymbolView name="tram.fill" size={22} tintColor={c.secondary} />
              </View>
            )}
          </View>
          <View style={styles.plaqueText}>
            <Text
              style={[styles.plaqueTitle, { color: c.text }]}
              numberOfLines={1}
              maxFontSizeMultiplier={TextScale.content}
            >
              {model.name}
            </Text>
            {/* TWO lines allowed: rebuilt types carry compound builder strings
                ("ČKD Tatra / Pars Nova (rebuild)") that truncate the build years
                off the end at one line — and the years are the more interesting
                half. The plaque is already 64 pt tall for the art, so the wrap
                is usually free. */}
            <Text
              style={[styles.plaqueLine, { color: c.secondary }]}
              numberOfLines={2}
              maxFontSizeMultiplier={TextScale.content}
            >
              {model.manufacturer} · {model.yearsBuilt}
            </Text>
            <Text
              style={[styles.plaqueLine, { color: c.secondary }]}
              numberOfLines={1}
              maxFontSizeMultiplier={TextScale.content}
            >
              {model.totalLengthM} m · {sectionsLabel} · {model.maxSpeedKmh} km/h
            </Text>
          </View>
          {/* `rotate.3d` alone is cryptic at 16 pt; the chevron behind it is what
              says "this row navigates", matching the row below. */}
          <View style={styles.plaqueTrailing}>
            <SymbolView name="rotate.3d" size={16} weight="semibold" tintColor={c.secondary} />
            <SymbolView name="chevron.right" size={13} weight="semibold" tintColor={c.secondary} />
          </View>
        </Pressable>

        <RowSeparator inset={16} />

        <InsetRow
          icon="book.closed.fill"
          iconTint={c.blue}
          title="Model info & history"
          subtitle="Fleet numbers, service history, gallery"
          chevron
          onPress={() => router.push(`/model-info/${model.id}`)}
        />
      </InsetGroup>

      <View style={styles.badgesRow}>
        <View
          style={[
            styles.chip,
            {
              backgroundColor: model.lowFloor
                ? scheme === 'dark'
                  ? 'rgba(48,209,88,0.24)'
                  : 'rgba(46,139,87,0.16)'
                : c.fillTertiary,
            },
          ]}
        >
          <SymbolView
            name={model.lowFloor ? 'arrow.down.to.line' : 'stairs'}
            size={13}
            weight="semibold"
            tintColor={model.lowFloor ? Tram.onTime : c.secondary}
          />
          <Text
            style={[styles.chipText, { color: model.lowFloor ? Tram.onTime : c.secondary }]}
            maxFontSizeMultiplier={TextScale.compact}
          >
            {model.lowFloor ? 'Low floor' : 'High floor'}
          </Text>
        </View>
        <AmenityChip
          icon="snowflake"
          label="AC"
          absentLabel="No AC"
          active={snapshot.airConditioned}
        />
        <AmenityChip
          icon="powerplug.fill"
          label="USB"
          absentLabel="No USB"
          active={snapshot.usbChargers}
        />
        <AmenityChip
          icon="figure.roll"
          label="Access"
          absentLabel="No step-free access"
          active={snapshot.wheelchairAccessible}
        />
      </View>

      <Text style={[styles.funFact, { color: c.secondary }]}>{model.funFact}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  // The plaque is a TALL InsetGroup row: it keeps the group's 16 pt horizontal
  // padding (so its art starts on the same 32 pt text grid every other row's
  // title uses) and only its vertical padding differs.
  plaque: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  plaqueArt: {
    alignItems: 'center',
    height: PLAQUE_ART_H,
    justifyContent: 'center',
    width: PLAQUE_ART_W,
  },
  plaqueArtEmpty: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: Radii.card,
    height: PLAQUE_ART_H,
    justifyContent: 'center',
    width: PLAQUE_ART_W,
  },
  plaqueText: { flex: 1, gap: 2 },
  plaqueTrailing: { alignItems: 'center', flexDirection: 'row', flexShrink: 0, gap: 6 },
  plaqueTitle: { fontSize: 16, fontWeight: '600' },
  plaqueLine: { fontSize: 13 },
  // No stray inset: chips and the fun fact sit on the sheet's content edge, the
  // same edge as the InsetGroup above them (they carried +4 and lined up with
  // nothing).
  badgesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  chipText: { fontSize: 12, fontWeight: '600' },
  funFact: {
    fontSize: 13,
    fontStyle: 'italic',
    lineHeight: 18,
  },
});
