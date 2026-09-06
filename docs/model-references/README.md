# Prague fleet models — September 2026

The seven tram models are generated from a new Blender scene, using operator
photographs and technical drawings. Research photographs are not app textures.
[sources.json](sources.json) records the fleet gallery URLs and credits;
[cab observations](technical/cab-observations.md) records detailed visual findings
and their limits. DPP/PID retain their image rights. The separately identified
Wikimedia originals retain their linked attribution and licence.

## Dimensions and evidence

Published dimensions and dimensions estimated from drawings are deliberately
separate. Body length, width, wheelbase and dimensioned pivot/axle positions use
printed technical figures. Visible rigid-shell and bellows boundaries, most door
centers, and some 52T running-gear dimensions are **scale-derived modelling fits**.
They are not manufacturer CAD dimensions. See
[measurement metadata](technical/orthographic-measurements.json) for source pages,
pixel boundaries and uncertainty (typically 4–10 cm).

All section and door sequences below run from the front toward the rear. Gaps are
physical bellows widths between rigid shells, not additional body length. The map
and the interactive viewer use the same section lengths and gaps.

| Model | Rigid body sections, m | Each gap, m | Body total, m | Passenger doors per section |
|---|---|---|---|---|
| T3 / T3R.P | 14.000 | — | 14.000 | 3 right |
| T3R.PLF | 15.100 | — | 15.100 | 3 right |
| KT8D5.RN2P | 10.9 / 6.5 / 10.9 | 1.000 | 30.300 | 2 / 1 / 2 on each side |
| 14T | 6.265 / 5.48 / 3.38 / 5.48 / 6.265 | 0.845 | 30.250 | 0 / 2 / 0 / 2 / 1 right |
| 15T | 10.4 / 8.6 / 10.4 | 1.000 | 31.400 | 2 / 2 / 2 right |
| 52T | 9 / 3.5 / 3.79 / 3.5 / 9 | 0.800 | 31.990 | 2 / 0 / 1 / 0 / 2 right |

The T3 family has real projecting couplers. Total projection across **both ends**
is 1.104 m for T3/RP and 1.100 m for PLF. Consequently their GLB bounds are about
15.104/16.200 m, while body metadata remains 14.000/15.100 m. Coupled-car placement
uses the over-coupler spacing, so accessory bounds must not redefine body length.
The existing same-type trailer heuristic cannot identify mixed RP/PLF pairs.

Running gear:

- T3/RP bogie centers are ±3.2 m around the body center; PLF uses ±3.75 m.
  Tatra axle spacing is 1.900 m. The
  [DPP 2021 fleet table, printed p. 137](https://nosddpp.cz/data/ostatni/statisticka_rocenka_2021.pdf)
  confirms the body and wheelbase dimensions; `dpp-dimensions.png` is the saved page.
- KT8 outer bogie centers are 3.9/26.4 m from the front; shared bogies/articulations
  are 11.4/18.9 m. The 1 m bellows fit preserves those articulation centers.
- 14T has bogies in sections 1/3/5, centered approximately at 4.55/15.125/25.70 m;
  axle spacing is 1.880 m. The rear passenger doorway is single width (model fit
  0.70 m); the four suspended-section passenger doors are 1.30 m. The separate
  narrow front door is driver access.
- 15T has independent wheels and shared bogies at 10.9/20.5 m. End-bogie wheel
  centers are 1.85 m from each end: the first two wheel axes are 0.9/2.8 m from
  the front. The **eccentric body pivot at 2.2 m is not the wheel-pair center**.
  Shared bogies are split between adjoining assets at the articulation.
- 52T has four bogies in sections 1/2/4/5, at approximately
  2.30/11.56/20.43/29.69 m. Wheel diameter is published as 0.64 m; the 1.80 m
  wheelbase is a drawing-derived fit. The middle section has no bogie.

## Source drawings

The extracted historical drawing pages below reproduce DPP/ČKD/Škoda figures
inside later publications. Their dimension labels are evidence; they are not
original manufacturer-hosted CAD files, and unrelated proposals in the same
publications are not model references.

| Local file | Exact publication and page used |
|---|---|
| [t3-original-dpp-drawing.pdf](technical/t3-original-dpp-drawing.pdf) | [ČVUT thesis](https://dspace.cvut.cz/bitstream/10467/77506/-1/F2-BP-2018-Dynybyl-Matej-Bakalarska_prace.pdf), PDF p. 17, original DPP T3 drawing; not the author's proposed cargo tram |
| [kt8-original-drawing.pdf](technical/kt8-original-drawing.pdf) | [Evaluation report](https://mzv.gov.cz/file/920250/final_evaluacni_zprava.pdf), PDF p. 58, original type drawing; not a Sarajevo livery reference |
| [15t-original-skoda-drawing.pdf](technical/15t-original-skoda-drawing.pdf) | [IPPT thesis](https://www.ippt.pan.pl/repository/doktoraty/open/2025_kalinowski_d_doktorat.pdf), PDF/printed p. 46, figure 4.9 reproducing Škoda prospectus reference 60 |
| [15t-schaeffler.pdf](technical/15t-schaeffler.pdf) | [Schaeffler RFB 5](https://www.schaeffler.com/remotemedien/media/_shared_media/08_media_library/01_publications/schaeffler_2/datasheet_1/downloads_4/rfb_005_de_en.pdf), p. 2, figure 2 credited Škoda CZ; side/plan and bellows fit |
| [pid-tram-appearance-2023.pdf](technical/pid-tram-appearance-2023.pdf) | [PID appearance manual](https://pid.cz/wp-content/uploads/system/sk_tram/SK_tram_priloha_manual_jednotneho_vzhledu_vozidel_2023-01-01.pdf), PDF p. 7 / printed p. 5; KT8 and 14T physical-shell/door proportions |
| [14t-praha-four-views.png](technical/14t-praha-four-views.png) | [Prague commission minutes](https://praha.eu/documents/d/praha/zapis_z_jednani_komise_rady_hl_m_prahy_1_3517600), PDF p. 4; front/rear/side views |
| [52t-skoda-manufacturer.pdf](technical/52t-skoda-manufacturer.pdf) | [Škoda technical sheet](https://admin.skodagroup.com/wp-content/uploads/2025/02/TRAM-PRAHA.pdf), p. 2; dimensions and orthographic side/plan |

## Front, rear and representative variants

- **Historic T3 6102:** ivory/red shell, red diamond collector, rounded recessed
  non-LED destination aperture. One broad front pane plus two corner panes,
  round chrome headlights and a deep pale skirt. T3/RP/PLF share the three-pane
  front topology; dual wipers do not imply two main panes.
- **T3R.P 8442:** red/ivory classic shell, yellow diamond collector and modern
  destination display. Keep regular high window sills and three right doors.
- **T3R.PLF 8284:** longer body, left windows 3 high + 3 low + 3 high, right windows
  3 + 3 between the doors; low middle threshold, roof equipment and cream V on
  the nose. Rear has a broader central pane, rectangular lamps and a top-mounted
  wiper. [DPP 9/2017](https://www.dpp.cz/data/leaflets/documents/2020-01-21-10-47-16_09-Zari.pdf)
  shows this exact car's front assembly and rear delivery. Do not combine its
  dual front wipers with later 8286's single-wiper detail.
- **KT8D5.RN2P 9102:** angular double-ended cab, central and corner glass in a dark
  mask, four round lamps and five doors per side. Both ends are driving cabs and
  have destination information and a wiper. The viewer demonstrates travel-right
  passenger doors; the static open map variants likewise open that side.
- **14T 9148:** original silver nose/red body, long inclined cab, vertical stacks
  of three lamps, driver access in front and one single passenger doorway at the
  rear. PID-painted 9121 photographs are shape references, not this model's livery.
  Front/rear belong to the same shell family; rear information is route-only.
- **15T 9286:** original red brow, dark glass/number band, silver lamp belt and
  red lower bumper. Later yellow-brow cars are not blended into this variant.
  Rear has a route-only display and rear wiper. The sharp
  [9389 rear photograph](https://commons.wikimedia.org/wiki/File:%C5%A0koda_15T5_Dpp.jpg)
  is later-generation evidence: do not transfer its sculpted lamp housings to
  9286 without matching evidence (MartinZandadancin, CC BY 4.0).
- **52T 9501:** broad dark rounded cab, horizontal lamp capsules, pale lower mask
  and **off-center** PID red stripe. Front has destination information; rear has
  route-only information and different marker lamps. The
  [DPP factory report, PDF p. 5](https://www.dpp.cz/data/leaflets/documents/2025-02-25-08-56-31__DP-kontakt-2-2025-web.pdf)
  explicitly identifies the saved rear photograph. Related fore/aft profiles
  are supported; a completely different rear shell would be speculative.

Photos cannot establish every small fitting or exact radius. These are optimized
reconstructions, not a claim of millimetre-exact CAD or a transparent interior.

## Authoring and runtime assets

[blender_fleet.py](../../scripts/tram-models/blender_fleet.py) authors geometry,
materials and named movable parts from scratch. The editable assembled files in
`assets/model-source/<id>.blend` retain section and part nodes, lights and a review
camera. The old per-type Node tram builders are retired.

- **34 static map GLBs:** 19 closed sections plus 15 passenger-door-open variants.
  Sections `14t-a`, `14t-c`, `52t-b`, `52t-d` have no passenger-door-open asset.
  Named movable parts are merged for the map, preserving its existing batching.
- **19 viewer GLBs:** `<section>-viewer.glb`, with separate door/indicator nodes
  and glTF extras. They contain no baked animation clips. The dedicated viewer
  animates those nodes locally for door and indicator demonstrations; these are
  not live vehicle signals and are not loaded by the Mapbox model registry.
- Geometry uses metres, Y-up and front toward −Z. Every section has its own body
  center origin. Bellows halves and couplers extend beyond that rigid body.
  Roof-height metadata excludes raised collectors; complete bounds include them.
- Materials remain opaque, single-sided PBR factors, without image textures.
  Map assets retain the 12,000-triangle whole-tram ceiling. File budgets are
  250 KiB per T3-family asset and 200 KiB per articulated section.

```sh
node scripts/generate-tram-models.mjs --render
node scripts/generate-tram-models.mjs 15t --render
node scripts/generate-tram-models.mjs --validate-only
```

Blender 5.2.1 is used; set `BLENDER_BIN` to override its executable. Node-side
validation uses glTF Transform and Khronos `gltf-validator`; generation tooling
belongs outside the mobile app's runtime dependencies.

## Validation and delivery record

The completed optics validation covers **53 tram GLBs**: 34 static map assets in
[validation.json](../model-previews/validation.json) and 19 movable-part assets in
[viewer-validation.json](../model-previews/viewer-validation.json). The current
reports have zero Khronos errors/warnings; the viewer checks include assembled
world bounds and door/indicator metadata. This certifies the exported assets,
not simulator gestures or the installed application's rendering. Those require
separate current-build evidence. See [preview workflow](../model-previews/README.md).

The user waived Telegram/Mobbin feature reports for this task. Delivery is the
current application on reachable devices, with no push before user approval.
