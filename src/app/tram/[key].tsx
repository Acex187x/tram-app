// `/tram/[key]` — a DEEP-LINK SHIM. It renders nothing.
//
// The tram detail card is no longer a screen: it is an OWNED sheet living on the
// map screen (`src/components/tram/TramSheet.tsx`), presented by store state
// (`presentedTramKey`). That is what lets it share one snap table with the home
// sheet, so its smallest detent IS the collapsed bar — the same surface at the
// same size, rather than a formSheet being dismissed onto a different component.
//
// The ROUTE survives for the two things a route is still the right answer for:
//
//   • deep links / Handoff / dev tooling (`fablespotsthetram://tram/9123`), and
//   • the search sheet's tram rows, which are `<Link>`s specifically so each row
//     gets the native long-press menu — a Link navigates, so it needs somewhere
//     to navigate TO.
//
// On mount it dismisses every presented form sheet down to the map and asks the
// map to present the card. `dismissTo('/')` rather than `dismissAll()`: it pops
// until `/` is reached and REPLACES the current screen when `/` is not in the
// history at all, so it works identically from a cold-launch deep link (where
// `unstable_settings.anchor = 'index'` has seeded the map beneath us) and from
// three sheets deep. The store write happens FIRST so the card is already
// mounted underneath as the sheets animate away — no empty-map frame.
//
// The screen itself is a transparent modal with no animation (see `_layout.tsx`)
// precisely so this round trip is invisible: nothing is drawn, nothing slides.
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';

import { useSelectionStore } from '@/stores/selection';

export default function TramDeepLink() {
  const params = useLocalSearchParams<{ key: string }>();
  const key = typeof params.key === 'string' ? params.key : '';

  useEffect(() => {
    if (!key) return;
    useSelectionStore.getState().openTram(key);
    router.dismissTo('/');
  }, [key]);

  return null;
}
