// Historical photos of one physical tram car, by DPP registration number —
// full-screen push registered in _layout as tram-photos/[reg]; navigate with
// router.push('/tram-photos/' + registrationNumber).
//
// Source: TransPhoto (transphoto.org — "Urban Electric Transit", ex-СТТС), the
// community archive with a page per physical vehicle. We resolve reg → vehicle
// page via the site's own public quick-search endpoint (one tiny GET, see
// '@/lib/photos/transphoto'), then render the ORIGINAL page in a WebView so
// photographer credits, watermarks and site branding stay intact — photos are
// never scraped or re-hosted. Attribution footer links to transphoto.org;
// the header offers "open in Safari" for the full experience.
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

import { GlassPanel } from '@/components/ui/GlassPanel';
import { Colors, Tram } from '@/constants/theme';
import {
  PRAGUE_CITY_URL,
  resolveVehiclePageUrl,
  TRANSPHOTO_BASE,
} from '@/lib/photos/transphoto';

type Phase =
  | { kind: 'resolving' }
  | { kind: 'found'; url: string }
  | { kind: 'not-found' }
  | { kind: 'error' };

/** Centered icon + title + subtitle for the non-webview states. */
function CenterState({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: SymbolViewProps['name'];
  title: string;
  subtitle: string;
  children?: React.ReactNode;
}) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  return (
    <View style={styles.centerWrap}>
      <SymbolView name={icon} size={44} tintColor={c.textSecondary} />
      <Text style={[styles.centerTitle, { color: c.text }]}>{title}</Text>
      <Text style={[styles.centerSubtitle, { color: c.textSecondary }]}>{subtitle}</Text>
      {children}
    </View>
  );
}

function GlassAction({ label, onPress }: { label: string; onPress: () => void }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  return (
    <GlassPanel variant="clear" interactive style={styles.actionGlass}>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.actionPress, pressed && { opacity: 0.6 }]}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        <Text style={[styles.actionText, { color: c.text }]}>{label}</Text>
      </Pressable>
    </GlassPanel>
  );
}

export default function TramPhotosScreen() {
  const params = useLocalSearchParams<{ reg: string }>();
  const regRaw = typeof params.reg === 'string' ? params.reg : '';
  const reg = /^\d+$/.test(regRaw) ? Number(regRaw) : null;

  const router = useRouter();
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const background = scheme === 'dark' ? '#0B0B0D' : '#F2F2F6';

  const [phase, setPhase] = useState<Phase>({ kind: 'resolving' });
  const [attempt, setAttempt] = useState(0);
  const [pageLoading, setPageLoading] = useState(true);

  // Resolve reg number → TransPhoto vehicle page (re-runs on Retry).
  useEffect(() => {
    if (reg == null) {
      setPhase({ kind: 'not-found' });
      return;
    }
    let cancelled = false;
    setPhase({ kind: 'resolving' });
    setPageLoading(true);
    resolveVehiclePageUrl(reg).then((result) => {
      if (cancelled) return;
      if (result.status === 'found') setPhase({ kind: 'found', url: result.url });
      else if (result.status === 'not-found') setPhase({ kind: 'not-found' });
      else setPhase({ kind: 'error' });
    });
    return () => {
      cancelled = true;
    };
  }, [reg, attempt]);

  const onBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  const openInBrowser = useCallback(() => {
    const url = phase.kind === 'found' ? phase.url : PRAGUE_CITY_URL;
    void WebBrowser.openBrowserAsync(url);
  }, [phase]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  return (
    <View style={[styles.root, { backgroundColor: background }]}>
      {/* ── Header: back · title · open-in-browser ─────────────────────── */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <GlassPanel variant="clear" interactive style={styles.headerButtonGlass}>
          <Pressable
            onPress={onBack}
            hitSlop={10}
            style={({ pressed }) => [styles.headerButtonPress, pressed && { opacity: 0.6 }]}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <SymbolView name="chevron.left" size={17} tintColor={c.text} />
          </Pressable>
        </GlassPanel>

        <View style={styles.headerTitleWrap}>
          <Text style={[styles.headerTitle, { color: c.text }]} numberOfLines={1}>
            {reg != null ? `Photos · #${reg}` : 'Photos'}
          </Text>
        </View>

        <GlassPanel variant="clear" interactive style={styles.headerButtonGlass}>
          <Pressable
            onPress={openInBrowser}
            hitSlop={10}
            style={({ pressed }) => [styles.headerButtonPress, pressed && { opacity: 0.6 }]}
            accessibilityRole="button"
            accessibilityLabel="Open in browser"
          >
            <SymbolView name="safari" size={18} tintColor={c.text} />
          </Pressable>
        </GlassPanel>
      </View>

      {/* ── Body ───────────────────────────────────────────────────────── */}
      <View style={styles.body}>
        {phase.kind === 'resolving' && (
          <View style={styles.centerWrap}>
            <ActivityIndicator />
            <Text style={[styles.centerSubtitle, { color: c.textSecondary }]}>
              Finding car #{reg} on TransPhoto…
            </Text>
          </View>
        )}

        {phase.kind === 'not-found' && (
          <CenterState
            icon="photo.on.rectangle.angled"
            title="No photos yet"
            subtitle={
              reg != null
                ? `TransPhoto has no gallery for car #${reg}. Spotters may not have caught this one yet.`
                : 'This tram has no registration number to look up.'
            }
          >
            <GlassAction label="Browse TransPhoto" onPress={openInBrowser} />
          </CenterState>
        )}

        {phase.kind === 'error' && (
          <CenterState
            icon="wifi.slash"
            title="Can’t reach TransPhoto"
            subtitle="Check your connection and try again."
          >
            <View style={styles.actionRow}>
              <GlassAction label="Retry" onPress={retry} />
              <GlassAction label="Open in browser" onPress={openInBrowser} />
            </View>
          </CenterState>
        )}

        {phase.kind === 'found' && (
          <View style={styles.webviewWrap}>
            <WebView
              key={`${phase.url}#${attempt}`}
              source={{ uri: phase.url }}
              style={[styles.webview, { backgroundColor: background }]}
              onLoadEnd={() => setPageLoading(false)}
              onError={() => setPhase({ kind: 'error' })}
              onHttpError={(e) => {
                // Only the main document failing is fatal; subresource 404s
                // (ads, trackers) must not nuke the gallery.
                if (e.nativeEvent.url === phase.url) setPhase({ kind: 'error' });
              }}
              allowsBackForwardNavigationGestures
              decelerationRate="normal"
            />
            {pageLoading && (
              <View style={[styles.webviewLoader, { backgroundColor: background }]}>
                <ActivityIndicator />
              </View>
            )}
          </View>
        )}
      </View>

      {/* ── Attribution — always visible, links to the source ──────────── */}
      <Pressable
        onPress={() => void WebBrowser.openBrowserAsync(TRANSPHOTO_BASE)}
        style={({ pressed }) => [
          styles.attribution,
          { paddingBottom: Math.max(insets.bottom, 10) },
          pressed && { opacity: 0.6 },
        ]}
        accessibilityRole="link"
        accessibilityLabel="Photos from TransPhoto, opens transphoto.org"
      >
        <SymbolView name="camera.fill" size={11} tintColor={c.textSecondary} />
        <Text style={[styles.attributionText, { color: c.textSecondary }]}>
          Photos from TransPhoto · transphoto.org — © their photographers
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  actionGlass: { borderRadius: 999 },
  actionPress: { paddingHorizontal: 20, paddingVertical: 9 },
  actionRow: { flexDirection: 'row', gap: 10 },
  actionText: { fontSize: 14, fontWeight: '600' },
  attribution: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 5,
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  attributionText: { fontSize: 11, fontWeight: '500' },
  body: { flex: 1 },
  centerSubtitle: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  centerTitle: { fontSize: 19, fontWeight: '700' },
  centerWrap: {
    alignItems: 'center',
    flex: 1,
    gap: 12,
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    paddingBottom: 10,
    paddingHorizontal: 16,
  },
  headerButtonGlass: { borderRadius: 20 },
  headerButtonPress: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  headerTitle: { fontSize: 17, fontWeight: '700', letterSpacing: -0.2 },
  headerTitleWrap: { alignItems: 'center', flex: 1 },
  root: { flex: 1 },
  webview: { flex: 1 },
  webviewLoader: {
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  webviewWrap: { flex: 1 },
});
