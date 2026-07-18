// Model reference-screen content: history, fun facts, spec tables and Prague
// service notes per tram model, rendered by src/app/model-info/[id].tsx.
//
// Facts researched 2026-07 from: docs/research/prague-fleet.md (DPP official
// spec sheets, snapshot 2026-07), en/cs.wikipedia.org (Tatra T3, Tatra KT8D5,
// Škoda 14T / 15T / 52T), english.radio.cz (T3 60-year and 14T 20-year
// retrospectives), skodagroup.com press releases (52T), and
// urban-transport-magazine.com (52T). Figures prefixed with ≈ are approximate
// or vary between sources/rebuild batches; unprefixed numbers follow the DPP
// or manufacturer spec sheets. Fleet counts are DPP figures as of 1 Jan 2026.

import type { TramModelId } from '@/lib/types';

export interface ModelHistory {
  /** Display name, matches MODEL_SPECS[id].name. */
  title: string;
  /** Manufacturer / rebuilder line for the header. */
  maker: string;
  /** Build (and rebuild) years for the header. */
  years: string;
  /** 2–3 paragraph history, joined with blank lines. */
  summary: string;
  funFacts: string[];
  specs: { label: string; value: string }[];
  /** The model's story in Prague specifically. */
  pragueService: string;
}

export const MODEL_HISTORY: Record<TramModelId, ModelHistory> = {
  t3: {
    title: 'Tatra T3',
    maker: 'ČKD Tatra, Prague-Smíchov',
    years: '1960–1999 (Prague cars 1962–1976)',
    summary:
      'The Tatra T3 is the most-produced tram design in history: 13,991 powered cars ' +
      'plus 122 trailers left the ČKD Tatra works in Prague-Smíchov between 1960 and ' +
      '1999. Built on American PCC streetcar technology licensed by Tatra, it was ' +
      'designed to carry as many passengers as its T2 predecessor while being lighter ' +
      'and far cheaper to build.\n\n' +
      'Its timeless rounded face — a glass-laminate front mask with two protruding ' +
      'round headlights — was drawn by designer František Kardaus and became one of ' +
      'the proudest products of 1960s Czechoslovak industry. The T3 went on to ' +
      'dominate tram networks across the Eastern Bloc; the Soviet T3SU variant alone ' +
      'ran to 11,368 cars, delivered to Moscow and more than 30 other cities.\n\n' +
      'A late-2000s reliability study of the Prague fleet measured the T3 at 98.9% — ' +
      'the best of any type in the system, four decades after it entered service. ' +
      'That robustness is why the design survives today inside Prague’s modernized ' +
      'T3R.P and T3R.PLF rebuilds.',
    funFacts: [
      'Most-produced tram in world history — roughly 14,000 cars of all T3 variants were built.',
      'Prague alone once ran over 1,000 of them at the type’s peak.',
      'The Soviet T3SU version (11,368 cars) is the largest production run of a single streetcar type ever.',
      'The rounded fibreglass-laminate face was styled by František Kardaus in the late 1950s and barely changed for 40 years of production.',
      'A Prague fleet study measured 98.9% reliability — the best of any type in the system.',
      'Classic red-and-cream T3s still run Prague’s heritage line 42 through the city centre.',
    ],
    specs: [
      { label: 'Length', value: '14.1 m (single body)' },
      { label: 'Width / height', value: '2.50 m / 3.06 m' },
      { label: 'Sections · doors', value: '1 section · 3 doors per side' },
      { label: 'Floor', value: 'High floor (≈900 mm)' },
      { label: 'Power', value: '4 × 40 kW (≈160 kW)' },
      { label: 'Top speed', value: '65 km/h' },
      { label: 'Capacity', value: '≈110 passengers' },
      { label: 'Built', value: '13,991 cars + 122 trailers (all variants)' },
    ],
    pragueService:
      'The T3 entered regular Prague service on 21 November 1962 and carried the city ' +
      'for half a century. Classic, unmodernized cars ended everyday service in ' +
      'October 2011, but the type never really left: hundreds of T3 shells live on as ' +
      'the modernized T3R.P and T3R.PLF cars still crossing the city daily, and ' +
      'preserved originals run the heritage line 42 and special workings. If you spot ' +
      'a plain “T3” in the app, you are looking at a piece of living history.',
  },

  t3rp: {
    title: 'Tatra T3R.P',
    maker: 'ČKD Tatra shells · rebuilt by DPP & Pars Nova Šumperk',
    years: '1963–1973 shells · rebuilt 2000s',
    summary:
      'The T3R.P is Prague’s answer to a fleet of beloved but ageing T3s: keep the ' +
      'iconic 1960s body shell, replace everything electrical. During the 2000s, ' +
      'hundreds of T3 cars built between 1963 and 1973 were stripped to the shell and ' +
      'rebuilt — most in DPP’s own central workshops, an early batch by Pars Nova in ' +
      'Šumperk.\n\n' +
      'The rebuild swapped the original resistor-based control for the Czech ' +
      '“TV Progress” IGBT drive with regenerative braking, added a modernized cab and ' +
      'refreshed interiors. The result is a tram that looks like 1962 outside and ' +
      'drives like a modern vehicle underneath — at a fraction of the cost of buying ' +
      'new low-floor trams.\n\n' +
      'T3R.P cars almost always work in coupled two-car pairs (“dvojice”), doubling ' +
      'capacity on busier lines while keeping the flexibility of single cars for ' +
      'quieter routes and depots with tight curves.',
    funFacts: [
      'Still the most numerous type in Prague — 298 cars in service as of 1 January 2026.',
      'Outside it is a 1960s Kardaus classic; inside the shell hides modern IGBT power electronics with regenerative braking.',
      'They nearly always roam in coupled two-car pairs — two separate cars, not an articulated tram.',
      'Some shells are over 60 years old — older than the parents of many of their drivers.',
      'As cars are retired, their fleet numbers are often reborn on freshly rebuilt T3R.PLF low-floor cars.',
    ],
    specs: [
      { label: 'Length', value: '15.1 m over couplers (14.1 m body)' },
      { label: 'Width / height', value: '2.50 m / 3.06 m' },
      { label: 'Sections · doors', value: '1 section · 3 doors per side' },
      { label: 'Floor', value: 'High floor (≈900 mm)' },
      { label: 'Drive', value: 'TV Progress IGBT, regenerative braking' },
      { label: 'Top speed', value: '65 km/h' },
      { label: 'Capacity', value: '≈91 passengers per car' },
      { label: 'In Prague service', value: '298 cars (1 Jan 2026)' },
    ],
    pragueService:
      'With 298 cars in service, the T3R.P is still the backbone of Prague’s ' +
      'classic-tram operation, typically running coupled pairs on outer and ' +
      'medium-demand lines. Its days are numbered, though: cars are being retired ' +
      'week by week as new Škoda 52Ts arrive and more shells are converted into ' +
      'low-floor T3R.PLFs — catch the high-floor pairs while you can.',
  },

  t3rplf: {
    title: 'Tatra T3R.PLF',
    maker: 'ČKD Tatra shells · rebuilt by DPP & KOS Krnov',
    years: '1960s–70s shells · rebuilt 2007–present',
    summary:
      'The T3R.PLF takes the T3 modernization one step further: alongside the new ' +
      'electrics, the middle third of the floor is cut down to a 350 mm low-floor ' +
      'section with a wider centre door. Enthusiasts nicknamed the stepped centre the ' +
      '“vana” — the bathtub — for its sunken cross-section.\n\n' +
      'Rebuilt since 2007 by Krnovské opravny a strojírny (KOS) and DPP’s workshops, ' +
      'the PLF finally made the sixty-year-old design wheelchair- and pram-accessible ' +
      'without giving up the classic silhouette. The shell remains a single rigid ' +
      'body — the low floor is an insert, not a new articulated section.\n\n' +
      'Conversion is still ongoing: retired T3R.P cars are being reborn as PLFs ' +
      'one-for-one, making this arguably the newest “old” tram in Europe — a vehicle ' +
      'still entering production whose body design dates to the late 1950s.',
    funFacts: [
      'The sunken low-floor middle earned it the nickname “vana” — Czech for bathtub.',
      'Rebuilds are still being delivered — new examples of a 1950s-designed tram, in the 2020s.',
      'Mixed coupled pairs are common: a high-floor T3R.P leading a low-floor PLF, or vice versa.',
      'The low-floor centre door is wider than the originals and sits just 350 mm above the rails.',
      '76 cars were in service as of 1 January 2026, and the count grows as T3R.Ps are converted.',
    ],
    specs: [
      { label: 'Length', value: '≈15.1 m over couplers' },
      { label: 'Width / height', value: '2.48 m / 3.19 m' },
      { label: 'Sections · doors', value: '1 section · 3 doors (wide low-floor centre door)' },
      { label: 'Floor', value: 'Partial low floor — 350 mm centre “vana”' },
      { label: 'Drive', value: 'TV Progress IGBT, regenerative braking' },
      { label: 'Top speed', value: '65 km/h' },
      { label: 'Capacity', value: '≈95 passengers per car' },
      { label: 'In Prague service', value: '76 cars (1 Jan 2026), growing' },
    ],
    pragueService:
      'The PLF is DPP’s bridge between heritage and accessibility: it keeps classic ' +
      'T3 pairs viable on lines that now require low-floor access. Since 2007 the ' +
      'fleet has grown steadily as KOS Krnov converts retired T3R.P shells, and the ' +
      'type is currently the direct one-for-one replacement for high-floor T3R.Ps ' +
      'leaving service.',
  },

  kt8d5: {
    title: 'Tatra KT8D5.RN2P',
    maker: 'ČKD Tatra · rebuilt by DPP & KOS Krnov',
    years: '1986–1990 · rebuilt 2004–present',
    summary:
      'The KT8D5 was ČKD Tatra’s big articulated tram of the late socialist era: ' +
      'three body sections on eight axles, and — uniquely in Prague — fully ' +
      'bidirectional, with a driver’s cab at each end and doors on both sides. ' +
      'Prague took 48 of them between 1986 and 1990 for its heaviest trunk lines.\n\n' +
      'From 2004 to 2014 the surviving cars were rebuilt as KT8D5.RN2P: the entire ' +
      'original middle section was swapped for a newly built low-floor one, and the ' +
      'electrics were modernized with the TV Progress drive. The result is a ' +
      '30-metre, high-capacity tram with step-free boarding at its centre doors.\n\n' +
      'When more capacity was needed, DPP went shopping for its own history: since ' +
      '2016 it has bought back KT8D5s retired from Miskolc in Hungary, rebuilding ' +
      'them to RN2P standard from 2020 onward. These “immigrant” cars pushed the ' +
      'Prague fleet to around 60 vehicles.',
    funFacts: [
      'Prague’s only bidirectional tram — cabs at both ends mean it can reverse without a turning loop, which makes it the hero of track-works shuttle services.',
      'During modernization the whole middle section is discarded and replaced with a brand-new low-floor one.',
      'Around 15 of the fleet are returnees from Miskolc, Hungary — sold abroad in the 1990s–2000s and bought back decades later.',
      'A rebuilt car’s fleet number is its Miskolc-import number plus 50.',
      'At over 30 metres and eight axles, it was the longest and heaviest tram ČKD ever built in series.',
    ],
    specs: [
      { label: 'Length', value: '30.3 m (3 sections, 2 joints)' },
      { label: 'Width / height', value: '2.48 m / 3.15 m' },
      { label: 'Axles', value: '8, all powered' },
      { label: 'Power', value: '≈360 kW (8 × 45 kW)' },
      { label: 'Floor', value: 'Low-floor middle section (350 mm), high-floor ends' },
      { label: 'Layout', value: 'Bidirectional — cab at each end' },
      { label: 'Top speed', value: '65 km/h' },
      { label: 'Capacity', value: '≈200+ passengers' },
      { label: 'In Prague service', value: '≈60 cars (1 Jan 2026)' },
    ],
    pragueService:
      'Delivered 1986–1990 as cars 9001–9048 for the busiest corridors, the KT8D5 ' +
      'has spent four decades on Prague’s trunk lines — historically the likes of 9, ' +
      '17 and 22. Its bidirectional layout keeps it indispensable today: whenever ' +
      'track reconstruction severs a line, KT8D5s run the temporary shuttle services ' +
      'no other Prague tram can. The rebuilt RN2P fleet, swollen by ex-Miskolc ' +
      'returnees, numbers about 60 cars.',
  },

  '14t': {
    title: 'Škoda 14T Elektra',
    maker: 'Škoda Transportation · design by Porsche Design Studio',
    years: '2006–2010',
    summary:
      'The 14T was Prague’s leap into the low-floor era — and a famously bumpy one. ' +
      'Sixty five-section trams were ordered from Škoda Transportation, with a ' +
      'wedge-nosed body styled by Porsche Design Studio. The first car entered ' +
      'service in January 2006 to high expectations: a futuristic look and room for ' +
      'around 270 passengers.\n\n' +
      'Reality bit quickly. The 14T rides on fixed (non-pivoting) bogies, which ' +
      'ground and squealed through Prague’s tight curves; gearboxes failed, cracks ' +
      'appeared, and passengers grumbled about narrow aisles and the seat layout. By ' +
      'the end of 2012 DPP had filed some 400 complaints with the maker, and the ' +
      'type’s troubles ultimately forced service withdrawals for repairs and ' +
      'modification.\n\n' +
      'After rebuilt interiors — transverse seats, new poles and flooring — the ' +
      'fleet returned, and 55 of the original 60 still serve today, sensibly rostered ' +
      'onto straighter routes. Its greatest legacy is arguably the 15T: Škoda ' +
      'designed the successor’s pivoting bogies specifically to fix what the 14T got ' +
      'wrong.',
    funFacts: [
      'Its wedge-shaped body was styled by Porsche Design Studio — Praguers simply call it “the Porsche”.',
      'The type was so troublesome that DPP had filed around 400 complaints with Škoda by the end of 2012.',
      'Locals also nicknamed it “Blues” — partly for the sound its drivetrain makes.',
      'Its fixed bogies disliked Prague’s tight curves so much that the successor 15T was designed around pivoting bogies as a direct fix.',
      'After interior rebuilds, 55 of the 60 cars survive — rostered mostly onto lines with gentler curves.',
    ],
    specs: [
      { label: 'Length', value: '30.25 m (5 sections, 4 joints)' },
      { label: 'Width / height', value: '2.46 m / 3.37 m' },
      { label: 'Low floor', value: '≈50% of the interior' },
      { label: 'Doors', value: '5 per side' },
      { label: 'Bogies', value: 'Fixed (non-pivoting)' },
      { label: 'Top speed', value: '60 km/h' },
      { label: 'Capacity', value: '≈270 passengers' },
      { label: 'Built for Prague', value: '60 cars · 55 in service (1 Jan 2026)' },
    ],
    pragueService:
      'Prague is the only city that ever ran the 14T. The fleet is concentrated on ' +
      'Kobylisy-depot workings across northern Prague, deliberately assigned to ' +
      'routes with fewer sharp curves to spare its fixed bogies. Twenty years on ' +
      'from its 2006 debut, the once-notorious “Porsche” has settled into reliable ' +
      'middle age — a striking, angular counterpoint to the rounded 15T everywhere ' +
      'around it.',
  },

  '15t': {
    title: 'Škoda 15T ForCity Alfa',
    maker: 'Škoda Transportation, Plzeň (with VUKV)',
    years: '2009–2017 (deliveries to 2019)',
    summary:
      'The 15T ForCity Alfa is the world’s first mass-produced 100% low-floor tram ' +
      'riding on pivoting bogies — engineered from 2005–2008 as a direct response to ' +
      'the 14T’s struggles with Prague’s curvy, hilly network. Two pivoting end ' +
      'bogies and two Jacobs bogies under the articulations let the 31-metre tram ' +
      'sweep through tight curves that punished its predecessor.\n\n' +
      'Its drivetrain is just as radical: there are no gearboxes at all. Every one ' +
      'of the 16 wheels is driven by its own gearless permanent-magnet motor, ' +
      'totalling 740 kW — enough for 80 km/h, though Prague service caps it lower. ' +
      'The completely flat 350–450 mm floor runs the full length of the car.\n\n' +
      'Prague ordered 250 of them, delivered between 2011 and 2019, making the 15T ' +
      'the undisputed backbone of the fleet — the default silhouette of the modern ' +
      'Prague tram, and the launch vehicle of Škoda’s successful ForCity family.',
    funFacts: [
      'World’s first mass-produced 100% low-floor tram with pivoting bogies.',
      'All 16 wheels are individually driven by gearless permanent-magnet motors — there is not a single gearbox on board.',
      'With 250 cars, it is the largest single tram fleet Prague has ever bought.',
      'Designed for 80 km/h, faster than any Prague predecessor — though city service never uses it all.',
      'It exists because of the 14T: its pivoting bogies are the engineered fix for the fixed-bogie problems of the “Porsche”.',
    ],
    specs: [
      { label: 'Length', value: '31.4 m (3 sections, 2 joints)' },
      { label: 'Width / height', value: '2.46 m / 3.45 m' },
      { label: 'Low floor', value: '100% — floor 350–450 mm' },
      { label: 'Bogies', value: '4 pivoting (2 end + 2 Jacobs), all axles driven' },
      { label: 'Power', value: '740 kW (16 × 46 kW wheel motors)' },
      { label: 'Doors', value: '6 per side' },
      { label: 'Top speed', value: '80 km/h design (60 km/h in service)' },
      { label: 'Capacity', value: '≈300 (61 seated)' },
      { label: 'In Prague service', value: '250 cars (1 Jan 2026)' },
    ],
    pragueService:
      'Deliveries ran from 2011 to February 2019, and the 250-strong fleet now works ' +
      'virtually every corner of the network — from the tourist-packed 22 over ' +
      'Prague Castle to the fast Barrandov viaducts. If you picture a Prague tram ' +
      'built this century, you are picturing a 15T: it carries more passengers daily ' +
      'than any other type in the city.',
  },

  '52t': {
    title: 'Škoda 52T ForCity Plus',
    maker: 'Škoda Transportation, Plzeň',
    years: '2024–present (in service since 2025)',
    summary:
      'The 52T ForCity Plus Praha is Prague’s newest generation of tram — the first ' +
      'all-new type since the 15T, ordered under a framework agreement that allows ' +
      'up to 200 vehicles. The first car was assembled and tested in 2024, initial ' +
      'deliveries arrived in May 2025, and passenger service began on 20 June 2025.\n\n' +
      'It is a fully low-floor, five-section, 31.8-metre tram packed with ' +
      'current-generation technology: a LiDAR-based anti-collision system watching ' +
      'the street ahead, regenerative braking that returns energy to the grid, a new ' +
      'electromechanical brake, and full air conditioning running on the natural ' +
      'refrigerant R290.\n\n' +
      'The 52T is also the face of Prague transit’s visual future: it is the first ' +
      'vehicle delivered from the factory in the new grey-and-red vertical-stripe ' +
      'PID livery, replacing the classic cream-and-red look that has defined the ' +
      'city’s trams for decades.',
    funFacts: [
      'Watches the street with LiDAR sensors — the first Prague tram with an active anti-collision system.',
      'First tram factory-painted in the new grey-and-red PID livery, retiring the classic cream-and-red look.',
      'Fastest tram in the fleet at 70 km/h — every older type tops out at 60–65.',
      'Its air conditioning runs on R290 — essentially purified propane, a climate-friendly natural refrigerant.',
      'Of its 70 padded seats, 26 face backwards — a deliberate crowd-flow choice.',
      'The framework contract allows up to 200 cars, enough to reshape the whole fleet through the 2030s.',
    ],
    specs: [
      { label: 'Length', value: '≈31.8 m (5 sections, 4 joints)' },
      { label: 'Width', value: '2.50 m' },
      { label: 'Low floor', value: '100% — floor 350 mm' },
      { label: 'Weight', value: '48 t' },
      { label: 'Bogies', value: '4 (2 full-swivel + 2 semi-swivel)' },
      { label: 'Top speed', value: '70 km/h' },
      { label: 'Capacity', value: '243 passengers (70 seated)' },
      { label: 'Ordered', value: '40 firm · framework up to 200' },
      { label: 'In Prague service', value: 'Deliveries ongoing through 2026' },
    ],
    pragueService:
      'The first 52T carried Prague passengers on 20 June 2025, and the type earned ' +
      'full type-approval that October. The fleet is based at Hloubětín depot, so ' +
      'early sightings cluster on lines reaching northeast Prague before the ' +
      'city-wide rollout completes. Forty cars are due by the end of 2026, with the ' +
      'framework contract leaving room for up to 200 — spotting one today means ' +
      'spotting the future of the network.',
  },
};
