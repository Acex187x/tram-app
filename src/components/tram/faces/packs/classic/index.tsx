// "classic" face pack — refined flat-vector front views, Prague cream & red.
// The polished default: accurate model tells (narrow T3 number box, KT8D5
// curved white stripe, 15T cheekbone clusters, corrected tall-glass 52T)
// with a warm, consistent visual identity across all seven models.
import type React from 'react';

import type { TramModelId } from '@/lib/types';

import { Face as Face14t } from './14t';
import { Face as Face15t } from './15t';
import { Face as Face52t } from './52t';
import { Face as kt8d5 } from './kt8d5';
import { Face as t3 } from './t3';
import { Face as t3rp } from './t3rp';
import { Face as t3rplf } from './t3rplf';

export const PACK_META = {
  id: 'classic',
  name: 'Classic Front',
  description: 'Refined flat-vector faces in Prague cream & red — the polished originals',
} as const;

export const FACES: Record<TramModelId, React.FC<{ size?: number }>> = {
  t3,
  t3rp,
  t3rplf,
  kt8d5,
  '14t': Face14t,
  '15t': Face15t,
  '52t': Face52t,
};
