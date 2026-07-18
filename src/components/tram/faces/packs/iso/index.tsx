// "iso" face pack — cute 3/4 isometric tram portraits.
// Every model shares the same camera: front face toward the lower-left, side
// receding upper-right on a 2:1 iso grid, front-left key light, cel outlines,
// soft ground shadow. See ./lib.ts for the shared projection + palette.
import type * as React from 'react';

import type { TramModelId } from '@/lib/types';

import { Face as Face14t } from './14t';
import { Face as Face15t } from './15t';
import { Face as Face52t } from './52t';
import { Face as FaceKt8d5 } from './kt8d5';
import { Face as FaceT3 } from './t3';
import { Face as FaceT3rp } from './t3rp';
import { Face as FaceT3rplf } from './t3rplf';

export const PACK_META = {
  id: 'iso',
  name: 'Isometric 3/4',
  description: 'Toy-like dimensional 3/4 view — each tram shows its face and its flank',
} as const;

export const FACES: Record<TramModelId, React.FC<{ size?: number }>> = {
  t3: FaceT3,
  t3rp: FaceT3rp,
  t3rplf: FaceT3rplf,
  kt8d5: FaceKt8d5,
  '14t': Face14t,
  '15t': Face15t,
  '52t': Face52t,
};
