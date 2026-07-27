// Shared metrics for the home sheet's pinned header. Kept in their own module so
// the header components, the sheet's peek-height math and the map screen all
// agree without importing each other's components.

import { SEARCH_H } from '@/components/maps-kit/mapSheetLayout';

/**
 * Horizontal padding inside the sheet card — re-exported from the ONE module
 * that owns it (`sheetLook`) rather than declared here, so the home sheet, the
 * tram card and every native route sheet cannot drift onto different edges
 * again. See `SHEET_H_PAD` there for the measurements behind 16.
 *
 * It is deliberately NOT `CARD_PAD`: that is the 14 pt VERTICAL inset, and
 * Apple's own horizontal one is 1.5 pt wider because the collapsed bar is a
 * capsule whose end arcs the field has to clear.
 */
export { SHEET_H_PAD } from '@/components/maps-kit/sheetLook';

/**
 * Diameter of the circular settings button beside the search field.
 *
 * EXACTLY the field's height — one constant, not two. The previous pass sized it
 * by ratio off Apple's trailing avatar (32 in a 39 pt field ⇒ a 40 pt circle in
 * a 48 pt slot), which was a misread: Apple's trailing element is an UNFILLED
 * `person.circle` SYMBOL, so its glyph is naturally smaller than its slot and
 * the sheet material shows through it. Ours is a FILLED capsule-coloured disc —
 * the same recessed fill as the field — so a disc smaller than the field it sits
 * beside reads as a mismatched pair of shapes rather than as a lighter symbol.
 * On device the user's verdict was blunt: it looked ridiculous.
 *
 * At SEARCH_H the two controls share one baseline, one height and one radius
 * rule (r = h/2), and the row's trailing inset equals its leading one.
 */
export const SETTINGS_D = SEARCH_H;
