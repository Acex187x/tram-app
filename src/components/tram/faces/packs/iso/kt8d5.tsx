// Tatra KT8D5 — the big boxy long one: THREE sections joined by two
// full-height dark accordion articulations. Angular slab front with a wide,
// slightly-raked windscreen sunk in a DARK GREY mask under a white roof cap,
// two round headlights low in the red apron over a WHITE bumper stripe.
// Livery bands: grey window band / red belt / white skirt. Twin yellow
// DIAMOND pantographs and an amber route box perched on the roofline.
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { type Box, diamond, diamondBar, F, fQuad, ground, ISO, P, poly, R, S, sQuad, rQuad, VB } from './lib';

const b: Box = { cx: 30, cy: 78, w: 25, l: 54, h: 26 };
const f = (u: number, v: number) => P(F(b, u, v));
const s = (u: number, v: number) => P(S(b, u, v));

// Sharp slab box — tiny chamfer at the roof corners only.
const FRONT_BODY = `M${f(0, 0.06)} L${f(1, 0.06)} L${f(1, 0.94)} L${f(0.93, 1)} L${f(0.07, 1)} L${f(0, 0.94)} Z`;
const SIDE_BODY = `M${s(0, 0.06)} L${s(1, 0.06)} L${s(1, 0.94)} L${s(0.985, 1)} L${s(0, 1)} Z`;

const GREY_BAND = '#63666C';
const MASK = '#3E4147';

const panto1 = R(b, 0.5, 0.13);
const panto2 = R(b, 0.5, 0.8);

/** Full-height dark accordion articulation with pleat lines. */
function Accordion({ u }: { u: number }) {
  const du = 0.052;
  return (
    <>
      <Path d={sQuad(b, u, 0.07, u + du, 0.97)} fill={ISO.under} />
      <Line x1={S(b, u + du * 0.33, 0.09)[0]} y1={S(b, u + du * 0.33, 0.09)[1]} x2={S(b, u + du * 0.33, 0.95)[0]} y2={S(b, u + du * 0.33, 0.95)[1]} stroke={ISO.outline} strokeWidth={0.7} />
      <Line x1={S(b, u + du * 0.66, 0.09)[0]} y1={S(b, u + du * 0.66, 0.09)[1]} x2={S(b, u + du * 0.66, 0.95)[0]} y2={S(b, u + du * 0.66, 0.95)[1]} stroke={ISO.outline} strokeWidth={0.7} />
    </>
  );
}

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* ground shadow */}
      <Path d={ground(b)} fill={ISO.shadow} stroke={ISO.shadow} strokeWidth={4} strokeLinejoin="round" opacity={0.16} />
      {/* underframe + three visible bogies */}
      <Path d={fQuad(b, 0.03, -0.04, 0.97, 0.07)} fill={ISO.under} />
      <Path d={sQuad(b, 0, -0.04, 0.99, 0.07)} fill={ISO.under} />
      <Path d={sQuad(b, 0.06, -0.09, 0.17, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.45, -0.09, 0.56, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.84, -0.09, 0.95, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      {/* long flat roof with equipment boxes */}
      <Path d={rQuad(b, 0, 0, 1, 1)} fill="#E8E5DC" stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={rQuad(b, 0.3, 0.3, 0.72, 0.46)} fill={ISO.charcoal} stroke={ISO.under} strokeWidth={0.8} />
      <Path d={rQuad(b, 0.3, 0.56, 0.72, 0.7)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} />
      {/* amber route box perched on the front roofline */}
      <Path d={rQuad(b, 0.36, 0.015, 0.66, 0.095)} fill={ISO.amber} stroke={ISO.outline} strokeWidth={0.9} strokeLinejoin="round" />
      {/* TWIN yellow diamond pantographs — the two-headed giant */}
      <Path d={diamond(panto1)} stroke={ISO.pantoY} strokeWidth={1.4} strokeLinejoin="round" fill="none" />
      <Path d={diamondBar(panto1)} stroke={ISO.charcoal} strokeWidth={1.6} strokeLinecap="round" fill="none" />
      <Path d={diamond(panto2, 5.2, 4.4, 9.5)} stroke={ISO.pantoY} strokeWidth={1.4} strokeLinejoin="round" fill="none" />
      <Path d={diamondBar(panto2, 9.5)} stroke={ISO.charcoal} strokeWidth={1.6} strokeLinecap="round" fill="none" />
      {/* side: white skirt / red belt / grey window band / white roofline */}
      <Path d={SIDE_BODY} fill={ISO.whiteSide} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0, 0.2, 1, 0.52)} fill={ISO.redSide} />
      <Path d={sQuad(b, 0, 0.52, 1, 0.88)} fill={GREY_BAND} />
      {/* section 1: door + windows */}
      <Path d={sQuad(b, 0.045, 0.14, 0.115, 0.82)} fill={ISO.glassDoor} />
      <Path d={sQuad(b, 0.145, 0.56, 0.27, 0.82)} fill={ISO.glassSide} />
      {/* accordion articulation 1 */}
      <Accordion u={0.305} />
      {/* section 2: window – door – window */}
      <Path d={sQuad(b, 0.385, 0.56, 0.45, 0.82)} fill={ISO.glassSide} />
      <Path d={sQuad(b, 0.475, 0.14, 0.545, 0.82)} fill={ISO.glassDoor} />
      <Path d={sQuad(b, 0.57, 0.56, 0.635, 0.82)} fill={ISO.glassSide} />
      {/* accordion articulation 2 */}
      <Accordion u={0.665} />
      {/* section 3: windows + door, second cab hinted at the far end */}
      <Path d={sQuad(b, 0.745, 0.56, 0.85, 0.82)} fill={ISO.glassSide} />
      <Path d={sQuad(b, 0.875, 0.14, 0.94, 0.82)} fill={ISO.glassDoor} />
      <Path d={sQuad(b, 0.96, 0.56, 0.995, 0.84)} fill={ISO.glassSide} />
      {/* front face: boxy slab */}
      <Path d={FRONT_BODY} fill={ISO.white} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      {/* red apron + white bumper stripe below */}
      <Path d={fQuad(b, 0, 0.2, 1, 0.52)} fill={ISO.red} />
      {/* DARK GREY mask holding the wide, slightly-raked windscreen */}
      <Path d={fQuad(b, 0.03, 0.52, 0.97, 0.9)} fill={MASK} />
      <Path d={fQuad(b, 0.08, 0.56, 0.92, 0.85)} fill={ISO.glass} />
      <Line x1={F(b, 0.5, 0.56)[0]} y1={F(b, 0.5, 0.56)[1]} x2={F(b, 0.5, 0.85)[0]} y2={F(b, 0.5, 0.85)[1]} stroke={MASK} strokeWidth={1.2} />
      <Path d={poly(F(b, 0.6, 0.56), F(b, 0.74, 0.56), F(b, 0.56, 0.85), F(b, 0.44, 0.85))} fill={ISO.glint} opacity={0.26} />
      <Circle cx={F(b, 0.82, 0.79)[0]} cy={F(b, 0.82, 0.79)[1]} r={1.1} fill={ISO.glint} opacity={0.85} />
      {/* destination LED strip in the mask above the glass */}
      <Path d={fQuad(b, 0.28, 0.862, 0.72, 0.892)} fill={ISO.ledOrange} opacity={0.9} />
      {/* white roof cap band above the mask */}
      <Path d={fQuad(b, 0, 0.9, 1, 1)} fill={ISO.white} opacity={0.001} />
      {/* two round headlights low in the red, small amber signals beneath */}
      <Circle cx={F(b, 0.16, 0.33)[0]} cy={F(b, 0.16, 0.33)[1]} r={2.6} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.2} />
      <Circle cx={F(b, 0.84, 0.33)[0]} cy={F(b, 0.84, 0.33)[1]} r={2.6} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.2} />
      <Circle cx={F(b, 0.18, 0.37)[0]} cy={F(b, 0.18, 0.37)[1]} r={0.8} fill="#FFFFFF" opacity={0.9} />
      <Circle cx={F(b, 0.86, 0.37)[0]} cy={F(b, 0.86, 0.37)[1]} r={0.8} fill="#FFFFFF" opacity={0.9} />
      <Circle cx={F(b, 0.16, 0.24)[0]} cy={F(b, 0.16, 0.24)[1]} r={1.2} fill={ISO.amber} />
      <Circle cx={F(b, 0.84, 0.24)[0]} cy={F(b, 0.84, 0.24)[1]} r={1.2} fill={ISO.amber} />
      {/* slab bumper line on the white stripe */}
      <Path d={fQuad(b, 0.04, 0.07, 0.96, 0.1)} fill={ISO.charcoal} />
    </Svg>
  );
}
