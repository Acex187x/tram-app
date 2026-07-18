// TramFace — THE entry point for the tram model "face" icon set. A flat-vector
// front-view мордочка per Prague tram model (react-native-svg), cute but
// recognizable to an enthusiast: each face keeps its real windshield shape,
// headlight layout, livery and pantograph. Faces are self-contained (own body
// fill + outline) and read on light and dark backgrounds at any square size.
//
// The same art is rasterized for map sprites by
// scripts/tram-models/render-face-sprites.mjs → assets/images/faces/*.png,
// registered via FACE_SPRITE_ASSETS in '@/lib/fleet/faceIcons'.
import type { ComponentType, ReactElement } from 'react';

import type { TramModelId } from '@/lib/types';

import { Face14T } from './faces/14t';
import { Face15T } from './faces/15t';
import { Face52T } from './faces/52t';
import type { FaceProps } from './faces/common';
import { FaceKT8D5 } from './faces/kt8d5';
import { FaceT3 } from './faces/t3';
import { FaceT3RP } from './faces/t3rp';
import { FaceT3RPLF } from './faces/t3rplf';

const FACE_COMPONENTS: Record<TramModelId, ComponentType<FaceProps>> = {
  t3: FaceT3,
  t3rp: FaceT3RP,
  t3rplf: FaceT3RPLF,
  kt8d5: FaceKT8D5,
  '14t': Face14T,
  '15t': Face15T,
  '52t': Face52T,
};

export interface TramFaceProps {
  modelId: TramModelId;
  /** Square size in pt. Defaults to 64. */
  size?: number;
}

/** The face icon for a tram model. Unknown ids fall back to the classic T3. */
export function TramFace({ modelId, size = 64 }: TramFaceProps): ReactElement {
  const Face = FACE_COMPONENTS[modelId] ?? FaceT3;
  return <Face size={size} />;
}
