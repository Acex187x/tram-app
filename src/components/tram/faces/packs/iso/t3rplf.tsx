// Tatra T3R.PLF — the champagne-silver T3 (ref 8269): same rounded bun, but a
// SILVER shell with a dark-wine graphic package. One smooth SINGLE curved
// windscreen (no divider), a MAROON cap band ringing the roof edge, an orange
// LED header, and a red bib low on the nose made of two rounded lobes holding
// the round chrome headlights, split by a silver center wedge. The flank
// carries angled wine swoosh graphics and a WIDE low-floor center door.
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { diamond, diamondBar, F, fQuad, ISO, isoBox, P, poly, R, rQuad, S, SHORT_W, sQuad, VB } from './lib';
import { Stage } from './stage';

const b = isoBox(SHORT_W);
const f = (u: number, v: number) => P(F(b, u, v));
const s = (u: number, v: number) => P(S(b, u, v));

const FRONT_BODY = `M${f(0, 0.07)} L${f(1, 0.07)} L${f(1, 0.72)} Q${f(1, 1.035)} ${f(0.64, 1.015)} L${f(0.36, 1.015)} Q${f(0, 1.035)} ${f(0, 0.72)} Z`;
const SIDE_BODY = `M${s(0, 0.07)} L${s(0.93, 0.07)} Q${s(1.05, 0.52)} ${s(0.9, 1)} L${s(0, 1)} Z`;
// ONE smooth curved pane — no center divider.
const WINDSCREEN = `M${f(0.08, 0.49)} L${f(0.92, 0.49)} L${f(0.92, 0.73)} Q${f(0.92, 0.88)} ${f(0.77, 0.88)} L${f(0.23, 0.88)} Q${f(0.08, 0.88)} ${f(0.08, 0.73)} Z`;
// Red bib: two rounded lobes hanging low on the nose, lifted at the center.
const BIB = `M${f(0.02, 0.4)} L${f(0.98, 0.4)} L${f(0.98, 0.28)} Q${f(0.93, 0.1)} ${f(0.76, 0.11)} Q${f(0.55, 0.13)} ${f(0.5, 0.3)} Q${f(0.45, 0.13)} ${f(0.24, 0.11)} Q${f(0.07, 0.1)} ${f(0.02, 0.28)} Z`;
// Thin maroon cap band ringing the roof edge.
const CAP = `M${f(0, 0.96)} L${f(1, 0.96)} Q${f(1, 1.035)} ${f(0.64, 1.015)} L${f(0.36, 1.015)} Q${f(0, 1.035)} ${f(0, 0.96)} Z`;
// Silver slashes cutting through the wine flank band toward the rear.
const SLASH1 = poly(S(b, 0.58, 0.22), S(b, 0.64, 0.22), S(b, 0.72, 0.54), S(b, 0.66, 0.54));
const SLASH2 = poly(S(b, 0.7, 0.22), S(b, 0.76, 0.22), S(b, 0.84, 0.54), S(b, 0.78, 0.54));

const pantoM = R(b, 0.5, 0.5);

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      <Stage b={b} />
      {/* underframe + end bogies (the center rides low) */}
      <Path d={fQuad(b, 0.03, -0.03, 0.97, 0.08)} fill={ISO.under} />
      <Path d={sQuad(b, 0, -0.03, 0.93, 0.08)} fill={ISO.under} />
      <Path d={sQuad(b, 0.09, -0.08, 0.26, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.7, -0.08, 0.87, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      {/* smooth silver roof + boxy AC unit up front */}
      <Path d={rQuad(b, 0, 0, 1, 1)} fill={ISO.silverRoof} stroke={ISO.outline} strokeWidth={1.1} strokeLinejoin="round" />
      <Path d={rQuad(b, 0.2, 0.08, 0.8, 0.3)} fill="#CFCBBF" stroke={ISO.silverSide} strokeWidth={0.9} strokeLinejoin="round" />
      {/* yellow DIAMOND scissor pantograph */}
      <Path d={diamond(pantoM)} stroke={ISO.pantoY} strokeWidth={1.4} strokeLinejoin="round" fill="none" />
      <Path d={diamondBar(pantoM)} stroke={ISO.charcoal} strokeWidth={1.6} strokeLinecap="round" fill="none" />
      {/* flank: champagne-silver shell + wine belt and swooshes */}
      <Path d={SIDE_BODY} fill={ISO.silverSide} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0, 0.22, 0.94, 0.54)} fill={ISO.wineSide} />
      <Path d={SLASH1} fill={ISO.silverSide} />
      <Path d={SLASH2} fill={ISO.silverSide} />
      {/* front door – window – WIDE low-floor center door – window – rear door */}
      <Path d={sQuad(b, 0.055, 0.14, 0.16, 0.86)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.2, 0.54, 0.35, 0.86)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.1} strokeLinejoin="round" />
      {/* the LOW-FLOOR plug door: glass drops well below the belt line */}
      <Path d={sQuad(b, 0.4, 0.06, 0.56, 0.86)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.2} strokeLinejoin="round" />
      <Line x1={S(b, 0.48, 0.07)[0]} y1={S(b, 0.48, 0.07)[1]} x2={S(b, 0.48, 0.85)[0]} y2={S(b, 0.48, 0.85)[1]} stroke={ISO.glassSide} strokeWidth={0.8} />
      <Path d={sQuad(b, 0.61, 0.54, 0.76, 0.86)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.1} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.8, 0.14, 0.9, 0.86)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.2} strokeLinejoin="round" />
      {/* front — silver bun */}
      <Path d={FRONT_BODY} fill={ISO.silver} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      {/* red bib lobes + silver center wedge */}
      <Path d={BIB} fill={ISO.wine} />
      {/* smooth SINGLE curved windscreen + corner spill onto the side */}
      <Path d={sQuad(b, 0.015, 0.51, 0.08, 0.87)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.1} strokeLinejoin="round" />
      <Path d={WINDSCREEN} fill={ISO.glass} stroke={ISO.glass} strokeWidth={1.4} strokeLinejoin="round" />
      <Path d={poly(F(b, 0.58, 0.5), F(b, 0.72, 0.5), F(b, 0.5, 0.87), F(b, 0.38, 0.87))} fill={ISO.glint} opacity={0.28} />
      <Circle cx={F(b, 0.8, 0.8)[0]} cy={F(b, 0.8, 0.8)[1]} r={1.1} fill={ISO.glint} opacity={0.85} />
      {/* slim orange LED header on the silver brow, under a thin maroon cap */}
      <Path d={fQuad(b, 0.2, 0.895, 0.8, 0.955)} fill={ISO.charcoal} strokeLinejoin="round" />
      <Path d={fQuad(b, 0.23, 0.912, 0.34, 0.94)} fill={ISO.ledOrange} opacity={0.95} />
      <Path d={fQuad(b, 0.4, 0.912, 0.77, 0.94)} fill={ISO.ledOrange} opacity={0.85} />
      <Path d={CAP} fill={ISO.wine} stroke={ISO.wineSide} strokeWidth={0.7} strokeLinejoin="round" />
      {/* round chrome headlights nested in the red lobes */}
      <Circle cx={F(b, 0.25, 0.25)[0]} cy={F(b, 0.25, 0.25)[1]} r={2.9} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.4} />
      <Circle cx={F(b, 0.75, 0.25)[0]} cy={F(b, 0.75, 0.25)[1]} r={2.9} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.4} />
      <Circle cx={F(b, 0.28, 0.29)[0]} cy={F(b, 0.28, 0.29)[1]} r={0.9} fill="#FFFFFF" opacity={0.9} />
      <Circle cx={F(b, 0.78, 0.29)[0]} cy={F(b, 0.78, 0.29)[1]} r={0.9} fill="#FFFFFF" opacity={0.9} />
      {/* silver skirt lip */}
      <Path d={`M${f(0.07, 0.09)} Q${f(0.5, 0.02)} ${f(0.93, 0.09)}`} stroke={ISO.chrome} strokeWidth={1.6} strokeLinecap="round" fill="none" />
    </Svg>
  );
}
