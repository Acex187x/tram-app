# Prague Tram Fleet (DPP) — Reference for Model Detection & 3D Assets

Research date: 2026-07-11. Sources: dpp.cz (official "Vozový park" spec sheets, figures "k 1. 1. 2026"), seznam-autobusu.cz (vehicle-by-vehicle evidence database), prazsketramvaje.cz (evidenční čísla / registration-number articles), cs.wikipedia.org, en.wikipedia.org, dopravacek.eu (2025/2026 delivery news).

> **IMPORTANT CORRECTION vs. the task brief:** Škoda 14T and the classic (unreconstructed) Tatra T3 are **not** the same as what's listed below as still active — see the "What is NOT in service" section. Most critically, **Tatra T6A5 ended regular passenger service in Prague on 19 June 2021** (retained only for 2 heritage/charity cars) — it should be **removed** from the active fleet-mapping table. The classic (non-modernized) Tatra T3 ended regular service in October 2011. Do not map any Golemio `vehicle_registration_number` you can't place in a range below to T6A5 or classic T3 — treat it as "unknown historic/utility vehicle."

## TL;DR — active fleet as of 1 Jan 2026 (DPP official figures)

| Type | Count in service (1.1.2026) | Manufacturer | Body | Status |
|---|---|---|---|---|
| Tatra **T3R.P** (incl. T3R.PV) | 298 | ČKD Tatra (1963-73 shells) rebuilt by DPP/Pars Nova | 1 section, high-floor | Being retired/replaced by T3R.PLF |
| Tatra **T3R.PLF** | 76 | ČKD Tatra shells rebuilt by DPP/Krnovské opravny (KOS) | 1 section + partial low-floor "wana" middle | Currently the replacement for T3R.P; production ongoing |
| Tatra **KT8D5.RN2P** | 60 | Ex-Miskolc KT8D5 shells, rebuilt (new low-floor middle by KOS) | 3 sections, 2 joints | Ongoing reconstruction of imported hulls |
| Škoda **14T** ("ForCity"/"Porsche"/"Blues") | 55 | Škoda Transportation, built 2006-2010 | 5 sections, 4 joints | Stable fleet, no more built; some retired/renumbered |
| Škoda **15T** ("ForCity Alfa") | 250 | Škoda Transportation, built 2009-2017 | 3 sections, 2 joints | Backbone of the fleet, stable |
| Škoda **52T** ("ForCity Plus Praha") | ~12-23 growing to ~40+ | Škoda Transportation, deliveries started Nov 2025 | 5 sections, 4 joints | Actively being delivered through 2026 (2×20-unit batches) |

Total DPP tram fleet (all types incl. historic/heritage/works cars): **784 vehicles** (end of 2024 figure, cs.wikipedia.org "Tramvajová doprava v Praze"). Active daytime lines: **27** (numbered 1-26 plus a few lettered/temporary variants — verify against current PID timetable, this shifts with construction closures). Night lines: **9 lines, numbered 91-99** (renumbered from the old 51+ scheme in 2017), running on a 30-min headway (20 min Fri/Sat night).

---

## What is NOT in active passenger service (do not include in the model-detection table)

- **Tatra T6A5 / T6A5.3** — ended regular service **19 June 2021**. Registration block was 8600-8750ish (ČKD DS T6A5). If you see a number in this range from Golemio it is almost certainly stale/retired data, a works vehicle, or a data error — do not render as a live tram.
- **Classic (non-reconstructed) Tatra T3 / T3SU / T3SUCS** — ended regular service **October 2011**.
- **Tatra T2, T1, K2, RT6N1/N2** — long retired, museum-only.
- **"T3M"** — a 1970s internal designation (T3 fitted with cheaper TV1 electrical gear during original production), **not** a current rolling type; some Czech sources sloppily still list "T3M" in overview tables but it is not a distinct type you'll encounter as an active Golemio vehicle in practical numbers. Treat any T3-family car as either T3R.P or T3R.PLF.

## What I could NOT fully verify — flag as risk

- Exact **current** vehicle-by-vehicle registration lists shift constantly (T3R.P cars are being scrapped weekly and replaced 1:1 by new T3R.PLF numbers, KT8D5 rebuilds are ongoing, 52T deliveries are landing monthly through 2026). The ranges below are the best available snapshot from mid-2025/2026 sources but **will have small gaps and will keep shifting**. Treat ranges as "which model family a number most likely belongs to," not an exact roster.
- I could not get a live, authoritative page load of seznam-autobusu.cz's full sortable table (fetches returned an LLM-summarized approximation, not raw data) — **before shipping, do a live scrape/verify of** `https://seznam-autobusu.cz/en/seznam?iddopravce=106&trakce=tramvaj` (filterable by `vyrobce=`/`ntyp=`/`prov=1` for "currently in service") to get the exact current roster. This is public data, no auth needed.
- 52T final registration range is still growing (deliveries continue through Dec 2026); the range 9501-95xx will extend past what's documented here.

---

## 1. Registration number ranges (model-detection table)

**Golemio's `vehicle_registration_number` is the DPP "evidenční číslo" (fleet number), a 4-digit integer.** Ranges below, ordered as a lookup table (check from most specific/narrow to broadest; note the T3 sub-ranges interleave in the 8200s-8800s block).

| Range (inclusive) | Model | Notes |
|---|---|---|
| 8211–8245 | Tatra T3R.P | Rebuilt by Pars Nova Šumperk (external contractor) |
| 8251–8299 | Tatra T3R.PLF | First PLF series, 2007+ |
| 8300–8579* | Tatra T3R.P | In-house DPP rebuilds; not fully contiguous — cars are continuously scrapped and the number retired/reused as PLF over time. ~280 numbers allocated historically, 298 P+PV in service today. |
| 8600–8750 | ~~Tatra T6A5~~ | **RETIRED 2021 — do not map to a live 3D model; treat as unknown/historic if seen.** |
| 8751–8806* | Tatra T3R.PLF | Second PLF series (newer rebuilds, continues to grow as more P cars are converted) |
| 9001–9050 (approx.) | Tatra KT8D5 pre-rebuild numbers | Original (Miskolc-import) numbering before RN2P conversion |
| 9051–9113 (partially filled) | Tatra **KT8D5.RN2P** | Rebuilt number = original import number **+ 50**. ~60 in service; range still filling in as more hulls are converted. |
| 9111–9113, 9163–9172 | Škoda 14T (renumbered edge cases) | A handful of 14T cars were renumbered (9111→9171, 9113→9172) after early scrappings (9112, 9163, 9165 scrapped; 9164 wrecked/withdrawn) |
| 9201–9459 (not fully contiguous) | Škoda **15T** | First car 9201 (2009); subtypes 15T0…15T7 all share this block; 250 in service. Treat any number in this span not otherwise claimed as 15T. |
| 9404–9629 (main run), with the 91xx renumbered stragglers above | Škoda **14T** | Delivered 2006–2010, 55–60 in service. **Overlaps numerically with the top of the 15T block (9404–9459) in some listings — if a number is ambiguous in the low-9400s, disambiguate by first-seen/delivery-year metadata (14T = 2006-2010 build; 15T = 2009-2017 build) or by shape data if available, not by number alone.** |
| 9501–9523+ (open-ended, growing through 2026) | Škoda **52T** | First 20-unit batch 9501-9520ish delivered Nov 2025-mid 2026; second 20-unit batch by 31 Dec 2026. One unit in the low 9500s was earmarked for MPK Wrocław, not Prague — don't assume every number in-range is a DPP Prague car. |

\* Ranges marked with `*` are the least certain — verify live against seznam-autobusu.cz before finalizing the lookup table in code.

### TypeScript-ready mapping table

```typescript
// Prague DPP tram model detection by evidenční číslo (vehicle_registration_number).
// Source: dpp.cz + seznam-autobusu.cz + prazsketramvaje.cz, snapshot 2026-07.
// NOTE: ranges shift as fleet is modernized — re-verify periodically against
// https://seznam-autobusu.cz/en/seznam?iddopravce=106&trakce=tramvaj&prov=1

export type TramModelId =
  | 'T3R.P'
  | 'T3R.PLF'
  | 'KT8D5.RN2P'
  | '14T'
  | '15T'
  | '52T'
  | 'unknown';

interface TramRange {
  min: number;
  max: number;
  model: TramModelId;
  /** Higher priority ranges are checked first when ranges overlap. */
  priority?: number;
}

// Ordered so overlapping/ambiguous ranges are resolved deterministically.
const TRAM_RANGES: TramRange[] = [
  { min: 8211, max: 8245, model: 'T3R.P' },
  { min: 8251, max: 8299, model: 'T3R.PLF' },
  { min: 8300, max: 8579, model: 'T3R.P' },
  // 8600-8750 (T6A5) intentionally omitted: retired since 2021.
  { min: 8751, max: 8806, model: 'T3R.PLF' },
  { min: 9051, max: 9113, model: 'KT8D5.RN2P' },
  // 14T explicit renumbered stragglers (checked before the big 15T/14T blocks):
  { min: 9163, max: 9172, model: '14T', priority: 10 },
  { min: 9404, max: 9629, model: '14T' },
  { min: 9201, max: 9459, model: '15T' }, // overlaps 14T at the top end; see note above
  { min: 9501, max: 9599, model: '52T' }, // open-ended, extend max as fleet grows
];

export function detectTramModel(evidenceNumber: number): TramModelId {
  const candidates = TRAM_RANGES.filter(
    (r) => evidenceNumber >= r.min && evidenceNumber <= r.max
  );
  if (candidates.length === 0) return 'unknown';
  candidates.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return candidates[0].model;
}

// Example: T3-family cars run coupled (2 cars = 1 physical train) on many lines.
// Golemio typically reports each physical vehicle separately even when coupled;
// you may see two consecutive/paired trip updates with adjacent-ish evidence
// numbers moving in lockstep. Render as two connected but separately-jointed
// bodies (not a single 2-section artic tram) when you detect a coupled pair.
```

---

## 2. Physical specs per type

### Tatra T3R.P
- **Dimensions:** L 15.10 m (over couplers) × W 2.50 m × H 3.06 m
- **Sections:** 1 (single rigid body, classic T3 shell), **high-floor** (900-970 mm above rail)
- **Doors:** 3 per side (2 folding-leaf, all manual/passenger-button), all on the right side only (unidirectional)
- **Bogies:** 2, both fixed under the body (no articulation)
- **Pantograph:** single scissor pantograph (or semi-pantograph on later rebuilds) centered on roof, roughly mid-body
- **Coupling:** frequently runs as a **2-car coupled pair** ("dvojice") on higher-demand lines — each half is mechanically identical, joined nose-to-tail with a mechanical coupler + electric jumper cable, **not** an articulated joint. For 3D/rendering purposes model as two independent rigid bodies that follow the path with a fixed following distance, not a single bendy mesh.
- **Capacity:** 69 seated + 22 standing (91 total)

### Tatra T3R.PLF
- **Dimensions:** L 15.10-16.20 m (sources vary slightly by rebuild batch) × W 2.48 m × H 3.185 m
- **Sections:** 1 body, but with a **partial low-floor middle portion** inserted — nicknamed "vana" ("bathtub" / "wana") by enthusiasts because of the stepped cross-section: low floor (350 mm) in the middle third only, high-floor platforms at each end. This is **not** a second articulated section — the shell is still one rigid unit, just re-floored.
- **Doors:** 3 per side, right-side only; the low-floor door is wider
- **Bogies:** 2, fixed (same underframe as T3R.P — no articulation)
- **Pantograph:** roof-mounted, center
- **Coupling:** same coupled-pair behavior as T3R.P; a P+PLF mixed pair is common
- **Capacity:** 75 seated + 22 standing (varies by rebuild batch, some 2+1 seating post-modernization)

### Tatra KT8D5.RN2P
- **Dimensions:** L 31.34 m (over couplers) × W 2.48 m × H 3.145 m
- **Sections:** 3 body sections, **2 articulation joints**. Only the ~33% middle section is low-floor (350 mm); the two end sections are high-floor (900-970 mm), reached via 3 internal steps from the middle.
- **Bogies:** original KT8D5 layout — powered bogies under the outer two sections (this is a Jacobs-type shared-bogie articulated design inherited from the 1980s KT8D5 platform); middle low-floor section rides on the shared/central articulation, not its own powered bogie.
- **Doors:** 10 total across the tram (i.e., ~3-4 per side per section stagger — treat as roughly 5 doors/side)
- **Pantograph:** semi-pantograph ("polopantograph," Stemmann/LEKOV) roof-mounted on one of the end sections
- **Front design:** modernized "semicircular" rounded cab front with a distinctive **curved white stripe wrapping the windshield/headlight area** on both ends (bidirectional-looking but actually unidirectional in DPP configuration)
- **Capacity:** 180 + 46 + 4 (three-tier seated/standing/wheelchair figure as quoted by DPP) — very high capacity, used on trunk lines

### Škoda 14T ("Porsche" / "ForCity" / nicknamed "Blues" or "Sněhurka" variants)
- **Dimensions:** L 30.25-31.25 m (sources vary: DPP official sheet says 30,250 mm; Wikipedia says 31,250 mm — use ~30.7 m as a safe average, verify against a specific car's spec plate if exactness matters) × W 2.46 m × H 3.37-3.40 m
- **Sections:** 5 body sections, **4 articulation joints**, unidirectional
- **Low-floor:** ~50% (partial low-floor — the "Porsche" 14T is notably less low-floor than the later 15T)
- **Doors:** 5 per side (one per section roughly)
- **Bogies:** 3 fixed bogie positions (some sections are "portal"/suspended between neighbors, riding on the adjacent section's bogie — classic multi-articulated tram construction) + all-6-axle-driven (12 wheels driven)
- **Pantograph:** single pantograph, roof, positioned over one of the central sections
- **Distinctive shape:** designed by **Porsche Design Studio** — angular, wedge-shaped nose with a sharply raked windshield and a prominent narrow "chin" air intake; flatter, more geometric body panels than the rounded T3/KT8D5; large windshield with minimal frame; headlights are small, embedded rectangular/trapezoidal units low on the nose rather than large round housings.
- **Reputation:** historically noisy/troubled (gearbox issues, structural cracks) — some cars modernized with revised interiors, capacity figures differ slightly for those units.

### Škoda 15T ("ForCity Alfa")
- **Dimensions:** L 31.40 m × W 2.46 m × H 3.45 m (Prague variant — Škoda's ForCity platform is modular and other cities running 15T-family cars, e.g. Riga, use different lengths/widths — **do not assume other cities' 15T dimensions apply to Prague**)
- **Sections:** 3 body sections, **2 articulation joints** (Prague spec; a 4-section/3-joint variant exists for other operators but Prague only runs the 3-section version)
- **Bogies:** **4 bogies total** — this is the key structural fact for rigging: a pivoting bogie under each of the 2 outer sections, plus **2 pivoting Jacobs-type bogies at the 2 articulation points** (25° swing), i.e. bogies sit basically at/near each joint and under each end, giving 4 bogie positions along the tram's length even though there are only 2 visible body joints. All 16 wheels driven (100%) on the Prague spec.
- **Low-floor:** 100%, floor height 350/450 mm over the bogies
- **Doors:** 6 total (2 double-leaf doors per body section)
- **Pantograph:** single, roof, center section
- **Distinctive shape:** rounder, more organic front than the 14T — a smoothly curved, bulbous nose with a large wraparound windshield and headlight clusters integrated into swept "eyebrow" surfaces; visibly more "friendly"/rounded than both the angular 14T and the boxy T3/KT8D5. This is the most numerous/iconic modern Prague tram — think of it as the default "modern Prague tram" silhouette.
- **Capacity:** 139 + 60 (199 total)

### Škoda 52T ("ForCity Plus Praha")
- **Dimensions:** L ~31.8 m × W 2.50 m (standard 1435 mm gauge)
- **Sections:** up to 5 car-body sections (Prague's order is the "up to 5 sections" configuration) — described as **4 bogies**: 2 full swivel bogies under the outer sections + 2 semi-swivel bogies under the 2nd/4th sections. This is a newer-generation articulation scheme than the 15T (more sections but similar bogie-per-joint philosophy).
- **Low-floor:** 100%, floor height 350 mm
- **Doors:** not fully documented in specs I found — expect ~6-8 given 5 sections; verify against DPP's `dpp.cz/vozovy-park/tramvaje/skoda-52t` page once it's populated (was sparse as of this research date).
- **Top speed:** 70 km/h (higher than all older types' 60-65 km/h) — useful if you ever need to sanity-check GPS speed against type.
- **Notable tech:** LiDAR anti-collision system, regenerative braking, R290 refrigerant A/C — not visually relevant but confirms this is the newest-generation vehicle.
- **Delivery:** first 7 cars arrived by mid-2025 for trial running (zkušební provoz), passenger service started 20 June 2025 with car 9503; batch of ~20 delivered through 2025-2026, second batch of 20 more by 31 Dec 2026. Based at **Hloubětín depot**.
- **Livery:** the **first production livery for the new PID grey/red vertical-stripe scheme** (see livery section below) — i.e. 52T cars are the flagship for the new corporate look, not the classic red/cream scheme.

---

## 3. Livery

Prague is **mid-transition between two livery generations** as of 2026 — expect both to appear in Golemio-tracked vehicles simultaneously.

### Classic livery (still the majority — T3R.P, T3R.PLF, KT8D5.RN2P, most 14T/15T)
- **Base color:** traffic red, historically close to **RAL 3020** ("dopravní červená") — applied as a band that wraps longitudinally around the lower half of the body.
- **Secondary color:** cream/ivory, close to **RAL 9001** — upper half of the body and roof.
- Horizontal split line roughly at window-sill height; a thin beige/cream pinstripe sometimes separates the two fields.
- Roof and pantograph/roof equipment are typically light grey or unpainted metal.
- This scheme dates to the current "Pražská integrovaná doprava" (PID) branding established ~2008 and is the scheme most people mean by "classic Prague tram colors."

### New livery (rolling out since ~2021, standard on new 52T deliveries, being applied to overhauled/repainted cars of other types)
- Designed by studio **superlative.works**, approved by the city; base colors are **red and light grey**.
- Stripes are **vertical** (a deliberate reversal from the old horizontal cream/red split) — red vertical bands over a grey body, concentrated toward the front/rear and around doors.
- New simplified "pid" wordmark (lowercase, three letters) replaces the old logo treatment.
- This is the scheme you'll see on all new 52T cars and increasingly on repainted/overhauled 15T and 14T units.
- **Implication for 3D asset pipeline:** don't hardcode "T3 = red/cream" as an absolute rule — livery should ideally be a swappable texture/material layer per vehicle, since the same model id can appear in either scheme depending on repaint status. If you can only ship one livery per model for v1, default to classic red/cream for T3R.P/PLF/KT8D5/14T/15T (still the large majority) and grey/red-vertical for 52T (100% of that fleet so far).

### Windows / glazing
- All types: continuous ribbon window band along the passenger saloon, dark-tinted glass (visually near-black from outside), separate small driver's windshield.
- 14T and 15T have noticeably larger, more curved windshields than the flat-ish T3/KT8D5 cab fronts.

---

## 4. Distinctive visual features summary (for 3D modeling)

| Type | Body shape | Front/cab | Windows | Roof |
|---|---|---|---|---|
| T3R.P/PLF | Boxy, slab-sided, rounded corners, single rigid unit | Flat-ish, rounded-corner cab with 3-piece flat/slightly curved windshield, round headlight pods | Rectangular ribbon windows, uniform pitch | Low-profile roof, single pantograph mid-roof, small vents |
| KT8D5.RN2P | 3 slab sections, visible accordion/bellows at 2 joints, low-floor "kneel" visible in middle section profile | Rounded/semicircular modernized nose, curved white accent stripe wrapping windshield | Ribbon windows, visible floor-height step between end and middle sections reflected in window sill height | Semi-pantograph, roof-mounted AC boxes on later cars |
| 14T | 5 slim sections with 4 visible bellows joints, distinctly narrower/more tapered mid-sections | Angular Porsche-designed wedge nose, sharply raked one-piece windshield, small trapezoidal headlights low in the nose, narrow "chin" spoiler/intake | Large flat glass panes, minimal frame | Pantograph over a central section, flatter roof line than T3 |
| 15T | 3 chunky sections, 2 joints, visibly bulbous/rounded body sides | Rounded, bulbous "friendly" nose, wraparound curved windshield merging into headlight "eyebrows," headlights integrated as swept light clusters (not separate round pods) | Tall ribbon windows, rounded upper corners | Pantograph central section, rounded roof edges, roof-mounted A/C pods (visible boxes) |
| 52T | Up to 5 sections, most modern/aerodynamic detailing, similar general proportions to 15T but newer skin | Similar rounded family look to 15T but revised lighting (likely LED clusters — verify from photos), possible LiDAR sensor pod near front | Large glazing, likely full-height door glass | Roof-mounted A/C, LiDAR sensor bump, pantograph |

General modeling note: **T3-family = 1 rigid body (or 2 bodies if coupled), everything else = multi-section articulated mesh with bellows/rubber gaiters visible at each joint.** The joint count is your primary geometry-complexity driver: T3=0 (or 1 mechanical coupler gap if paired), KT8D5/15T=2, 14T/52T=4.

---

## 5. Approximate lines (nice-to-have, verify against current PID timetable — changes with track closures)
- **15T / 52T**: run system-wide, including the highest-capacity trunk lines (historically 17, 22, 9, 5, 3, 11, 14, 18, 24 have all seen 15T).
- **14T**: concentrated around **Kobylisy depot** workings — lines serving the northern Prague network (8, 24, 25, 26 area) plus some Motol-depot workings.
- **T3R.P / T3R.PLF**: predominantly outer/suburban lines and lines with tighter curves or lower demand where a single (or coupled-pair) car suffices; also common on lines through areas with older, less-reinforced track.
- **KT8D5.RN2P**: high-capacity trunk routes needing 3-section throughput without full 15T deployment, e.g. historically lines like 9, 17, 22.
- **52T**: newest deliveries, based at **Hloubětín depot** — expect to see them first on Hloubětín-area lines before city-wide rollout completes in 2026-2027.

Treat all of the above as indicative only — DPP reassigns rolling stock to depots/lines regularly and Golemio's live positions are the ground truth; use this only as a sanity check, not a source of truth for line assignment.

---

## 6. Sources
- https://www.dpp.cz/vozovy-park/tramvaje/tatra-t3r-p
- https://www.dpp.cz/vozovy-park/tramvaje/tatra-t3r-plf
- https://www.dpp.cz/vozovy-park/tramvaje/tatra-kt8d5-rn2p
- https://www.dpp.cz/vozovy-park/tramvaje/skoda-14t
- https://www.dpp.cz/vozovy-park/tramvaje/skoda-15t
- https://seznam-autobusu.cz/en/typy/dopravni-podnik-hl-m-prahy/tramvaje
- https://seznam-autobusu.cz/en/seznam?iddopravce=106&trakce=tramvaj&vyrobce=%C5%A0koda&ntyp=14T
- https://seznam-autobusu.cz/en/seznam?iddopravce=106&trakce=tramvaj&vyrobce=%C5%A0koda&ntyp=52T
- https://www.prazsketramvaje.cz/view.php?cisloclanku=2006040819 (T3R.P evidence numbers)
- https://www.prazsketramvaje.cz/view.php?cisloclanku=2006103101 (T3R.PLF evidence numbers)
- https://www.prazsketramvaje.cz/view.php?cisloclanku=2006040802 (KT8D5.RN2P evidence numbers)
- https://cs.wikipedia.org/wiki/Tatra_T3R.P
- https://cs.wikipedia.org/wiki/Tatra_T3R.PLF
- https://cs.wikipedia.org/wiki/Tatra_KT8D5R.N2P
- https://cs.wikipedia.org/wiki/Tramvajov%C3%A1_doprava_v_Praze
- https://en.wikipedia.org/wiki/%C5%A0koda_15_T
- https://en.wikipedia.org/wiki/%C5%A0koda_14_T
- https://en.wikipedia.org/wiki/%C5%A0koda_52_T
- https://dopravacek.eu/2026/04/06/tramvajovy-newsletter-breznovy-souhrn-udalosti-u-prazskych-tramvaji-3-2026/
- https://dopravacek.eu/2026/01/04/tramvajovy-newsletter-prosincovy-souhrn-udalosti-u-prazskych-tramvaji-12-2025/
- https://www.irozhlas.cz/zpravy-domov/nova-tramvaj-praha-dpp-pid-novy-design-nove-barvy-cervena-seda_2105191811_ako (new PID livery)
- https://zpravy.aktualne.cz/domaci/designova-revoluce-tramvaje-a-autobusy-v-praze-zmeni-po-dlou/ (livery redesign background)
- https://www.seznamzpravy.cz/clanek/v-prazske-mhd-konci-provoz-tramvaji-t6a5-jezdily-25-let-167722 (T6A5 retirement, 2021)
- https://cs.wikinews.org/wiki/V_Praze_dojezdily_tramvaje_Tatra_T3 (classic T3 retirement, 2011)
