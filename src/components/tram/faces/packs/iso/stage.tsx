// Shared ground every iso face stands on: NOTHING but a very soft contact
// shadow — the background is fully transparent (no tile, no plate). Rendering
// it from one place keeps the shadow softness identical across all 7 models.
import { Path } from 'react-native-svg';

import { type Box, ground, ISO } from './lib';

export function Stage({ b }: { b: Box }) {
  return (
    <>
      {/* whisper-soft contact shadow: wide faint halo + slightly tighter core */}
      <Path
        d={ground(b)}
        fill={ISO.shadow}
        stroke={ISO.shadow}
        strokeWidth={8}
        strokeLinejoin="round"
        opacity={0.05}
      />
      <Path
        d={ground(b)}
        fill={ISO.shadow}
        stroke={ISO.shadow}
        strokeWidth={2.5}
        strokeLinejoin="round"
        opacity={0.08}
      />
    </>
  );
}
