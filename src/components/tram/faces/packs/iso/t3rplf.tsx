// Tatra T3R.PLF — the SILVER-bodied T3: same rounded bun, but champagne-silver
// shell, a smooth SINGLE curved windscreen (no center divider), a dark WINE
// "bib" under the glass split by a silver wedge and holding two round chrome
// headlights, a wine side band with silver chevron "wings" toward the rear,
// and a low-floor CENTER door that dips the floor line. Diamond pantograph.
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { type Box, diamond, diamondBar, F, fQuad, ground, ISO, P, poly, R, S, sQuad, rQuad, VB } from './lib';

const b: Box = { cx: 34, cy: 78, w: 26, l: 37, h: 28 };
const f = (u: number, v: number) => P(F(b, u, v));
const s = (u: number, v: number) => P(S(b, u, v));

const SIDE_BODY = `M${s(0, 0.06)} L${s(0.94, 0.06)} Q${s(1.06, 0.5)} ${s(0.92, 1)} L${s(0, 1)} Z`;
const FRONT_BODY = `M${f(0, 0.06)} L${f(1, 0.06)} L${f(1, 0.68)} Q${f(1, 1.05)} ${f(0.7, 1.01)} L${f(0.3, 1.01)} Q${f(0, 1.05)} ${f(0, 0.68)} Z`;
// ONE smooth curved pane — no divider, slightly deeper than the T3 screen.
const WINDSCREEN = `M${f(0.07, 0.5)} L${f(0.93, 0.5)} L${f(0.93, 0.74)} Q${f(0.93, 0.9)} ${f(0.74, 0.9)} L${f(0.26, 0.9)} Q${f(0.07, 0.9)} ${f(0.07, 0.74)} Z`;
// Wine bib: hangs from the glass, lower edge curls up at the outer corners.
const BIB = `M${f(0.02, 0.46)} L${f(0.98, 0.46)} L${f(0.98, 0.36)} Q${f(0.92, 0.15)} ${f(0.76, 0.15)} L${f(0.24, 0.15)} Q${f(0.08, 0.15)} ${f(0.02, 0.36)} Z`;
// Silver wedge splitting the bib at center (points down toward the coupling).
const WEDGE = poly(F(b, 0.41, 0.46), F(b, 0.59, 0.46), F(b, 0.5, 0.13));
// Silver chevron "wings" slashing through the wine side band near the rear.
const CHEV1 = poly(S(b, 0.68, 0.3), S(b, 0.73, 0.3), S(b, 0.79, 0.54), S(b, 0.74, 0.54));
const CHEV2 = poly(S(b, 0.78, 0.3), S(b, 0.83, 0.3), S(b, 0.89, 0.54), S(b, 0.84, 0.54));

const pantoM = R(b, 0.5, 0.52);

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* ground shadow */}
      <Path d={ground(b)} fill={ISO.shadow} stroke={ISO.shadow} strokeWidth={4} strokeLinejoin="round" opacity={0.16} />
      {/* underframe + end bogies (center rides low) */}
      <Path d={fQuad(b, 0.03, -0.04, 0.97, 0.07)} fill={ISO.under} />
      <Path d={sQuad(b, 0, -0.04, 0.95, 0.07)} fill={ISO.under} />
      <Path d={sQuad(b, 0.1, -0.09, 0.26, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.72, -0.09, 0.88, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      {/* smooth silver roof + boxy AC unit up front */}
      <Path d={rQuad(b, 0, 0, 1, 1)} fill={ISO.silverRoof} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={rQuad(b, 0.22, 0.06, 0.78, 0.26)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.9} strokeLinejoin="round" />
      {/* yellow DIAMOND pantograph */}
      <Path d={diamond(pantoM)} stroke={ISO.pantoY} strokeWidth={1.4} strokeLinejoin="round" fill="none" />
      <Path d={diamondBar(pantoM)} stroke={ISO.charcoal} strokeWidth={1.6} strokeLinecap="round" fill="none" />
      {/* side: champagne-silver shell, wine band + silver chevrons */}
      <Path d={SIDE_BODY} fill={ISO.silverSide} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0, 0.3, 0.97, 0.54)} fill={ISO.wineSide} />
      <Path d={CHEV1} fill={ISO.silverSide} />
      <Path d={CHEV2} fill={ISO.silverSide} />
      {/* side: front door – window – WIDE low-floor center door – window – rear door */}
      <Path d={sQuad(b, 0.07, 0.12, 0.18, 0.84)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.4} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.22, 0.56, 0.36, 0.84)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.2} strokeLinejoin="round" />
      {/* the LOW-FLOOR plug door: glass drops well below the belt line */}
      <Path d={sQuad(b, 0.41, 0.04, 0.57, 0.84)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.4} strokeLinejoin="round" />
      <Line x1={S(b, 0.49, 0.05)[0]} y1={S(b, 0.49, 0.05)[1]} x2={S(b, 0.49, 0.83)[0]} y2={S(b, 0.49, 0.83)[1]} stroke={ISO.glassSide} strokeWidth={0.8} />
      <Path d={sQuad(b, 0.62, 0.56, 0.76, 0.84)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.8, 0.12, 0.91, 0.84)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.4} strokeLinejoin="round" />
      {/* front face — silver bun */}
      <Path d={FRONT_BODY} fill={ISO.silver} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      {/* wine bib + silver center wedge */}
      <Path d={BIB} fill={ISO.wine} />
      <Path d={WEDGE} fill={ISO.silver} />
      {/* smooth SINGLE curved windscreen + corner spill onto the side */}
      <Path d={sQuad(b, 0.015, 0.52, 0.085, 0.88)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={WINDSCREEN} fill={ISO.glass} stroke={ISO.glass} strokeWidth={1.6} strokeLinejoin="round" />
      <Path d={poly(F(b, 0.58, 0.5), F(b, 0.72, 0.5), F(b, 0.5, 0.9), F(b, 0.38, 0.9))} fill={ISO.glint} opacity={0.28} />
      <Circle cx={F(b, 0.8, 0.82)[0]} cy={F(b, 0.8, 0.82)[1]} r={1.2} fill={ISO.glint} opacity={0.85} />
      {/* orange LED destination in the brow */}
      <Path d={fQuad(b, 0.16, 0.905, 0.84, 0.99)} fill={ISO.charcoal} stroke={ISO.charcoal} strokeWidth={1} strokeLinejoin="round" />
      <Path d={fQuad(b, 0.21, 0.928, 0.31, 0.968)} fill={ISO.ledOrange} opacity={0.95} />
      <Path d={fQuad(b, 0.37, 0.928, 0.79, 0.968)} fill={ISO.ledOrange} opacity={0.95} />
      {/* two round chrome headlights held by the wine bib, flanking the wedge */}
      <Circle cx={F(b, 0.26, 0.29)[0]} cy={F(b, 0.26, 0.29)[1]} r={3} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.4} />
      <Circle cx={F(b, 0.74, 0.29)[0]} cy={F(b, 0.74, 0.29)[1]} r={3} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.4} />
      <Circle cx={F(b, 0.29, 0.33)[0]} cy={F(b, 0.29, 0.33)[1]} r={0.9} fill="#FFFFFF" opacity={0.9} />
      <Circle cx={F(b, 0.77, 0.33)[0]} cy={F(b, 0.77, 0.33)[1]} r={0.9} fill="#FFFFFF" opacity={0.9} />
      {/* silver skirt lip */}
      <Path d={`M${f(0.06, 0.09)} Q${f(0.5, 0.02)} ${f(0.94, 0.09)}`} stroke={ISO.chrome} strokeWidth={1.6} strokeLinecap="round" fill="none" />
    </Svg>
  );
}
