# Tram Spotter — iOS QA report (Codex pass 1)

**Date:** 2026-07-11  
**Device:** iPhone 17 Pro simulator, iOS 26.0, UDID `2AB8E802-E82C-4020-957B-27ACD6D56D73`  
**Build:** Expo SDK 57 / React Native 0.86 dev build, bundle `cz.zabolotny.tramspotter`  
**Result:** **PARTIAL / not release-ready**

The core real-time map, movement interpolation, detail sheet, follow mode, search, favorites, planner generation, settings, location permission, relaunch recovery, and five-minute stability soak all worked. Release should still be blocked on planner geometry, numeric search relevance, line-stop navigation, line favorites, missing route-clear UI, and the runtime errors already present in the Metro log.

Evidence is stored in:

`/private/tmp/claude-501/-Users-acex-git-fable-spots-the-tram/15932d08-2e69-4f9c-81d7-383f23f737ce/scratchpad/codex/`

## Severity summary

| Severity | Finding |
|---|---|
| Major | Planner draws a route far beyond the selected destination |
| Major | No visible “Clear route” action after showing a planned route |
| Major | Numeric line search returns registration substring matches instead of trams on that line |
| Major | Tapping a stop in the line sheet does not fly the map to that stop |
| Major | Favorites UI promises line favorites, but the line sheet exposes no line-star control |
| Major | Metro contains 10 runtime/error entries, including undefined identifiers in `RouteNetwork.tsx` and Mapbox layer/source failures |
| Minor | Detail sheet can briefly show the old stop as `NEXT` after the next-stop summary has advanced |
| Minor | Live feed briefly collapsed to `1 stale` before self-recovering |
| Minor | Settings lacks the requested attribution/source rows |
| Cosmetic | Planner's enabled action becomes an empty dark-red bar after routes load |
| Cosmetic | Dense mid-zoom badges overlap heavily and become hard to read |

## 1. Map/root screen — PASS (zoom coverage PARTIAL)

### Passed

- Mapbox Standard map loaded over Prague with 3D buildings, route lines, map compass, live count chip, right-side locate/2D-3D/settings buttons, and bottom glass dock.
- Live count stayed in the expected range for most of the run (approximately 171–184).
- Red route lines visibly follow streets/tracks at default zoom.
- Mid zoom displays dark-red circular badges with white line numbers.
- The 2D/3D control toggles pitch. Evidence: `46-settings-open.png`/`47-settings-second-tap.png` show the button changing between `3D` and `2D` and the camera switching between flat and pitched presentation.
- Very-close view renders articulated 3D vehicles with multiple sections. The models are aligned longitudinally with the track, not sideways. Evidence: `70-scroll-zoom-attempt.png`, `71-soak-t0.png`.
- Location request displayed the native iOS permission dialog with a meaningful purpose string. Granting “Allow While Using App” moved the camera to the configured simulator location and displayed a blue puck. Evidence: `56-location-permission.png`, `57-location-granted.png`, `59-relaunch-2-t6.png`, `61-settings-close-attempt.png`.

### Tram movement core check — PASS

Repro:

1. Leave the default camera untouched.
2. Capture at t=0, t=10 s, and t=20 s.
3. Compare individual badges along the same route segments.

Badges moved progressively along route lines while the camera stayed fixed; they did not remain static. Evidence: `01-movement-t0.png`, `02-movement-t10.png`, `03-movement-t20.png`. The five-minute fixed-camera soak also began with a model in view and ended after that tram had departed, while the live count changed from 181 to 184: `71-soak-t0.png`, `76-soak-t300.png`.

### Partial / unverified

- Far-out small-dot mode could not be reliably reached with the available mouse-only simulator gesture bridge. Do not treat it as passed.
- The exact z15.5 “oversized model” transition was not independently measured; close and very-close model rendering was observed.

### Cosmetic bug: badge collisions

**Severity:** cosmetic  
**Evidence:** `00-baseline.png`, `03-movement-t20.png`, `30-relaunch-t20.png`

At default/mid zoom, multiple vehicles at hubs overlap into unreadable stacks (for example around New Town and Malostranská). This makes individual line selection feel imprecise and visually noisy.

## 2. Tram detail sheet — PASS with minor data defect

### Passed

- Tapping a tram opens a native-feeling form sheet while the live map remains visible behind it.
- Header includes line, headsign, model and registration, and delay pill.
- Live speed and running state update.
- Next stop and ETA are present and continue updating.
- Upcoming-stop timeline and revised/passed scheduled times are visible.
- “About this tram” includes manufacturer, build years, dimensions, top speed, accessibility/amenity chips, and a fun fact.
- Follow, Favorite, and Show line actions work.

Evidence: `04-settings-open.png` (line 26 detail), `05-detail-countdown-t10.png`, `06-detail-scrolled.png`, `07-detail-about.png`, `12-detail-favorited-confirmed.png`.

### Bug: summary and timeline briefly disagree at a stop transition

**Severity:** minor  
**Evidence:** `04-settings-open.png`, `05-detail-countdown-t10.png`

Repro:

1. Open tram 9315 on line 26 while approaching Kamenická.
2. Keep the sheet open as the tram arrives/passes the stop.
3. Observe the top summary advance to Letenské náměstí while the timeline still marks Kamenická as `NEXT`, with the old time struck through.

The state self-corrects on a later refresh, but for several seconds the two primary journey indicators contradict each other.

## 3. Follow mode — PASS

Repro:

1. Open tram 9315.
2. Tap Follow.
3. Observe for 15 seconds.
4. Pan the map manually.

The sheet closed, camera moved with the tram, and the banner showed line 26, registration 9315, on-time status, and “Following — tap to stop.” After 15 seconds, the camera had shifted along the route while the selected tram stayed centered. Manual panning immediately removed the banner and stopped follow mode. Evidence: `17-follow-start.png`, `18-follow-t15.png`, `19-follow-pan-cancel.png`.

The banner X was present and visually usable; manual-pan cancellation was explicitly verified.

## 4. Line sheet — PARTIAL

### Passed

- “Show line” opens line 26 with a large badge and live active count (9, later 10).
- Direction segmented control is present.
- The line is highlighted gold behind the sheet.
- Stops timeline renders.
- Live tram chips appear between stops (for example tram 9309 at Nádraží Hostivař), and tapping the chip arrow opens tram detail.

Evidence: `13-line-sheet.png`, `14-line-stop-tap.png`, `15-line-chip-tap.png`, `16-line-chip-arrow-tap.png`.

### Bug: stop tap does not fly the map

**Severity:** major  
**Evidence:** `13-line-sheet.png`, `14-line-stop-tap.png`

Repro:

1. Open tram 9315.
2. Tap Show line.
3. Tap the first visible stop, Nádraží Hostivař.
4. Wait three seconds.

The sheet expands and reveals the live tram chip, but the background camera remains over central Prague instead of flying east to Nádraží Hostivař.

### Bug: line favorite is advertised but unavailable

**Severity:** major  
**Evidence:** `13-line-sheet.png`, `31-favorites-open.png`

Repro:

1. Open line 26.
2. Inspect the line header and visible sheet controls.
3. Open Favorites.

Favorites explicitly says “Open a line from any tram and star it to track it here,” but the line sheet exposes no star/favorite control. There is therefore no discoverable way to satisfy the product promise.

## 5. Search — PARTIAL

### Passed

- Search sheet opens with keyboard focus and a good empty state: `22-search-open-confirmed.png`.
- Diacritics-insensitive stop search works. Query `Narodni` returns `Národní divadlo` and `Národní třída`: `62-search-narodni.png`.
- Tapping Národní divadlo closes the sheet and flies the pitched map to the stop: `63-search-stop-fly.png`.
- Registration-prefix search works. Query `94` returns active registrations including 9400, 9401/9402, 9404, 9405, 9406, 9411, 9413, 9414, 9421, and 9422: `64-search-reg94.png`.

### Bug: line-number query does not list trams on that line

**Severity:** major  
**Evidence:** `23-search-22.png`

Repro:

1. Open Search.
2. Enter `22`.

Expected: line 22 plus trams currently operating on line 22.  
Actual: line 22 plus registration substring matches such as tram 9224 on line 5 and tram 9322 on line 26. This is misleading because the “TRAMS” section appears related to the line query but is not.

## 6. Favorites — PASS for trams, FAIL for lines

### Tram favorites passed

- Favoriting tram 9315 changes the control to gold `Favorited`: `12-detail-favorited-confirmed.png`.
- The item persisted through an app relaunch and showed live delay/headsign: `31-favorites-open.png`.
- The minus button removes it and reveals a polished empty state: `33-favorites-empty.png`.

### Line favorites failed

See the major line-favorite bug in section 4. The Favorites line section exists, but no tested line sheet provided the action needed to populate it.

## 7. Journey planner — PARTIAL

### Passed

- Planner opens with From/To fields and swap action: `35-planner-open-confirmed.png`.
- Typing `Malostranska` suggests `Malostranská` and shows serving lines: `37-planner-from-results.png`.
- Typing `Narodni divadlo` without diacritics suggests `Národní divadlo`: `41-planner-to-corrected.png`.
- Plan produces multiple direct three-stop itineraries with line badges, direction, and stop count (lines 18 and 2): `44-planner-itinerary-confirmed.png`.
- “Show on map” closes the sheet, fits the camera, and draws a gold route: `45-planner-route-map.png`.

### Bug: route geometry continues far beyond the destination

**Severity:** major  
**Evidence:** `44-planner-itinerary-confirmed.png`, `45-planner-route-map.png`

Repro:

1. Plan from Malostranská to Národní divadlo.
2. Choose the direct three-stop line 18 result.
3. Tap Show on map.

Expected: only the three-stop segment from Malostranská to Národní divadlo.  
Actual: the gold route crosses the river and then continues far south along the Vltava, well beyond Národní divadlo. The highlighted geometry does not match the itinerary card.

### Bug: no visible Clear route action

**Severity:** major  
**Evidence:** `45-planner-route-map.png`

After the planner sheet closes, the normal bottom dock returns and there is no visible `Clear route` button/banner. The user has no obvious in-map way to remove the gold overlay.

### Bug: planner action label disappears after results load

**Severity:** cosmetic  
**Evidence:** `44-planner-itinerary-confirmed.png`

After routes load, the dark-red action bar remains above the results but its label/icon are blank, producing an unfinished or disabled-looking control.

## 8. Settings — PARTIAL

### Passed

- Settings form sheet opens and preserves the map behind it: `48-settings-open-confirmed.png`.
- Auto/Day/Dusk/Night segmented control is present.
- Night visibly switches the basemap to dark styling: `49-settings-night.png`.
- Day visibly restores daylight styling: `50-settings-day.png`.
- Route-lines toggle actually removes the red route network: compare `50-settings-day.png` with `52-settings-route-off-confirmed.png`.
- Route-lines preference persisted through relaunch and could be restored: `59-relaunch-2-t6.png`, `60-route-restored.png`.
- Follow locks heading toggle changes state: `54-settings-follow-heading-on-confirmed.png`.
- About card is legible and explains live positions, Golemio, interpolation, and 3D rendering.

### Bug: requested attribution rows are missing

**Severity:** minor  
**Evidence:** `48-settings-open-confirmed.png`, `55-settings-about-attribution.png`

The sheet contains one About card but no distinct Mapbox/Golemio attribution, data-source, license, privacy, or version rows. Scrolling did not reveal additional content.

## 9. Stability, relaunch, cache, and logs — PARTIAL

### Relaunch/cache — PASS

- Relaunch 1: map, route lines, and trams were already visible at t=5 s: `29-relaunch-t5.png`; still healthy at t=20 s: `30-relaunch-t20.png`.
- Relaunch 2: map and trams returned at t=6 s with location permission/puck preserved: `59-relaunch-2-t6.png`.
- A further relaunch also restored the app and route cache without a crash.

### Five-minute soak — PASS

The app was left untouched for five minutes with minute evidence at `71-soak-t0.png` through `76-soak-t300.png`. It did not crash. The live count moved from 181 to 184, and a visible tram left the fixed frame, confirming continued updates/movement. Metro output did not change during the soak.

### Minor transient: live feed briefly becomes stale

**Severity:** minor  
**Evidence:** `67-search-closed-confirmed.png`, `68-stale-t15.png`

Repro observed:

1. Fly to Národní divadlo from stop search.
2. Open registration search for `94`, expand the sheet, then close it.

The status chip briefly showed `1 stale` and almost all vehicles disappeared. Within approximately 15 seconds the app self-recovered to 174 live trams without user action. The stale indicator is useful, but collapsing almost the entire fleet creates a noticeable reliability flicker.

### Metro log errors — FAIL

The supplied Metro log contains **10 `ERROR` entries** and **4 Mapbox warning entries**. These entries existed when testing began; repeated interaction batches and the five-minute soak did not append new errors. They must still be treated as defects in the tested development session.

Errors present:

1. `RNMBXStyleImport.setStyleImportConfigProperties`: basemap style import does not exist.
2. `ReferenceError: Property 'styleLoaded' doesn't exist`.
3. `ReferenceError: Property 'buildMapStyleJSON' doesn't exist`.
4. `RNMBXLayer.removeFromMap`: layer `route-lines` does not exist.
5. `find/makeLayer failed`: source `route-network` is not in style.
6. `updateLayer LineLayer.route-debug-line`: layer is not in style (twice).
7. `ReferenceError: Property 'useRef' doesn't exist` in `RouteNetwork.tsx:67` (twice).
8. `ReferenceError: Property 'EMPTY_FC' doesn't exist` in `RouteNetwork.tsx:76`.

Warnings present include unsupported source ID changes among `route-network`, `route-stops`, and `route-debug`.

Log file inspected:

`/private/tmp/claude-501/-Users-acex-git-fable-spots-the-tram/15932d08-2e69-4f9c-81d7-383f23f737ce/scratchpad/metro2.log`

## Release recommendation

**Do not ship this build yet.** The real-time experience is compelling and the core movement/follow/detail loops are functional, but route planning currently visualizes the wrong geometry, line-number search is semantically misleading, line-stop navigation and line favorites are incomplete, the planned route lacks a visible clear action, and the development session contains serious runtime/Mapbox errors. Fix and retest those major items before TestFlight release.
