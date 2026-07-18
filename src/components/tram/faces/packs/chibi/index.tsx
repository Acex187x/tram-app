// Chibi Mascot face pack — super-deformed cute mascot trams: huge glossy
// windscreen-eyes, squashed bodies on tiny wheel-feet, thick storybook
// outlines, blush, one signature accessory per model. Each face stays
// enthusiast-recognizable (narrow number box on t3, LED brow on t3rp,
// maroon/silver wink on t3rplf, square-eyed two-eared kt8d5, googly
// Porsche 14t, robot 15t, tall-glass serene 52t).
import type React from 'react';

import type { TramModelId } from '@/lib/types';

import { Face as Face14t } from './14t';
import { Face as Face15t } from './15t';
import { Face as Face52t } from './52t';
import { Face as FaceKt8d5 } from './kt8d5';
import { Face as FaceT3 } from './t3';
import { Face as FaceT3rp } from './t3rp';
import { Face as FaceT3rplf } from './t3rplf';

export const PACK_META = {
  id: 'chibi',
  name: 'Chibi Mascot',
  description: 'Super-deformed cute mascot faces — big glossy eyes, tiny wheels, big personality.',
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
