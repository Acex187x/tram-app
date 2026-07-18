// Face pack "side" — Side Profile. Full-length flat-vector side silhouettes
// on a dark depot plate: length, section count, doors and pantograph type are
// the spotter cues (T3 short single, T3R.P coupled pair, KT8D5 two-headed
// three-section, 14T five-section caterpillar, 15T three long sections,
// 52T glassy five-section flagship).
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
