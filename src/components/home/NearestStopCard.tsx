// NEAREST STOP — the home sheet's hero card. "Where am I, and what's coming?"
// answered before the user types anything: the closest tram station, the walk
// to it, and the next few arrivals with live ETAs.
//
// It carries NO section label. It is the top card of the sheet and its own
// header row names it, which is exactly how Apple Maps treats its top card —
// a caption above it would only push the content the user came for further down.
//
// Every non-ready state (permission, locating, no network, nothing nearby,
// failed fix) renders as ONE row in the SAME InsetGroup outline, so the card's
// silhouette never changes shape as it resolves.
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Fragment } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';

import {
  formatMeters,
  lastKnownStopName,
  useNearbyStop,
  walkMinutes,
  type NearbyStop,
} from '@/components/home/useNearbyStop';
import { AcSnowflake, acTint } from '@/components/tram/TramModelImage';
import { InsetGroup, InsetRow, RowSeparator } from '@/components/ui/Inset';
import { LineBadge } from '@/components/ui/LineBadge';
import { appleScheme, TabularNums, TextScale, Tram, Type } from '@/constants/theme';
import { formatEtaMinutes, type StopArrival } from '@/lib/arrivals';
import { useSelectionStore } from '@/stores/selection';

/** 'Tatra T3R.P' → 'T3R.P'. Deliberately local — see /stop/[key], which has its
 *  own copy: four lines duplicated beats a screen importing from another screen. */
function shortModelName(name: string): string {
  return name.replace(/^(Tatra|Škoda|ČKD)\s+/u, '');
}

/** Pin circle (30) + row padding (16) + gap (12) — aligns separators with text. */
const ROW_TEXT_INSET = 58;

export function NearestStopCard() {
  const nearby = useNearbyStop();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);

  if (nearby.status !== 'ready' || nearby.station == null) {
    return <NearbyState status={nearby.status} onRequest={nearby.request} />;
  }

  const { station, walkM, walkS, arrivals } = nearby;
  const walkMin = walkS == null ? null : walkMinutes(walkS);
  const detail =
    walkMin != null && walkM != null
      ? `${walkMin} min walk · ${formatMeters(walkM)}`
      : 'Nearest tram stop';

  const openStop = (): void => {
    void Haptics.selectionAsync();
    router.push(`/stop/${station.key}`);
  };

  return (
    <InsetGroup>
      {/* The header row and every arrival row are SEPARATE tap targets and
          separate accessibility elements — never nest Pressables. */}
      <Pressable
        onPress={openStop}
        accessibilityRole="button"
        accessibilityLabel={`${station.name}, nearest tram stop, ${detail}, ${
          arrivals.length > 0 ? `${arrivals.length} arrivals` : 'no trams due'
        }`}
        style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.fillHighlight }]}
      >
        {/* PID red, not system blue: this is our surface, not a system one (h7). */}
        <View style={[styles.pin, { backgroundColor: Tram.pidRed }]}>
          <SymbolView name="figure.walk" size={16} weight="semibold" tintColor="#FFFFFF" />
        </View>
        <View style={styles.rowText}>
          <Text
            style={[Type.headline, { color: c.text }]}
            numberOfLines={1}
            maxFontSizeMultiplier={TextScale.content}
          >
            {station.name}
          </Text>
          <Text
            style={[styles.sub, { color: c.secondary }]}
            numberOfLines={1}
            maxFontSizeMultiplier={TextScale.content}
          >
            {detail}
          </Text>
        </View>
        <SymbolView name="chevron.right" size={13} weight="semibold" tintColor={c.secondary} />
      </Pressable>

      {arrivals.length === 0 ? (
        <>
          <RowSeparator inset={ROW_TEXT_INSET} />
          <View style={styles.row}>
            <Text
              style={[styles.quiet, { color: c.secondary }]}
              maxFontSizeMultiplier={TextScale.content}
            >
              No trams due right now
            </Text>
          </View>
        </>
      ) : (
        arrivals.map((a) => (
          <Fragment key={a.tramKey}>
            <RowSeparator inset={ROW_TEXT_INSET} />
            <ArrivalRow arrival={a} />
          </Fragment>
        ))
      )}
    </InsetGroup>
  );
}

function ArrivalRow({ arrival }: { arrival: StopArrival }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  const eta = formatEtaMinutes(arrival.etaS);
  const soon = eta === 'now';
  // systemGreen only reaches ~2:1 on the light card fill — goGreen is the
  // accessible light-appearance green (same rule as the stop sheet's board).
  const etaColor = soon ? (scheme === 'dark' ? c.green : c.goGreen) : c.text;

  // We are ALREADY on the map screen, so there is nothing to dismiss: present
  // the card and stay put. (The favorites/stop sheets call dismissAll after
  // openTram because they are modals over this screen — this card is not.)
  const open = (): void => {
    void Haptics.selectionAsync();
    useSelectionStore.getState().openTram(arrival.tramKey);
  };

  return (
    <Pressable
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={`Line ${arrival.line} to ${arrival.headsign}, ${
        soon ? 'arriving now' : `in ${eta}`
      }, ${shortModelName(arrival.model.name)}${
        arrival.airConditioned ? ', air conditioned' : ''
      }`}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.fillHighlight }]}
    >
      <View style={styles.badgeSlot}>
        <LineBadge line={arrival.line} size="md" />
      </View>
      <View style={styles.rowText}>
        <Text
          style={[styles.title, { color: c.text }]}
          numberOfLines={1}
          maxFontSizeMultiplier={TextScale.content}
        >
          {arrival.headsign}
        </Text>
        <Text
          style={[styles.sub, { color: c.secondary }]}
          numberOfLines={1}
          maxFontSizeMultiplier={TextScale.content}
        >
          {shortModelName(arrival.model.name)}
          {arrival.regNumber != null ? ` · #${arrival.regNumber}` : ''}
        </Text>
      </View>
      <AcSnowflake airConditioned={arrival.airConditioned} tint={acTint(scheme)} decorative />
      <Text
        style={[styles.eta, { color: etaColor }]}
        maxFontSizeMultiplier={TextScale.compact}
      >
        {eta}
      </Text>
    </Pressable>
  );
}

/** Every state the card can be in before it has a station to show. */
function NearbyState({
  status,
  onRequest,
}: {
  status: NearbyStop['status'];
  onRequest: () => void;
}) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);

  if (status === 'undetermined') {
    return (
      <InsetGroup>
        <InsetRow
          icon="location.fill"
          iconTint={c.blue}
          title="Show stops near you"
          subtitle="Uses your location once while this sheet is open"
          onPress={onRequest}
          trailing={
            <Text
              style={[styles.action, { color: c.blue }]}
              maxFontSizeMultiplier={TextScale.compact}
            >
              Enable
            </Text>
          }
        />
      </InsetGroup>
    );
  }

  if (status === 'denied') {
    return (
      <InsetGroup>
        <InsetRow
          icon="location.slash.fill"
          title="Location is off"
          subtitle="Turn it on in Settings to see nearby stops"
          chevron
          onPress={() => void Linking.openSettings()}
        />
      </InsetGroup>
    );
  }

  if (status === 'error') {
    return (
      <InsetGroup>
        <InsetRow
          icon="exclamationmark.triangle.fill"
          iconTint={Tram.late}
          title="Couldn't get your location"
          subtitle="Tap to try again"
          onPress={onRequest}
        />
      </InsetGroup>
    );
  }

  if (status === 'no-stop') {
    return (
      <InsetGroup>
        <InsetRow
          icon="mappin.slash"
          title="No tram stops nearby"
          subtitle="The Prague network is out of range"
        />
      </InsetGroup>
    );
  }

  // 'locating' and 'no-network' are both "working on it" — one spinner row.
  return (
    <InsetGroup>
      <View style={styles.row}>
        <View style={styles.spinnerSlot}>
          <ActivityIndicator size="small" />
        </View>
        <Text
          style={[styles.quiet, { color: c.secondary }]}
          maxFontSizeMultiplier={TextScale.content}
        >
          {status === 'locating' ? 'Finding your location…' : 'Loading the tram network…'}
        </Text>
      </View>
    </InsetGroup>
  );
}

/**
 * What stands in for the card while the sheet is at PEEK. It holds ZERO hooks
 * into tram data — that is the whole point of the mount gate — and exists only
 * so the body's height is stable across the gate flip, i.e. re-expanding the
 * sheet does not jolt the rows below it.
 */
export function NearestStopPlaceholder() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = appleScheme(scheme);
  const name = lastKnownStopName();
  return (
    <InsetGroup>
      <View style={styles.row}>
        <View style={[styles.pin, { backgroundColor: c.fillTertiary }]}>
          <SymbolView name="figure.walk" size={16} weight="semibold" tintColor={c.secondary} />
        </View>
        <View style={styles.rowText}>
          <Text
            style={[Type.headline, { color: c.text }]}
            numberOfLines={1}
            maxFontSizeMultiplier={TextScale.content}
          >
            {name ?? 'Nearby stops'}
          </Text>
          <Text
            style={[styles.sub, { color: c.secondary }]}
            numberOfLines={1}
            maxFontSizeMultiplier={TextScale.content}
          >
            Pull up for live arrivals
          </Text>
        </View>
      </View>
    </InsetGroup>
  );
}

const PIN = 30;

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  pin: {
    alignItems: 'center',
    borderRadius: PIN / 2,
    height: PIN,
    justifyContent: 'center',
    width: PIN,
  },
  // The line badge is 30 pt wide at `md`, so the arrival rows' text column
  // starts on exactly the same x as the header row's.
  badgeSlot: { alignItems: 'center', width: PIN },
  spinnerSlot: { alignItems: 'center', width: PIN },
  rowText: { flex: 1, gap: 1 },
  title: { fontSize: 17, fontWeight: '400' },
  sub: { fontSize: 13, fontWeight: '400' },
  quiet: { flex: 1, fontSize: 15 },
  action: { fontSize: 15, fontWeight: '600' },
  eta: {
    ...TabularNums,
    fontSize: 17,
    fontWeight: '600',
    flexShrink: 0,
  },
});
