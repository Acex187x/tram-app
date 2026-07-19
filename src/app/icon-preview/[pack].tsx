// /icon-preview/[pack] — large-scale icon-pack preview sheet. Opened from the
// Settings 'Tram icons' picker (magnifier on each pack row); shows every tram
// model of one pack big enough to actually study the art, with a segmented
// pack switcher to compare all four styles side by side. Tapping a model zooms
// it further (near full-sheet). 'Use this pack' applies the previewed pack via
// the same settings-store path as the picker; browsing alone changes nothing.
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SheetHeader } from '@/components/favorites/SheetHeader';
import { TramFace } from '@/components/tram/TramFace';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { SheetContent } from '@/components/ui/SheetContent';
import { Colors, Tram } from '@/constants/theme';
import { ICON_PACKS, ICON_PACK_IDS, type IconPackId } from '@/lib/fleet/iconPacks';
import { MODEL_SPECS } from '@/lib/fleet/modelSpecs';
import type { TramModelId } from '@/lib/types';
import { useSettingsStore } from '@/stores/settings';

/** All 7 models, classic Tatras first — same order as the TramModelId union. */
const MODEL_IDS: TramModelId[] = ['t3', 't3rp', 't3rplf', 'kt8d5', '14t', '15t', '52t'];

/** Short fleet code shown under each face (the real name comes from specs). */
const MODEL_CODE: Record<TramModelId, string> = {
  t3: 'T3',
  t3rp: 'T3R.P',
  t3rplf: 'T3R.PLF',
  kt8d5: 'KT8D5',
  '14t': '14T',
  '15t': '15T',
  '52t': '52T',
};

/** One-word segment labels for the pack switcher. */
const PACK_SHORT_NAME: Record<IconPackId, string> = {
  classic: 'Classic',
  side: 'Side',
  iso: 'Iso',
  chibi: 'Chibi',
};

const GRID_FACE_SIZE = 132;
const ZOOM_FACE_SIZE = 240;

function isIconPackId(value: string): value is IconPackId {
  return (ICON_PACK_IDS as string[]).includes(value);
}

/** Segmented control over the 4 packs (same look as the settings segments). */
function PackSegments({
  value,
  onChange,
}: {
  value: IconPackId;
  onChange: (pack: IconPackId) => void;
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
      {ICON_PACK_IDS.map((packId) => {
        const selected = packId === value;
        return (
          <Pressable
            key={packId}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={`Preview ${ICON_PACKS[packId].meta.name}`}
            onPress={() => {
              if (selected) return;
              void Haptics.selectionAsync();
              onChange(packId);
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
              {PACK_SHORT_NAME[packId]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Near-full-sheet single-model zoom: huge face, code + real name, switcher. */
function ZoomOverlay({
  pack,
  modelId,
  onChangePack,
  onClose,
}: {
  pack: IconPackId;
  modelId: TramModelId;
  onChangePack: (pack: IconPackId) => void;
  onClose: () => void;
}) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = Colors[scheme];
  const insets = useSafeAreaInsets();
  const spec = MODEL_SPECS[modelId];
  return (
    <GlassPanel style={StyleSheet.absoluteFill}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close zoom"
        onPress={onClose}
        style={styles.zoomBody}
      >
        <TramFace pack={pack} modelId={modelId} size={ZOOM_FACE_SIZE} />
        <Text style={[styles.zoomCode, { color: palette.text }]}>
          {MODEL_CODE[modelId]}
        </Text>
        <Text style={[styles.zoomName, { color: palette.textSecondary }]}>
          {spec.name}
        </Text>
        <Text style={[styles.zoomHint, { color: palette.textSecondary }]}>
          Tap to close
        </Text>
      </Pressable>
      {/* Pack switcher stays live in zoom so one model can be compared across styles. */}
      <SheetContent
        style={[styles.zoomFooter, { paddingBottom: Math.max(insets.bottom, 12) + 8 }]}
      >
        <PackSegments value={pack} onChange={onChangePack} />
      </SheetContent>
    </GlassPanel>
  );
}

export default function IconPreviewScreen() {
  const params = useLocalSearchParams<{ pack: string }>();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = Colors[scheme];
  const insets = useSafeAreaInsets();
  const iconPack = useSettingsStore((s) => s.iconPack);
  const setIconPack = useSettingsStore((s) => s.setIconPack);

  // Pack being previewed — starts from the route param, switchable in-sheet.
  // Browsing never touches the store; only 'Use this pack' applies it.
  const [viewPack, setViewPack] = useState<IconPackId>(() => {
    const raw = typeof params.pack === 'string' ? params.pack : '';
    return isIconPackId(raw) ? raw : iconPack;
  });
  const [zoomModel, setZoomModel] = useState<TramModelId | null>(null);

  const meta = ICON_PACKS[viewPack].meta;
  const isCurrent = viewPack === iconPack;

  const onUsePack = () => {
    if (isCurrent) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setIconPack(viewPack);
  };

  return (
    <GlassPanel style={styles.sheet}>
      <SheetContent>
        <SheetHeader title="Icon preview" />
        <View style={styles.switcher}>
          <PackSegments value={viewPack} onChange={setViewPack} />
          <Text style={[styles.packDescription, { color: palette.textSecondary }]}>
            {meta.description}
          </Text>
        </View>
      </SheetContent>

      <ScrollView
        contentContainerStyle={styles.scrollBottom}
        showsVerticalScrollIndicator={false}
      >
        <SheetContent>
          <View style={styles.grid}>
            {MODEL_IDS.map((modelId) => (
              <Pressable
                key={modelId}
                accessibilityRole="button"
                accessibilityLabel={`Zoom ${MODEL_SPECS[modelId].name}`}
                onPress={() => {
                  void Haptics.selectionAsync();
                  setZoomModel(modelId);
                }}
                style={({ pressed }) => [styles.tile, pressed && { opacity: 0.6 }]}
              >
                <TramFace pack={viewPack} modelId={modelId} size={GRID_FACE_SIZE} />
                <Text style={[styles.tileCode, { color: palette.text }]}>
                  {MODEL_CODE[modelId]}
                </Text>
                <Text
                  style={[styles.tileName, { color: palette.textSecondary }]}
                  numberOfLines={2}
                >
                  {MODEL_SPECS[modelId].name}
                </Text>
              </Pressable>
            ))}
          </View>
        </SheetContent>
      </ScrollView>

      {/* Sticky apply footer — mirrors the picker's setIconPack path. */}
      <SheetContent
        style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) + 4 }]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: isCurrent }}
          disabled={isCurrent}
          onPress={onUsePack}
          style={({ pressed }) => [
            styles.useButton,
            isCurrent
              ? {
                  backgroundColor:
                    scheme === 'dark' ? 'rgba(118,118,128,0.24)' : 'rgba(118,118,128,0.14)',
                }
              : { backgroundColor: Tram.pidRed },
            pressed && !isCurrent && { opacity: 0.75 },
          ]}
        >
          {isCurrent && (
            <SymbolView
              name="checkmark.circle.fill"
              size={17}
              tintColor={palette.textSecondary}
            />
          )}
          <Text
            style={[
              styles.useButtonText,
              { color: isCurrent ? palette.textSecondary : '#FFFFFF' },
            ]}
          >
            {isCurrent ? 'Current pack' : `Use ${meta.name}`}
          </Text>
        </Pressable>
      </SheetContent>

      {zoomModel != null && (
        <ZoomOverlay
          pack={viewPack}
          modelId={zoomModel}
          onChangePack={setViewPack}
          onClose={() => setZoomModel(null)}
        />
      )}
    </GlassPanel>
  );
}

const styles = StyleSheet.create({
  sheet: {
    flex: 1,
  },
  switcher: {
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 4,
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
  packDescription: {
    fontSize: 13,
    lineHeight: 18,
    minHeight: 36,
  },
  scrollBottom: {
    paddingBottom: 12,
  },
  grid: {
    columnGap: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingTop: 12,
    rowGap: 20,
  },
  tile: {
    alignItems: 'center',
    gap: 2,
    width: 160,
  },
  tileCode: {
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.3,
    marginTop: 6,
  },
  tileName: {
    fontSize: 12,
    lineHeight: 16,
    textAlign: 'center',
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  useButton: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 14,
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'center',
    minHeight: 50,
  },
  useButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  zoomBody: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  zoomCode: {
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 0.4,
    marginTop: 20,
  },
  zoomName: {
    fontSize: 15,
    marginTop: 4,
    textAlign: 'center',
  },
  zoomHint: {
    fontSize: 12,
    marginTop: 14,
    opacity: 0.8,
  },
  zoomFooter: {
    paddingHorizontal: 16,
  },
});
