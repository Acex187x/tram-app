// Face pack "side" — Side Profile. Big NOSE PORTRAITS in side view on a
// light plate: only the front cab, cropped large, nose facing left, with a
// bit of pantograph as horns. The windscreen rake in profile is the spotter
// cue (T3/T3R.P rounded bathtub prow, T3R.PLF the same prow in silver with a
// wine cheek mask, KT8D5 boxy flat rake, 14T Porsche ski-jump wedge, 15T
// extreme black-glass sweep with the red brow cap, 52T tall near-vertical
// black helmet visor on a white body).
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
  description: 'Nose portraits in side view — the windscreen rake and prow shape tell the fleet apart',
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
