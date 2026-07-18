// Face pack "side" — Side Profile. Bold flat-vector side silhouettes on a
// light plate: length, section count, livery bands and pantograph type are
// the spotter cues (T3 short cream/red single, T3R.P coupled LED-brow pair,
// T3R.PLF silver single, KT8D5 boxy three-section with two diamonds, 14T red
// wedge-nosed five-module, 15T black-band four-section, 52T white three-
// section with the black helmet visor).
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
  id: 'side',
  name: 'Side Profile',
  description: 'Full-length side silhouettes — length, sections, doors and pantographs tell the fleet apart',
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
