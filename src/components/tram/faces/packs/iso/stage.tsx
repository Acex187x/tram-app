// Shared stage every iso face stands on: the light neutral backdrop tile and
// the soft two-layer ground shadow. Rendering it from one place keeps the
// "coin" identical across all 7 models — same tile, same shadow softness.
import { Path, Rect } from 'react-native-svg';

import { type Box, ground, ISO, TILE } from './lib';

export function Stage({ b }: { b: Box }) {
  return (
    <>
      {/* light neutral backdrop tile */}
      <Rect
        x={TILE.x}
        y={TILE.y}
        width={TILE.size}
        height={TILE.size}
        rx={TILE.r}
        fill={ISO.bg}
        stroke={ISO.bgEdge}
        strokeWidth={1.5}
      />
      {/* soft ground shadow: wide faint halo + tighter core */}
      <Path
        d={ground(b)}
        fill={ISO.shadow}
        stroke={ISO.shadow}
        strokeWidth={9}
        strokeLinejoin="round"
        opacity={0.07}
      />
      <Path
        d={ground(b)}
        fill={ISO.shadow}
        stroke={ISO.shadow}
        strokeWidth={3}
        strokeLinejoin="round"
        opacity={0.12}
      />
    </>
  );
}
