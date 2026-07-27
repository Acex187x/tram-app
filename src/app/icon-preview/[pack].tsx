// /icon-preview/[pack] — large-scale icon-pack preview sheet, re-skinned to
// Apple Maps chrome: a large-title SheetHeader with circular X, an Apple
// SegmentedPills pack switcher, the study grid, and a prominent blue "Use pack"
// action pinned at the bottom. Opened from the Settings 'Tram icons' picker
// (magnifier on each pack row). 'Use this pack' applies the previewed pack via
// the same settings-store path as the picker; browsing alone changes nothing.
//
// Surface: <SheetSurface/>, the same scaffold every other route sheet uses —
// the header slot takes the title + pack switcher, the footer slot takes the
// sticky blue action (that slot exists precisely for this), and the grid is the
// scrolling body. It used to hand-roll the whole thing around a plain root View,
// which is how it drifted out of step with the shared grabber band.
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TramFace } from '@/components/tram/TramFace';
import { CloseCircle } from '@/components/ui/CloseCircle';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { SegmentedPills } from '@/components/ui/SegmentedPills';
import { SheetContent } from '@/components/ui/SheetContent';
import { SheetHeader } from '@/components/ui/SheetHeader';
import { SheetSurface } from '@/components/ui/SheetSurface';
import { appleScheme, Radii } from '@/constants/theme';
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

const PACK_SEGMENTS = ICON_PACK_IDS.map((id) => ({ key: id, label: PACK_SHORT_NAME[id] }));

const GRID_FACE_SIZE = 132;
const ZOOM_FACE_SIZE = 240;

function isIconPackId(value: string): value is IconPackId {
  return (ICON_PACK_IDS as string[]).includes(value);
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
  const c = appleScheme(useColorScheme() === 'dark' ? 'dark' : 'light');
  const insets = useSafeAreaInsets();
  const spec = MODEL_SPECS[modelId];
  return (
    // accessibilityViewIsModal keeps VoiceOver inside the zoom instead of
    // swiping on through the grid and the Use-pack button underneath it.
    <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
      {/* The one glass pane this screen still owns: it is an OVERLAY over the
          sheet's own content (it has to hide the grid behind it), not a second
          skin on the sheet itself. Its appearance is pinned to the system
          scheme by GlassPanel, so it cannot resolve light under a dark app. */}
      <GlassPanel style={StyleSheet.absoluteFill}>
        {/* Tap anywhere to close; VoiceOver dismisses through the X instead. */}
        <Pressable
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <View
          accessible
          accessibilityLabel={`${MODEL_CODE[modelId]}, ${spec.name}`}
          pointerEvents="none"
          style={styles.zoomBody}
        >
          <TramFace pack={pack} modelId={modelId} size={ZOOM_FACE_SIZE} />
          <Text style={[styles.zoomCode, { color: c.text }]}>{MODEL_CODE[modelId]}</Text>
          <Text style={[styles.zoomName, { color: c.secondary }]}>{spec.name}</Text>
        </View>
        <View style={[styles.zoomClose, { top: insets.top + 20 }]}>
          <CloseCircle onPress={onClose} label="Close zoom" />
        </View>
        {/* Pack switcher stays live in zoom so one model can be compared across styles. */}
        <SheetContent
          style={[styles.zoomFooter, { paddingBottom: Math.max(insets.bottom, 12) + 8 }]}
        >
          <SegmentedPills
            segments={PACK_SEGMENTS}
            selectedKey={pack}
            onChange={(key) => onChangePack(key as IconPackId)}
          />
        </SheetContent>
      </GlassPanel>
    </View>
  );
}

export default function IconPreviewScreen() {
  const params = useLocalSearchParams<{ pack: string }>();
  const c = appleScheme(useColorScheme() === 'dark' ? 'dark' : 'light');
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
  const footerBottomPad = Math.max(insets.bottom, 12) + 4;

  const onUsePack = () => {
    if (isCurrent) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setIconPack(viewPack);
  };

  const header = (
    <>
      <SheetHeader title="Icon preview" />
      <View style={styles.switcher}>
        <SegmentedPills
          segments={PACK_SEGMENTS}
          selectedKey={viewPack}
          onChange={(key) => {
            if (key === viewPack) return;
            void Haptics.selectionAsync();
            setViewPack(key as IconPackId);
          }}
        />
        <Text style={[styles.packDescription, { color: c.secondary }]}>{meta.description}</Text>
      </View>
    </>
  );

  /* Sticky apply footer — mirrors the picker's setIconPack path. */
  const footer = (
    <SheetContent style={[styles.footer, { paddingBottom: footerBottomPad }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: isCurrent }}
        disabled={isCurrent}
        onPress={onUsePack}
        style={({ pressed }) => [
          styles.useButton,
          isCurrent ? { backgroundColor: c.fillTertiary } : { backgroundColor: c.blue },
          pressed && !isCurrent && { opacity: 0.75 },
        ]}
      >
        {isCurrent && <SymbolView name="checkmark.circle.fill" size={17} tintColor={c.secondary} />}
        <Text style={[styles.useButtonText, { color: isCurrent ? c.secondary : '#FFFFFF' }]}>
          {isCurrent ? 'Current pack' : `Use ${meta.name}`}
        </Text>
      </Pressable>
    </SheetContent>
  );

  return (
    <>
      <SheetSurface
        header={header}
        footer={footer}
        contentContainerStyle={styles.scrollBody}
        scrollProps={SCROLL_PROPS}
      >
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
              <Text style={[styles.tileCode, { color: c.text }]}>{MODEL_CODE[modelId]}</Text>
              <Text style={[styles.tileName, { color: c.secondary }]} numberOfLines={2}>
                {MODEL_SPECS[modelId].name}
              </Text>
            </Pressable>
          ))}
        </View>
      </SheetSurface>

      {/* Sibling of the surface, not a child: it covers the footer too. */}
      {zoomModel != null && (
        <ZoomOverlay
          pack={viewPack}
          modelId={zoomModel}
          onChangePack={setViewPack}
          onClose={() => setZoomModel(null)}
        />
      )}
    </>
  );
}

/** The grid supplies its own horizontal padding, so the surface's default
 *  content inset would double it. */
const SCROLL_PROPS = { showsVerticalScrollIndicator: false } as const;

const styles = StyleSheet.create({
  scrollBody: { paddingHorizontal: 0, paddingBottom: 12, gap: 0 },
  switcher: {
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  packDescription: {
    fontSize: 13,
    lineHeight: 18,
    minHeight: 36,
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
    borderRadius: Radii.card,
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'center',
    minHeight: 52,
  },
  useButtonText: {
    fontSize: 17,
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
  // On the sheet's content edge, like every other block on this screen (the
  // switcher, the grid and both footers all re-apply 16 after `scrollBody`
  // zeroes the surface inset). It was pinned at 20, i.e. 4 pt inboard of them.
  zoomClose: {
    position: 'absolute',
    right: 16,
    zIndex: 1,
  },
  zoomFooter: {
    paddingHorizontal: 16,
  },
});
