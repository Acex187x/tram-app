// Tatra KT8D5 — the big boxy articulated three-section car (ref 9042/9048):
// slab-sided box with a DARK GREY mask wrapping the whole cab glazing (big
// slightly-raked windscreen + the corner cab windows) under a white roof cap,
// red belt band under the windows along the entire train, white skirt, two
// round headlights in the red over a dark bumper line, TWO full-height
// accordion articulations and TWIN yellow diamond pantographs.
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { diamond, diamondBar, F, fQuad, ISO, isoBox, LONG_W, P, poly, R, rQuad, S, sQuad, VB } from './lib';
import { Stage } from './stage';

const b = isoBox(LONG_W);
const f = (u: number, v: number) => P(F(b, u, v));
const s = (u: number, v: number) => P(S(b, u, v));

// Sharp slab box — tiny chamfer at the roof corners only.
const FRONT_BODY = `M${f(0, 0.07)} L${f(1, 0.07)} L${f(1, 0.93)} L${f(0.9, 1)} L${f(0.1, 1)} L${f(0, 0.93)} Z`;
const SIDE_BODY = `M${s(0, 0.07)} L${s(1, 0.07)} L${s(1, 0.96)} L${s(0.99, 1)} L${s(0, 1)} Z`;

const MASK = '#4A4E55';
const MASK_SIDE = '#3B3F45';

const panto1 = R(b, 0.5, 0.14);
const panto2 = R(b, 0.5, 0.82);

/** Full-height dark accordion articulation with pleat lines. */
function Accordion({ u }: { u: number }) {
  const du = 0.045;
  return (
    <>
      <Path d={sQuad(b, u, 0.08, u + du, 0.97)} fill={ISO.under} />
      {[0.33, 0.66].map((t) => (
        <Line
          key={t}
          x1={S(b, u + du * t, 0.1)[0]}
          y1={S(b, u + du * t, 0.1)[1]}
          x2={S(b, u + du * t, 0.95)[0]}
          y2={S(b, u + du * t, 0.95)[1]}
          stroke={ISO.outline}
          strokeWidth={0.7}
        />
      ))}
    </>
  );
}

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      <Stage b={b} />
      {/* underframe + three visible bogies */}
      <Path d={fQuad(b, 0.03, -0.03, 0.97, 0.08)} fill={ISO.under} />
      <Path d={sQuad(b, 0, -0.03, 0.99, 0.08)} fill={ISO.under} />
      <Path d={sQuad(b, 0.06, -0.08, 0.17, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.45, -0.08, 0.56, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.84, -0.08, 0.95, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      {/* long flat roof with equipment boxes */}
      <Path d={rQuad(b, 0, 0, 1, 1)} fill="#E8E5DC" stroke={ISO.outline} strokeWidth={1.1} strokeLinejoin="round" />
      <Path d={rQuad(b, 0.28, 0.3, 0.74, 0.44)} fill={ISO.charcoal} stroke={ISO.under} strokeWidth={0.8} />
      <Path d={rQuad(b, 0.28, 0.56, 0.74, 0.68)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} />
      {/* amber route box perched on the front roofline */}
      <Path d={rQuad(b, 0.32, 0.02, 0.68, 0.1)} fill={ISO.amber} stroke={ISO.outline} strokeWidth={0.9} strokeLinejoin="round" />
      {/* TWIN yellow diamond pantographs — the two-headed giant */}
      <Path d={diamond(panto1)} stroke={ISO.pantoY} strokeWidth={1.4} strokeLinejoin="round" fill="none" />
      <Path d={diamondBar(panto1)} stroke={ISO.charcoal} strokeWidth={1.6} strokeLinecap="round" fill="none" />
      <Path d={diamond(panto2, 5, 4.2, 9)} stroke={ISO.pantoY} strokeWidth={1.4} strokeLinejoin="round" fill="none" />
      <Path d={diamondBar(panto2, 9)} stroke={ISO.charcoal} strokeWidth={1.6} strokeLinecap="round" fill="none" />
      {/* flank: white body, red belt under the windows, white skirt */}
      <Path d={SIDE_BODY} fill={ISO.whiteSide} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0, 0.18, 1, 0.5)} fill={ISO.redSide} />
      {/* dark cab mask wraps around the front corner of the side */}
      <Path d={sQuad(b, 0, 0.5, 0.1, 0.96)} fill={MASK_SIDE} />
      <Path d={sQuad(b, 0.015, 0.56, 0.085, 0.9)} fill={ISO.glassSide} />
      {/* section 1: door + windows */}
      <Path d={sQuad(b, 0.125, 0.14, 0.185, 0.86)} fill={ISO.glassDoor} />
      <Path d={sQuad(b, 0.215, 0.54, 0.28, 0.86)} fill={ISO.glassSide} />
      <Accordion u={0.305} />
      {/* section 2: window – door – window */}
      <Path d={sQuad(b, 0.375, 0.54, 0.44, 0.86)} fill={ISO.glassSide} />
      <Path d={sQuad(b, 0.47, 0.14, 0.53, 0.86)} fill={ISO.glassDoor} />
      <Path d={sQuad(b, 0.56, 0.54, 0.625, 0.86)} fill={ISO.glassSide} />
      <Accordion u={0.65} />
      {/* section 3: windows + door, second cab hinted at the far end */}
      <Path d={sQuad(b, 0.72, 0.54, 0.785, 0.86)} fill={ISO.glassSide} />
      <Path d={sQuad(b, 0.815, 0.14, 0.875, 0.86)} fill={ISO.glassDoor} />
      <Path d={sQuad(b, 0.905, 0.54, 0.98, 0.9)} fill={MASK_SIDE} />
      {/* front: boxy slab */}
      <Path d={FRONT_BODY} fill={ISO.white} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      {/* red apron */}
      <Path d={fQuad(b, 0, 0.18, 1, 0.5)} fill={ISO.red} />
      {/* DARK GREY mask holding the wide, slightly-raked windscreen — a white
          roof-cap stripe stays visible above it */}
      <Path d={fQuad(b, 0.02, 0.5, 0.98, 0.92)} fill={MASK} />
      <Path d={fQuad(b, 0.09, 0.54, 0.91, 0.86)} fill={ISO.glass} />
      <Line x1={F(b, 0.5, 0.54)[0]} y1={F(b, 0.5, 0.54)[1]} x2={F(b, 0.5, 0.86)[0]} y2={F(b, 0.5, 0.86)[1]} stroke={MASK} strokeWidth={1.2} />
      <Path d={poly(F(b, 0.58, 0.55), F(b, 0.72, 0.55), F(b, 0.52, 0.85), F(b, 0.4, 0.85))} fill={ISO.glint} opacity={0.26} />
      <Circle cx={F(b, 0.8, 0.79)[0]} cy={F(b, 0.8, 0.79)[1]} r={1} fill={ISO.glint} opacity={0.85} />
      {/* white destination window at the top of the mask */}
      <Path d={fQuad(b, 0.24, 0.87, 0.76, 0.915)} fill="#FDFBF4" opacity={0.95} />
      {/* two round headlights in the red + amber signals above */}
      <Circle cx={F(b, 0.2, 0.31)[0]} cy={F(b, 0.2, 0.31)[1]} r={2.6} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.2} />
      <Circle cx={F(b, 0.8, 0.31)[0]} cy={F(b, 0.8, 0.31)[1]} r={2.6} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.2} />
      <Circle cx={F(b, 0.23, 0.35)[0]} cy={F(b, 0.23, 0.35)[1]} r={0.8} fill="#FFFFFF" opacity={0.9} />
      <Circle cx={F(b, 0.83, 0.35)[0]} cy={F(b, 0.83, 0.35)[1]} r={0.8} fill="#FFFFFF" opacity={0.9} />
      {/* dark bumper line on the white skirt */}
      <Path d={fQuad(b, 0.05, 0.08, 0.95, 0.12)} fill={ISO.charcoal} />
    </Svg>
  );
}
