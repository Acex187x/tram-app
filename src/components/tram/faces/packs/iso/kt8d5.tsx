// Tatra KT8D5 — the big articulated three-section car (ref 9048). THE SHAPE:
// a long faceted box — boxiness is correct here — but NOT a cube: the wide
// windscreen is visibly RAKED backwards, a chamfered white fascia strip leans
// from the windscreen top onto the flat roof, and the far cab mirrors the
// same slant (both ends are cabs). Dark grey mask wraps the whole cab
// glazing, red belt under the windows along the entire train, white skirt,
// two round headlights, TWO accordion articulations, TWIN diamond pantographs.
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { diamond, diamondBar, F, fQuad, ISO, isoBox, LONG_W, N3, P, poly, S, sQuad, VB } from './lib';
import { Stage } from './stage';

const b = isoBox(LONG_W);
const f = (u: number, v: number) => P(F(b, u, v));
const np = (a: number, d: number, z: number) => P(N3(b, a, d, z));

// Nose profile: vertical to the windscreen base (z 0.5), RAKE 4.2px back to
// the fascia line (z 0.94), then a straight chamfer to the roof 6.5px back.
const noseD = (z: number): number => (z <= 0.5 ? 0 : (4.2 * (z - 0.5)) / 0.44);
const KP = (a: number, z: number) => N3(b, a, noseD(z), z);
const kp = (a: number, z: number) => P(KP(a, z));

// Rear cab mirrors the slant: vertical to z 0.5 at 37.6px, raked to 33.8px.
const rearD = (z: number): number => 37.6 - (z <= 0.5 ? 0 : (4.2 * (z - 0.5)) / 0.44);

const FRONT_BODY = `M${np(0, 0, 0.07)} L${np(1, 0, 0.07)} L${np(1, 0, 0.5)} L${np(1, 4.2, 0.94)} L${np(0.9, 6.5, 1)} L${np(0.1, 6.5, 1)} L${np(0, 4.2, 0.94)} L${np(0, 0, 0.5)} Z`;
// Chamfered white fascia between windscreen top and roof.
const FASCIA = `M${np(0, 4.2, 0.94)} L${np(1, 4.2, 0.94)} L${np(0.9, 6.5, 1)} L${np(0.1, 6.5, 1)} Z`;
const SIDE_BODY = `M${np(0, 0, 0.07)} L${np(0, 37.6, 0.07)} L${np(0, 37.6, 0.5)} L${np(0, 33.6, 0.94)} L${np(0, 31.3, 1)} L${np(0, 6.5, 1)} L${np(0, 4.2, 0.94)} L${np(0, 0, 0.5)} Z`;
const ROOF = `M${np(0, 6.5, 1)} L${np(1, 6.5, 1)} L${np(1, 31.3, 1)} L${np(0, 31.3, 1)} Z`;

const MASK = '#4A4E55';
const MASK_SIDE = '#3B3F45';

const panto1 = N3(b, 0.5, 9, 1);
const panto2 = N3(b, 0.5, 29, 1);

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
      <Path d={ROOF} fill="#E8E5DC" stroke={ISO.outline} strokeWidth={1.1} strokeLinejoin="round" />
      <Path d={poly(N3(b, 0.28, 13, 1), N3(b, 0.74, 13, 1), N3(b, 0.74, 18, 1), N3(b, 0.28, 18, 1))} fill={ISO.charcoal} stroke={ISO.under} strokeWidth={0.8} />
      <Path d={poly(N3(b, 0.28, 21, 1), N3(b, 0.74, 21, 1), N3(b, 0.74, 25.5, 1), N3(b, 0.28, 25.5, 1))} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} />
      {/* amber route box perched over the fascia */}
      <Path d={poly(N3(b, 0.36, 7.2, 1.005), N3(b, 0.64, 7.2, 1.005), N3(b, 0.64, 7.2, 1.12), N3(b, 0.36, 7.2, 1.12))} fill={ISO.amber} stroke={ISO.outline} strokeWidth={0.9} strokeLinejoin="round" />
      {/* TWIN yellow diamond pantographs — the two-headed giant */}
      <Path d={diamond(panto1)} stroke={ISO.pantoY} strokeWidth={1.4} strokeLinejoin="round" fill="none" />
      <Path d={diamondBar(panto1)} stroke={ISO.charcoal} strokeWidth={1.6} strokeLinecap="round" fill="none" />
      <Path d={diamond(panto2, 5, 4.2, 9)} stroke={ISO.pantoY} strokeWidth={1.4} strokeLinejoin="round" fill="none" />
      <Path d={diamondBar(panto2, 9)} stroke={ISO.charcoal} strokeWidth={1.6} strokeLinecap="round" fill="none" />
      {/* flank: white body, red belt under the windows, white skirt */}
      <Path d={SIDE_BODY} fill={ISO.whiteSide} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0, 0.18, 0.99, 0.5)} fill={ISO.redSide} />
      {/* dark cab mask wraps around the front corner, following the rake */}
      <Path d={poly(N3(b, 0, 0.3, 0.52), N3(b, 0, 4.6, 0.52), N3(b, 0, 4.6, 0.9), N3(b, 0, 4, 0.9))} fill={MASK_SIDE} />
      <Path d={poly(N3(b, 0, 1, 0.56), N3(b, 0, 4.2, 0.56), N3(b, 0, 4.2, 0.87), N3(b, 0, 3.6, 0.87))} fill={ISO.glassSide} />
      {/* section 1: door + windows */}
      <Path d={sQuad(b, 0.125, 0.14, 0.185, 0.86)} fill={ISO.glassDoor} />
      <Path d={sQuad(b, 0.215, 0.54, 0.28, 0.86)} fill={ISO.glassSide} />
      <Accordion u={0.305} />
      {/* section 2: window – door – window */}
      <Path d={sQuad(b, 0.375, 0.54, 0.44, 0.86)} fill={ISO.glassSide} />
      <Path d={sQuad(b, 0.47, 0.14, 0.53, 0.86)} fill={ISO.glassDoor} />
      <Path d={sQuad(b, 0.56, 0.54, 0.625, 0.86)} fill={ISO.glassSide} />
      <Accordion u={0.65} />
      {/* section 3: windows + door, mirrored cab mask at the far raked end */}
      <Path d={sQuad(b, 0.72, 0.54, 0.785, 0.86)} fill={ISO.glassSide} />
      <Path d={sQuad(b, 0.815, 0.14, 0.875, 0.86)} fill={ISO.glassDoor} />
      <Path d={poly(N3(b, 0, 33.4, 0.54), N3(b, 0, rearD(0.54), 0.54), N3(b, 0, rearD(0.9), 0.9), N3(b, 0, 33.4, 0.9))} fill={MASK_SIDE} />
      {/* front: raked slab */}
      <Path d={FRONT_BODY} fill={ISO.white} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      {/* red apron (vertical zone below the glass) */}
      <Path d={fQuad(b, 0, 0.18, 1, 0.5)} fill={ISO.red} />
      {/* DARK GREY mask holding the wide RAKED windscreen */}
      <Path d={`M${kp(0.02, 0.5)} L${kp(0.98, 0.5)} L${kp(0.98, 0.92)} L${kp(0.02, 0.92)} Z`} fill={MASK} />
      <Path d={`M${kp(0.09, 0.54)} L${kp(0.91, 0.54)} L${kp(0.91, 0.86)} L${kp(0.09, 0.86)} Z`} fill={ISO.glass} />
      <Line x1={KP(0.5, 0.54)[0]} y1={KP(0.5, 0.54)[1]} x2={KP(0.5, 0.86)[0]} y2={KP(0.5, 0.86)[1]} stroke={MASK} strokeWidth={1.2} />
      <Path d={poly(KP(0.58, 0.55), KP(0.72, 0.55), KP(0.52, 0.85), KP(0.4, 0.85))} fill={ISO.glint} opacity={0.26} />
      <Circle cx={KP(0.8, 0.79)[0]} cy={KP(0.8, 0.79)[1]} r={1} fill={ISO.glint} opacity={0.85} />
      {/* white destination window at the top of the mask */}
      <Path d={poly(KP(0.26, 0.87), KP(0.74, 0.87), KP(0.74, 0.915), KP(0.26, 0.915))} fill="#FDFBF4" opacity={0.95} />
      {/* chamfered white fascia leaning onto the roof */}
      <Path d={FASCIA} fill="#F4F1E8" stroke={ISO.outline} strokeWidth={0.9} strokeLinejoin="round" />
      {/* two round headlights in the red + dark bumper line on the skirt */}
      <Circle cx={F(b, 0.2, 0.31)[0]} cy={F(b, 0.2, 0.31)[1]} r={2.6} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.2} />
      <Circle cx={F(b, 0.8, 0.31)[0]} cy={F(b, 0.8, 0.31)[1]} r={2.6} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.2} />
      <Circle cx={F(b, 0.23, 0.35)[0]} cy={F(b, 0.23, 0.35)[1]} r={0.8} fill="#FFFFFF" opacity={0.9} />
      <Circle cx={F(b, 0.83, 0.35)[0]} cy={F(b, 0.83, 0.35)[1]} r={0.8} fill="#FFFFFF" opacity={0.9} />
      <Path d={fQuad(b, 0.05, 0.08, 0.95, 0.12)} fill={ISO.charcoal} />
    </Svg>
  );
}
