// Stop sheet — /stop/[key], where key = normalized station key
// (normalizeName of the stop name, same grouping as the planner network).
// Live arrivals board over the runtime states + loaded geometries, refreshed
// ~1 Hz by the tramData hooks; tap an arrival → that tram's sheet.
//
// Apple-Maps re-skin: SheetHeader ("Tram stop · lines …" subtitle) + an
// ActionPillRow (Route Here prominent / Spot / Show on Map) + a served-lines
// badge row + the live arrivals as a grouped inset list (LineBadge circle,
// headsign+model subtitle, right-aligned green ETA countdown, chevron). All
// data flows — computeArrivals recompute-on-tick, the Route-Here prefill
// handoff, spotter start/stop — are unchanged.
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Fragment, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';

import { AcSnowflake } from '@/components/tram/TramModelImage';
import { ActionPillRow, type PillAction } from '@/components/ui/ActionPillRow';
import { InsetGroup, InsetRow, RowSeparator, SectionLabel } from '@/components/ui/Inset';
import { LineBadge } from '@/components/ui/LineBadge';
import { SheetHeader } from '@/components/ui/SheetHeader';
import { SheetSurface } from '@/components/ui/SheetSurface';
import { Apple, appleScheme, Fonts, Tram } from '@/constants/theme';
import { useAllTramStates, useLoadedGeometries } from '@/hooks/tramData';
import {
  computeArrivals,
  formatEtaMinutes,
  nearestStation,
  stationStops,
  type StopArrival,
} from '@/lib/arrivals';
import { usePlannerStore } from '@/stores/planner';
import { useSelectionStore } from '@/stores/selection';
import { useSpotterStore } from '@/stores/spotter';

/** 'Tatra T3R.P' → 'T3R.P', 'Škoda 15T ForCity Alfa' → '15T ForCity Alfa'. */
function shortModelName(name: string): string {
  return name.replace(/^(Tatra|Škoda|ČKD)\s+/u, '');
}

/** Left inset aligning arrival-row separators with the row text (16 + 30 badge + 12 gap). */
const ARRIVAL_SEPARATOR_INSET = 58;

export default function StopSheet() {
  const params = useLocalSearchParams<{ key?: string }>();
  const stationKey = typeof params.key === 'string' ? params.key : '';
  const router = useRouter();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);

  const states = useAllTramStates();
  const geometries = useLoadedGeometries();
  const requestFlyTo = useSelectionStore((s) => s.requestFlyTo);
  const requestPrefill = usePlannerStore((s) => s.requestPrefill);
  const [routing, setRouting] = useState(false);

  const station = useMemo(
    () => stationStops(stationKey, geometries),
    [stationKey, geometries],
  );
  // Recomputed on every ~1 Hz runtime tick (states identity changes), so the
  // ETAs count down without a dedicated timer.
  const arrivals = useMemo(
    () => computeArrivals(stationKey, states, geometries, Date.now()),
    [stationKey, states, geometries],
  );

  const loading = geometries.length === 0;

  const onShowOnMap = (): void => {
    if (!station) return;
    void Haptics.selectionAsync();
    requestFlyTo({ coordinates: station.coordinates, zoom: 16.5 });
    router.back();
  };

  const onOpenTram = (arrival: StopArrival): void => {
    void Haptics.selectionAsync();
    router.push(('/tram/' + encodeURIComponent(arrival.tramKey)) as Href);
  };

  const onOpenLine = (line: string): void => {
    void Haptics.selectionAsync();
    router.push(('/line/' + line) as Href);
  };

  // Spotter mode: sit at a window overlooking this stop and watch how well
  // the simulation matches reality — the camera flies to the stop, follows
  // the tram arriving FIRST, and hops to the next one as each departs
  // (SpotterController owns the loop; this button only starts/stops it).
  const spotterStation = useSpotterStore((s) => s.station);
  const isSpottingHere = spotterStation?.key === stationKey;
  const onSpot = (): void => {
    if (!station) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (isSpottingHere) {
      useSpotterStore.getState().stop();
      useSelectionStore.getState().setFollowTramKey(null);
      return;
    }
    // Fly-in first (also clears any existing follow when the map consumes
    // it); the controller waits for the glide before grabbing a target.
    requestFlyTo({ coordinates: station.coordinates, zoom: 16.5 });
    useSpotterStore.getState().start({
      key: stationKey,
      name: station.name,
      coordinates: station.coordinates,
    });
    router.back();
  };

  // "Route here": nearest stop to the user → this stop, handed to the planner
  // which auto-plans on open. Permission denial + errors surface as an alert.
  const onRouteHere = async (): Promise<void> => {
    if (!station || routing) return;
    setRouting(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Location off',
          'Allow location access in Settings to route here from your nearest stop.',
        );
        return;
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const origin = nearestStation([pos.coords.longitude, pos.coords.latitude], geometries);
      if (!origin) {
        Alert.alert('No nearby stop', 'No tram stop is loaded near you yet — try again shortly.');
        return;
      }
      if (origin.key === stationKey) {
        Alert.alert('Already here', "Your nearest tram stop is this one — you're already here.");
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      requestPrefill(origin.name, station.name);
      router.replace('/planner');
    } catch {
      Alert.alert('Location unavailable', "Couldn't read your location. Please try again.");
    } finally {
      setRouting(false);
    }
  };

  const lines = station?.lines ?? [];
  const subtitle =
    lines.length > 0
      ? `Tram stop · line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}`
      : 'Tram stop';

  const actions: PillAction[] = station
    ? [
        {
          key: 'route',
          symbol: 'location.fill',
          label: 'Route Here',
          onPress: () => void onRouteHere(),
          prominent: true,
          disabled: routing,
        },
        {
          key: 'spot',
          symbol: 'binoculars.fill',
          label: isSpottingHere ? 'Stop' : 'Spot',
          onPress: onSpot,
          tint: isSpottingHere ? Apple.red : Apple.blue,
        },
        {
          key: 'map',
          symbol: 'map.fill',
          label: 'Show Map',
          onPress: onShowOnMap,
        },
      ]
    : [];

  return (
    <SheetSurface header={<SheetHeader title={station?.name ?? 'Stop'} subtitle={subtitle} />}>
      {station && (
        <View style={styles.pillWrap}>
          {routing ? (
            <View style={styles.routingOverlay} pointerEvents="none">
              <ActivityIndicator color={Apple.blue} />
            </View>
          ) : null}
          <ActionPillRow actions={actions} />
        </View>
      )}

      {station && lines.length > 0 && (
        <View style={styles.section}>
          <SectionLabel>Lines</SectionLabel>
          <View style={styles.lineRow}>
            {lines.map((line) => (
              <Pressable
                key={line}
                onPress={() => onOpenLine(line)}
                accessibilityRole="button"
                accessibilityLabel={`Line ${line}`}
                hitSlop={6}
                style={({ pressed }) => pressed && styles.pressed}
              >
                <LineBadge line={line} size="md" />
              </Pressable>
            ))}
          </View>
        </View>
      )}

      {/* Arrivals */}
      {loading ? (
        <View style={styles.stateBlock}>
          <ActivityIndicator color={Tram.pidRed} />
          <Text style={[styles.stateBody, { color: c.secondary }]}>
            Loading the tram network — arrivals appear as routes stream in.
          </Text>
        </View>
      ) : !station ? (
        <View style={styles.stateBlock}>
          <SymbolView name="mappin.slash" size={32} tintColor={c.secondary} />
          <Text style={[styles.stateTitle, { color: c.text }]}>Stop not found</Text>
          <Text style={[styles.stateBody, { color: c.secondary }]}>
            No loaded route serves this stop yet. It appears as soon as a tram on
            a serving line reports in.
          </Text>
        </View>
      ) : arrivals.length === 0 ? (
        <View style={styles.stateBlock}>
          <SymbolView name="moon.zzz.fill" size={32} tintColor={c.secondary} />
          <Text style={[styles.stateTitle, { color: c.text }]}>No trams approaching</Text>
          <Text style={[styles.stateBody, { color: c.secondary }]}>
            No live tram is currently heading for this stop. Check back in a
            moment.
          </Text>
        </View>
      ) : (
        <View style={styles.section}>
          <SectionLabel>Upcoming arrivals</SectionLabel>
          <InsetGroup>
            {arrivals.map((a, i) => (
              <Fragment key={a.tramKey}>
                {i > 0 ? <RowSeparator inset={ARRIVAL_SEPARATOR_INSET} /> : null}
                <ArrivalRow arrival={a} onPress={() => onOpenTram(a)} />
              </Fragment>
            ))}
          </InsetGroup>
        </View>
      )}
    </SheetSurface>
  );
}

function ArrivalRow({
  arrival,
  onPress,
}: {
  arrival: StopArrival;
  onPress: () => void;
}) {
  const etaLabel = formatEtaMinutes(arrival.etaS);
  const soon = etaLabel === 'now';
  return (
    <InsetRow
      iconNode={<LineBadge line={arrival.line} size="md" />}
      title={arrival.headsign}
      subtitle={`${shortModelName(arrival.model.name)}${
        arrival.regNumber != null ? ` · #${arrival.regNumber}` : ''
      }`}
      onPress={onPress}
      chevron
      trailing={
        <View style={styles.etaWrap}>
          <AcSnowflake airConditioned={arrival.airConditioned} />
          <Text
            style={[styles.eta, soon && styles.etaNow, { color: Apple.green }]}
            allowFontScaling={false}
          >
            {etaLabel}
          </Text>
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  pillWrap: { justifyContent: 'center' },
  routingOverlay: {
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 1,
  },
  section: { gap: 8 },
  lineRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 4,
  },
  etaWrap: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  eta: {
    fontFamily: Fonts?.rounded,
    fontSize: 19,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  etaNow: { fontSize: 16 },
  stateBlock: {
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  stateTitle: { fontSize: 17, fontWeight: '600' },
  stateBody: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  pressed: { opacity: 0.55 },
});
