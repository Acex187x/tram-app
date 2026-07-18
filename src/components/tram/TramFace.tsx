// TramFace — THE entry point for the tram model "face" icon. The art now comes
// in multiple icon PACKS (src/components/tram/faces/packs/*, registered in
// '@/lib/fleet/iconPacks'), each a full 7-model set in a distinct style. By
// default the face renders in the user's selected pack (settings store); pass
// `pack` to pin a specific one (settings picker previews do).
//
// The same vector art is rasterized per pack for map sprites by
// scripts/tram-models/render-face-sprites.mjs →
// assets/images/faces/<packId>/<modelId>.png, registered via
// ICON_PACKS[pack].sprites.
import type { ReactElement } from 'react';

import { getFace, type IconPackId } from '@/lib/fleet/iconPacks';
import type { TramModelId } from '@/lib/types';
import { useSettingsStore } from '@/stores/settings';

export interface TramFaceProps {
  modelId: TramModelId;
  /** Square size in pt. Defaults to 64. */
  size?: number;
  /** Icon pack to render; defaults to the user's selected pack (settings). */
  pack?: IconPackId;
}

/**
 * The face icon for a tram model. Unknown models fall back to the classic T3;
 * existing callers (tram sheet header, model info, AboutTramRow) pass only
 * modelId/size and automatically honor the selected pack.
 */
export function TramFace({ modelId, size = 64, pack }: TramFaceProps): ReactElement {
  const selectedPack = useSettingsStore((s) => s.iconPack);
  const Face = getFace(pack ?? selectedPack, modelId);
  return <Face size={size} />;
}
