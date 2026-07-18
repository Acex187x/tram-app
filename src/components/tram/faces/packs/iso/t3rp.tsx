// Tatra T3R.P — the modernized classic: identical T3 bun silhouette and
// cream/red livery, but the brow carries a dark full-width box with an ORANGE
// LED destination strip (instead of the little blue route box), rectangular
// AMBER turn signals flank the round headlights, and the red belt drops all
// the way down the skirt (thin dark trim at the very bottom). Diamond panto.
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { type Box, diamond, diamondBar, F, fQuad, ground, ISO, P, poly, R, S, sQuad, rQuad, VB } from './lib';

const b: Box = { cx: 34, cy: 78, w: 26, l: 36, h: 28 };
const f = (u: number, v: number) => P(F(b, u, v));
const s = (u: number, v: number) => P(S(b, u, v));

const SIDE_BODY = `M${s(0, 0.06)} L${s(0.94, 0.06)} Q${s(1.06, 0.5)} ${s(0.92, 1)} L${s(0, 1)} Z`;
const FRONT_BODY = `M${f(0, 0.06)} L${f(1, 0.06)} L${f(1, 0.68)} Q${f(1, 1.05)} ${f(0.7, 1.01)} L${f(0.3, 1.01)} Q${f(0, 1.05)} ${f(0, 0.68)} Z`;
const WINDSCREEN = `M${f(0.08, 0.52)} L${f(0.92, 0.52)} L${f(0.92, 0.76)} Q${f(0.92, 0.9)} ${f(0.75, 0.9)} L${f(0.25, 0.9)} Q${f(0.08, 0.9)} ${f(0.08, 0.76)} Z`;
// Deep red apron: red runs from just above the bumper lip to the windscreen.
const APRON = `M${f(0.02, 0.52)} L${f(0.98, 0.52)} L${f(0.98, 0.13)} Q${f(0.5, 0.07)} ${f(0.02, 0.13)} Z`;

const pantoM = R(b, 0.5, 0.45);

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* ground shadow */}
      <Path d={ground(b)} fill={ISO.shadow} stroke={ISO.shadow} strokeWidth={4} strokeLinejoin="round" opacity={0.16} />
      {/* underframe + two visible bogies */}
      <Path d={fQuad(b, 0.03, -0.04, 0.97, 0.07)} fill={ISO.under} />
      <Path d={sQuad(b, 0, -0.04, 0.95, 0.07)} fill={ISO.under} />
      <Path d={sQuad(b, 0.12, -0.09, 0.3, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.66, -0.09, 0.84, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      {/* grey canvas roof with ribs */}
      <Path d={rQuad(b, 0, 0, 1, 1)} fill="#C8C2B1" stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Line x1={R(b, 0.32, 0.08)[0]} y1={R(b, 0.32, 0.08)[1]} x2={R(b, 0.32, 0.92)[0]} y2={R(b, 0.32, 0.92)[1]} stroke="#B0A995" strokeWidth={0.9} />
      <Line x1={R(b, 0.56, 0.08)[0]} y1={R(b, 0.56, 0.08)[1]} x2={R(b, 0.56, 0.92)[0]} y2={R(b, 0.56, 0.92)[1]} stroke="#B0A995" strokeWidth={0.9} />
      <Line x1={R(b, 0.8, 0.08)[0]} y1={R(b, 0.8, 0.08)[1]} x2={R(b, 0.8, 0.92)[0]} y2={R(b, 0.8, 0.92)[1]} stroke="#B0A995" strokeWidth={0.9} />
      {/* yellow DIAMOND pantograph */}
      <Path d={diamond(pantoM)} stroke={ISO.pantoY} strokeWidth={1.4} strokeLinejoin="round" fill="none" />
      <Path d={diamondBar(pantoM)} stroke={ISO.charcoal} strokeWidth={1.6} strokeLinecap="round" fill="none" />
      {/* side: cream window band, DEEP red belt down the skirt, dark bottom trim */}
      <Path d={SIDE_BODY} fill={ISO.creamSide} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0, 0.06, 0.97, 0.52)} fill={ISO.redSide} />
      <Path d={sQuad(b, 0, 0.06, 0.97, 0.1)} fill={ISO.maroon} opacity={0.75} />
      <Path d={sQuad(b, 0, 0.5, 0.97, 0.53)} fill={ISO.maroon} opacity={0.55} />
      {/* side: door – window – window – door – window – door */}
      <Path d={sQuad(b, 0.08, 0.12, 0.2, 0.84)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.4} strokeLinejoin="round" />
      <Line x1={S(b, 0.14, 0.13)[0]} y1={S(b, 0.14, 0.13)[1]} x2={S(b, 0.14, 0.83)[0]} y2={S(b, 0.14, 0.83)[1]} stroke={ISO.glassSide} strokeWidth={0.8} />
      <Path d={sQuad(b, 0.24, 0.56, 0.34, 0.84)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.38, 0.56, 0.48, 0.84)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.52, 0.12, 0.64, 0.84)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.4} strokeLinejoin="round" />
      <Line x1={S(b, 0.58, 0.13)[0]} y1={S(b, 0.58, 0.13)[1]} x2={S(b, 0.58, 0.83)[0]} y2={S(b, 0.58, 0.83)[1]} stroke={ISO.glassSide} strokeWidth={0.8} />
      <Path d={sQuad(b, 0.68, 0.56, 0.78, 0.84)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.82, 0.12, 0.93, 0.84)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.4} strokeLinejoin="round" />
      {/* front face — same cream bun as the T3 */}
      <Path d={FRONT_BODY} fill={ISO.cream} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={APRON} fill={ISO.red} />
      <Path d={fQuad(b, 0.02, 0.09, 0.98, 0.13)} fill={ISO.maroon} opacity={0.7} />
      {/* wrap-around windscreen + corner spill onto the side */}
      <Path d={sQuad(b, 0.015, 0.54, 0.09, 0.88)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={WINDSCREEN} fill={ISO.glass} stroke={ISO.glass} strokeWidth={1.6} strokeLinejoin="round" />
      <Line x1={F(b, 0.5, 0.53)[0]} y1={F(b, 0.5, 0.53)[1]} x2={F(b, 0.5, 0.89)[0]} y2={F(b, 0.5, 0.89)[1]} stroke={ISO.cream} strokeWidth={1.1} />
      <Path d={poly(F(b, 0.6, 0.52), F(b, 0.74, 0.52), F(b, 0.52, 0.9), F(b, 0.4, 0.9))} fill={ISO.glint} opacity={0.28} />
      <Circle cx={F(b, 0.8, 0.82)[0]} cy={F(b, 0.8, 0.82)[1]} r={1.2} fill={ISO.glint} opacity={0.85} />
      {/* ORANGE LED destination strip in a dark brow box (the T3R.P tell) */}
      <Path d={fQuad(b, 0.1, 0.9, 0.9, 1)} fill="#23262B" stroke="#23262B" strokeWidth={1} strokeLinejoin="round" />
      <Path d={fQuad(b, 0.16, 0.925, 0.28, 0.975)} fill={ISO.ledOrange} />
      <Path d={fQuad(b, 0.34, 0.925, 0.84, 0.975)} fill={ISO.ledOrange} />
      {/* round chrome headlights + rectangular AMBER turn signals */}
      <Circle cx={F(b, 0.26, 0.3)[0]} cy={F(b, 0.26, 0.3)[1]} r={2.9} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.3} />
      <Circle cx={F(b, 0.74, 0.3)[0]} cy={F(b, 0.74, 0.3)[1]} r={2.9} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.3} />
      <Circle cx={F(b, 0.29, 0.34)[0]} cy={F(b, 0.29, 0.34)[1]} r={0.9} fill="#FFFFFF" opacity={0.9} />
      <Circle cx={F(b, 0.77, 0.34)[0]} cy={F(b, 0.77, 0.34)[1]} r={0.9} fill="#FFFFFF" opacity={0.9} />
      <Path d={fQuad(b, 0.055, 0.265, 0.145, 0.34)} fill={ISO.amber} stroke={ISO.maroon} strokeWidth={0.6} strokeLinejoin="round" />
      <Path d={fQuad(b, 0.855, 0.265, 0.945, 0.34)} fill={ISO.amber} stroke={ISO.maroon} strokeWidth={0.6} strokeLinejoin="round" />
      {/* bumper lip */}
      <Path d={`M${f(0.07, 0.08)} Q${f(0.5, 0.01)} ${f(0.93, 0.08)}`} stroke={ISO.charcoal} strokeWidth={1.6} strokeLinecap="round" fill="none" />
    </Svg>
  );
}
