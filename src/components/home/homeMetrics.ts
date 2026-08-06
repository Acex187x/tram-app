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
 * It is deliberately NOT `CARD_PAD`: that is the 14 pt vertical inset.
 */
export { SHEET_H_PAD } from '@/components/maps-kit/sheetLook';

/**
 * Size of the square settings control beside the product/search header.
 */
export const SETTINGS_D = SEARCH_H;
