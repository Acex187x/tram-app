// Tatra KT8D5.RN2P — the angular one, and the fleet's only two-headed tram.
// Tells: boxy flat trapezoid front with NO curves, big windscreen split by a
// CENTER PILLAR, paired rectangular headlights + small round halogens, the
// signature CURVED WHITE STRIPE sweeping across the red front, full-width
// destination LED. Side: three-section ~30 m giant with two accordion
// articulations, modernized low-floor CENTER section (lower window/door line),
// and a second cab hinted at the far end. Red with white/cream upper band.
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { type Box, F, fQuad, ground, ISO, P, poly, R, S, sQuad, rQuad, VB } from './lib';

const b: Box = { cx: 32, cy: 78, w: 26, l: 50, h: 27 };
const f = (u: number, v: number) => P(F(b, u, v));
const s = (u: number, v: number) => P(S(b, u, v));

// Sharp, slab-sided box — only a small chamfer at the roof corners.
const FRONT_BODY = `M${f(0, 0.06)} L${f(1, 0.06)} L${f(1, 0.93)} L${f(0.94, 1)} L${f(0.06, 1)} L${f(0, 0.93)} Z`;
const SIDE_BODY = `M${s(0, 0.06)} L${s(1, 0.06)} L${s(1, 0.93)} L${s(0.97, 1)} L${s(0, 1)} Z`;
// Sweeping white stripe across the red front (rises toward the far edge).
const STRIPE = `M${f(0, 0.26)} C${f(0.35, 0.34)} ${f(0.65, 0.42)} ${f(1, 0.42)} L${f(1, 0.32)} C${f(0.65, 0.32)} ${f(0.35, 0.24)} ${f(0, 0.16)} Z`;

// Single-arm pantograph over the front section.
const p0 = R(b, 0.5, 0.17);
const knee = [p0[0] - 1.2, p0[1] - 5.8] as const;
const head = [knee[0] + 4.6, knee[1] - 2.4] as const;
const PANTO = `M${P(p0)} L${knee[0]} ${knee[1]} L${head[0]} ${head[1]}`;
const PANTO_BAR = `M${head[0] - 2.8} ${head[1] + 1.4} L${head[0] + 2.8} ${head[1] - 1.4}`;

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* ground shadow */}
      <Path d={ground(b)} fill={ISO.shadow} stroke={ISO.shadow} strokeWidth={4} strokeLinejoin="round" opacity={0.16} />
      {/* underframe + end bogies */}
      <Path d={fQuad(b, 0.03, -0.04, 0.97, 0.07)} fill={ISO.under} />
      <Path d={sQuad(b, 0, -0.04, 0.98, 0.07)} fill={ISO.under} />
      <Path d={sQuad(b, 0.07, -0.09, 0.2, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.44, -0.09, 0.56, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.8, -0.09, 0.93, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      {/* roof with resistor/equipment boxes */}
      <Path d={rQuad(b, 0, 0, 1, 1)} fill={ISO.creamRoof} stroke={ISO.outline} strokeWidth={1.2} />
      <Path d={rQuad(b, 0.28, 0.36, 0.74, 0.6)} fill={ISO.charcoal} stroke={ISO.under} strokeWidth={0.8} />
      <Path d={rQuad(b, 0.3, 0.72, 0.72, 0.9)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} />
      <Path d={PANTO} stroke={ISO.charcoal} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d={PANTO_BAR} stroke={ISO.charcoal} strokeWidth={1.7} strokeLinecap="round" fill="none" />
      {/* side: red slab with cream window band */}
      <Path d={SIDE_BODY} fill={ISO.redSide} stroke={ISO.outline} strokeWidth={1.2} />
      <Path d={sQuad(b, 0, 0.5, 1, 1)} fill={ISO.creamSide} />
      <Path d={sQuad(b, 0, 0.47, 1, 0.51)} fill={ISO.maroon} opacity={0.5} />
      {/* section 1: door + windows */}
      <Path d={sQuad(b, 0.05, 0.12, 0.13, 0.8)} fill={ISO.glassDoor} />
      <Path d={sQuad(b, 0.16, 0.52, 0.27, 0.8)} fill={ISO.glassSide} />
      {/* accordion articulation 1 */}
      <Path d={sQuad(b, 0.3, 0.06, 0.345, 0.97)} fill={ISO.under} />
      <Line x1={S(b, 0.315, 0.08)[0]} y1={S(b, 0.315, 0.08)[1]} x2={S(b, 0.315, 0.95)[0]} y2={S(b, 0.315, 0.95)[1]} stroke={ISO.outline} strokeWidth={0.7} />
      <Line x1={S(b, 0.33, 0.08)[0]} y1={S(b, 0.33, 0.08)[1]} x2={S(b, 0.33, 0.95)[0]} y2={S(b, 0.33, 0.95)[1]} stroke={ISO.outline} strokeWidth={0.7} />
      {/* section 2 (modernized LOW-FLOOR center): lower door + deeper windows */}
      <Path d={sQuad(b, 0.375, 0.44, 0.44, 0.78)} fill={ISO.glassSide} />
      <Path d={sQuad(b, 0.46, 0.04, 0.56, 0.78)} fill={ISO.glassDoor} />
      <Line x1={S(b, 0.51, 0.05)[0]} y1={S(b, 0.51, 0.05)[1]} x2={S(b, 0.51, 0.77)[0]} y2={S(b, 0.51, 0.77)[1]} stroke={ISO.glassSide} strokeWidth={0.8} />
      <Path d={sQuad(b, 0.58, 0.44, 0.625, 0.78)} fill={ISO.glassSide} />
      {/* accordion articulation 2 */}
      <Path d={sQuad(b, 0.655, 0.06, 0.7, 0.97)} fill={ISO.under} />
      <Line x1={S(b, 0.67, 0.08)[0]} y1={S(b, 0.67, 0.08)[1]} x2={S(b, 0.67, 0.95)[0]} y2={S(b, 0.67, 0.95)[1]} stroke={ISO.outline} strokeWidth={0.7} />
      <Line x1={S(b, 0.685, 0.08)[0]} y1={S(b, 0.685, 0.08)[1]} x2={S(b, 0.685, 0.95)[0]} y2={S(b, 0.685, 0.95)[1]} stroke={ISO.outline} strokeWidth={0.7} />
      {/* section 3: windows + door, then the SECOND CAB at the far end */}
      <Path d={sQuad(b, 0.73, 0.52, 0.83, 0.8)} fill={ISO.glassSide} />
      <Path d={sQuad(b, 0.855, 0.12, 0.93, 0.8)} fill={ISO.glassDoor} />
      <Path d={sQuad(b, 0.955, 0.5, 0.995, 0.84)} fill={ISO.glassSide} />
      {/* front face: red slab, sweeping white stripe */}
      <Path d={FRONT_BODY} fill={ISO.red} stroke={ISO.outline} strokeWidth={1.2} />
      <Path d={STRIPE} fill={ISO.white} />
      {/* flat windscreen with CENTER PILLAR */}
      <Path d={fQuad(b, 0.06, 0.52, 0.94, 0.88)} fill={ISO.glass} />
      <Line x1={F(b, 0.5, 0.52)[0]} y1={F(b, 0.5, 0.52)[1]} x2={F(b, 0.5, 0.88)[0]} y2={F(b, 0.5, 0.88)[1]} stroke={ISO.charcoal} strokeWidth={1.6} />
      <Path d={poly(F(b, 0.62, 0.52), F(b, 0.76, 0.52), F(b, 0.56, 0.88), F(b, 0.44, 0.88))} fill={ISO.glint} opacity={0.26} />
      <Circle cx={F(b, 0.82, 0.8)[0]} cy={F(b, 0.82, 0.8)[1]} r={1.1} fill={ISO.glint} opacity={0.85} />
      {/* full-width destination LED */}
      <Path d={fQuad(b, 0.07, 0.9, 0.93, 0.985)} fill={ISO.charcoal} />
      <Path d={fQuad(b, 0.13, 0.922, 0.22, 0.962)} fill={ISO.amber} opacity={0.95} />
      <Path d={fQuad(b, 0.28, 0.922, 0.66, 0.962)} fill={ISO.amber} opacity={0.95} />
      {/* paired rectangular headlights + round halogen reflectors */}
      <Path d={fQuad(b, 0.08, 0.14, 0.22, 0.215)} fill={ISO.warm} stroke={ISO.charcoal} strokeWidth={0.8} />
      <Path d={fQuad(b, 0.78, 0.14, 0.92, 0.215)} fill={ISO.warm} stroke={ISO.charcoal} strokeWidth={0.8} />
      <Circle cx={F(b, 0.32, 0.18)[0]} cy={F(b, 0.32, 0.18)[1]} r={1.7} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={0.9} />
      <Circle cx={F(b, 0.68, 0.18)[0]} cy={F(b, 0.68, 0.18)[1]} r={1.7} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={0.9} />
      {/* slab bumper */}
      <Path d={fQuad(b, 0.04, 0.07, 0.96, 0.105)} fill={ISO.charcoal} />
    </Svg>
  );
}
