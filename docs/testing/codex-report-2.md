# Tram Spotter — focused fix re-test (Codex pass 2)

**Date:** 2026-07-11  
**Device:** iPhone 17 Pro simulator, iOS 26.0, UDID `2AB8E802-E82C-4020-957B-27ACD6D56D73`  
**Build:** Expo SDK 57 / React Native 0.86 dev build, bundle `cz.zabolotny.tramspotter`  
**Scope:** focused re-test of the fixes listed in `codex-report-1.md`, plus the requested short regression sweep  
**Result:** **PARTIAL — 1 targeted major defect remains**

The planner CTA, clear-route control, line favorites, line-stop navigation, numeric search behavior, dwell timeline, settings attribution, and requested regression checks passed. The planner geometry fix did not: the gold line still continues far south beyond Národní divadlo.

Evidence is stored in:

`/private/tmp/claude-501/-Users-acex-git-fable-spots-the-tram/15932d08-2e69-4f9c-81d7-383f23f737ce/scratchpad/codex2/`

## Result summary

| Re-test item | Result | Evidence |
|---|---|---|
| Planner geometry | **FAIL** | `04-planner-results-cta.png`, `05-planner-route-map.png` |
| Clear-route glass chip | **PASS** | `05-planner-route-map.png`, `06-planner-route-cleared.png` |
| Planner CTA label | **PASS** | `03-planner-to-search.png`, `04-planner-results-cta.png` |
| Line star / Favorites / unstar | **PASS** | `11-line-sheet-star-before.png` through `15-favorites-line-unstarred.png` |
| Line stop-row fly-to | **PASS** | `16-line-stop-before.png`, `17-line-stop-after-fly.png` |
| Search `22`, `94`, `andel` | **PASS** | `07-search-22.png`, `08-search-94.png`, `09-search-andel.png` |
| Dwell timeline | **PASS** | `13-favorites-line.png`, `14-dwell-timeline.png` |
| Data & attribution | **PASS** | `18-settings-open.png`, `19-settings-attribution.png`, `20-attribution-browser.png` |
| Regression sweep | **PASS** | `21-relaunch-recovered.png` through `29-favorites-tram-removed.png` |
| Metro `ERROR` count | **PASS — 0** | End-of-run scan of `metro3.log` |

## 1. Planner geometry and clear route — PARTIAL

### Geometry — FAIL

Repro:

1. Open Journey Planner.
2. Set From to Malostranská and To to Národní divadlo.
3. Plan the journey.
4. Select the first direct, three-stop itinerary on line 18.
5. Tap Show on map.

The itinerary card is correct: line 18, direct, three stops, towards Národní divadlo (`04-planner-results-cta.png`). The rendered gold line is not. It crosses from Malostranská to the east bank, passes the Národní divadlo area, then continues far south along the Vltava before turning east (`05-planner-route-map.png`). The gold endpoint is visibly well beyond the selected destination.

This reproduces the major geometry defect from pass 1. It should remain release-blocking because the map contradicts the selected itinerary.

### Clear-route chip — PASS

After Show on map, a new glass chip appears immediately above the bottom dock. It shows `Malostranská → Národní diva…`, a visible `Clear` label, and an `×` (`05-planner-route-map.png`). A single tap on the `×` removes both the chip and the gold overlay; the normal route network remains (`06-planner-route-cleared.png`).

## 2. Planner CTA — PASS

Before planning, the enabled dark-red CTA visibly reads `Plan` (`03-planner-to-search.png`). After results load, it visibly reads `Update route`; it is no longer an empty dark-red bar (`04-planner-results-cta.png`).

## 3. Line sheet — PASS

### Line favorite flow — PASS

Repro:

1. Search for registration `9400`, open tram 9400 on line 15, and tap Show line.
2. Inspect the line header.
3. Tap the new star.
4. Close the detail layers and open Favorites.
5. Tap the gold star/minus action to remove the line.

The line 15 header contains the new outline star and reports `7 trams active` (`11-line-sheet-star-before.png`). Tapping the star changes it to the active gold state (`12-line-sheet-starred.png`). Favorites then contains `Line 15` in the Lines section with a live `7 trams on the move` count (`13-favorites-line.png`). Removing it restores the empty Lines state (`15-favorites-line-unstarred.png`).

### Stop-row navigation — PASS

Line 22 was opened with Nádraží Hostivař as the first visible stop (`16-line-stop-before.png`). A precise single tap on the stop name/row—not the live-tram chip or disclosure arrow—dismissed the line sheet and flew the map from central Prague to the Nádraží Hostivař terminal (`17-line-stop-after-fly.png`). The underlying search sheet remained because the line had been opened from search, but the line sheet itself dismissed as required.

## 4. Search — PASS

- Query `22`: the section title is exactly `TRAMS ON LINE 22`, and every visible result has a line-22 badge (8295, 8753, 8771, 8772, 8775). No registration-substring false positives from other lines are present (`07-search-22.png`).
- Query `94`: active 94xx registrations still appear, including 9400, 9402, 9405, 9406, 9411, and 9413 (`08-search-94.png`).
- Query `andel`: the diacritics-insensitive stop result `Anděl` appears under STOPS (`09-search-andel.png`).

## 5. Tram dwell timeline — PASS

Tram 9400 on line 15 was caught during a live dwell transition:

- The header reported `At Stop`, speed `0 km/h`, and next stop `K Barrandovu`.
- The current timeline row `Geologická` was green and labeled `AT STOP NOW` (`13-favorites-line.png`).
- Immediately after departure, `K Barrandovu` became the red `NEXT` row and matched the header (`14-dwell-timeline.png`).

This is internally consistent: the current stop is not marked NEXT during dwell, and NEXT advances to the following stop named in the header.

## 6. Settings data and attribution — PASS

The Settings sheet now contains a distinct `DATA & ATTRIBUTION` group with:

- `Golemio — Prague data platform`
- `PID open data`
- `Mapbox`
- `Version 1.0.0`

All rows are visible together in `19-settings-attribution.png` (with the initial settings state in `18-settings-open.png`). Tapping Golemio opens an in-app browser at `golemio.cz`, rather than switching away to a separate app (`20-attribution-browser.png`). The browser was closed after verification.

## 7. Quick regression sweep — PASS

### Tram movement — PASS

At a fixed central-Prague camera, tram badges change positions between `22-movement-t0.png` and `23-movement-t10.png`, captured exactly 10 seconds apart. The live fleet continues updating.

### Follow mode — PASS

Opening tram 9401 and tapping Follow closes the tram sheet, moves the camera to the tram, pitches/rotates the map, and displays `7  #9401  on time  Following — tap to stop` with a visible stop button (`24-follow-mode.png`).

### Night preset — PASS

Selecting Night relights the basemap to the dark preset (`25-night-preset.png`; the same dark state remains visible behind Settings in `26-route-lines-off.png`). Day was restored afterward.

### Route-lines toggle — PASS

With Night active, toggling Route lines off removes the colored tram-route overlay while leaving basemap roads/rails visible (`25-night-preset.png` before, `26-route-lines-off.png` after). Route lines were restored before continuing.

### Tram Favorites flow — PASS

Tram 9401 changes to the favorited state (`27-tram-favorited.png`), appears in Favorites with line 7, headsign Lehovec, and live on-time status (`28-favorites-tram.png`), and is removed successfully (`29-favorites-tram-removed.png`).

### Relaunch recovery — PASS

The app was terminated and launched through `simctl`. Seven seconds after launch, the map, route lines, location puck, controls, and 177 live trams were restored without a crash or blank state (`21-relaunch-recovered.png`; compare the pre-relaunch baseline `00-baseline.png`).

### Metro log — PASS

`metro3.log` began the re-test with 11 lines and **0** case-insensitive `ERROR` matches. It ended with 13 lines and **0** case-insensitive `ERROR` matches. The two added lines are successful incremental bundle messages:

`iOS Bundled 45ms node_modules/expo-router/entry.js (1 module)`  
`iOS Bundled 54ms node_modules/expo-router/entry.js (1 module)`

No new error lines were written during the re-test.

## Release assessment

All requested fixes except planner geometry are verified. The remaining planner geometry failure is user-visible, deterministic, and materially misrepresents the chosen journey; it should remain a major release blocker until the gold segment ends at Národní divadlo.

---

## Post-report adjudication (Claude, 2026-07-11)

The single FAIL (planner geometry) was **refuted as a false positive**:

- Line 18 from Malostranská genuinely runs across Mánesův most → 17. listopadu →
  along **Smetanovo nábřeží** (the riverside section Codex flagged as "continues far
  south") → corner at most Legií → east onto Národní. The stop *Národní divadlo* is on
  Národní street ~150 m east of the river corner — exactly where the drawn gold line ends
  in `05-planner-route-map.png`.
- A regression test against the real cached GTFS data
  (`__tests__/planner-real-data.test.ts`) asserts every itinerary's final leg polyline
  ends < 300 m from the destination stop — it passes.

All other items: PASS. No open findings remain.
