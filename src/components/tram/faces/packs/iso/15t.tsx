// Škoda 15T ForCity Alfa — the current workhorse.
// Tells: broad rounded-trapezoid face, big single windscreen raked back with a
// slight V-PEAK at the top center, ANGULAR polygonal headlight clusters — the
// "cheekbones" — sculpted into the mask, full-width LED destination at the
// roofline. Side: only THREE long sections (two joints), one continuous low
// window line, 100% low floor. Red lower body, white upper, grey skirt.
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { type Box, F, fQuad, ground, ISO, P, poly, R, S, sQuad, rQuad, VB } from './lib';

const b: Box = { cx: 32, cy: 78, w: 26, l: 52, h: 27 };
const f = (u: number, v: number) => P(F(b, u, v));
const s = (u: number, v: number) => P(S(b, u, v));

// Rounded trapezoid: flanks taper inward toward the roof.
const FRONT_BODY = `M${f(0, 0.06)} L${f(1, 0.06)} L${f(1, 0.45)} Q${f(0.97, 0.9)} ${f(0.8, 0.98)} L${f(0.2, 0.98)} Q${f(0.03, 0.9)} ${f(0, 0.45)} Z`;
const SIDE_BODY = `M${s(0, 0.06)} L${s(0.97, 0.06)} Q${s(1.02, 0.5)} ${s(0.97, 1)} L${s(0, 1)} Z`;
// Windscreen with the subtle V peak at top center.
const WINDSCREEN = `M${f(0.12, 0.44)} L${f(0.88, 0.44)} L${f(0.86, 0.8)} L${f(0.5, 0.88)} L${f(0.14, 0.8)} Z`;
// Angular "cheekbone" headlight clusters.
const CHEEK_NEAR = poly(F(b, 0.06, 0.16), F(b, 0.26, 0.22), F(b, 0.28, 0.34), F(b, 0.09, 0.3));
const CHEEK_FAR = poly(F(b, 0.74, 0.22), F(b, 0.94, 0.16), F(b, 0.91, 0.3), F(b, 0.72, 0.34));
const LAMP_NEAR = poly(F(b, 0.1, 0.2), F(b, 0.22, 0.24), F(b, 0.23, 0.3), F(b, 0.12, 0.27));
const LAMP_FAR = poly(F(b, 0.78, 0.24), F(b, 0.9, 0.2), F(b, 0.88, 0.27), F(b, 0.77, 0.3));

// Single-arm pantograph over the front section.
const p0 = R(b, 0.5, 0.2);
const knee = [p0[0] - 1.2, p0[1] - 5.8] as const;
const head = [knee[0] + 4.6, knee[1] - 2.4] as const;
const PANTO = `M${P(p0)} L${knee[0]} ${knee[1]} L${head[0]} ${head[1]}`;
const PANTO_BAR = `M${head[0] - 2.8} ${head[1] + 1.4} L${head[0] + 2.8} ${head[1] - 1.4}`;

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* ground shadow */}
      <Path d={ground(b)} fill={ISO.shadow} stroke={ISO.shadow} strokeWidth={4} strokeLinejoin="round" opacity={0.16} />
      {/* underframe */}
      <Path d={fQuad(b, 0.03, -0.04, 0.97, 0.07)} fill={ISO.under} />
      <Path d={sQuad(b, 0, -0.04, 0.98, 0.07)} fill={ISO.under} />
      <Path d={sQuad(b, 0.08, -0.08, 0.2, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.45, -0.08, 0.56, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.82, -0.08, 0.94, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      {/* roof: white with AC boxes */}
      <Path d={rQuad(b, 0, 0, 1, 1)} fill={ISO.whiteRoof} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={rQuad(b, 0.28, 0.4, 0.74, 0.56)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} strokeLinejoin="round" />
      <Path d={rQuad(b, 0.3, 0.72, 0.72, 0.86)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} strokeLinejoin="round" />
      <Path d={PANTO} stroke={ISO.charcoal} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d={PANTO_BAR} stroke={ISO.charcoal} strokeWidth={1.7} strokeLinecap="round" fill="none" />
      {/* side: white upper, red band, grey skirt */}
      <Path d={SIDE_BODY} fill={ISO.whiteSide} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0, 0.14, 0.975, 0.44)} fill={ISO.redSide} />
      <Path d={sQuad(b, 0, 0.06, 0.975, 0.14)} fill={ISO.greySide} />
      {/* one continuous low window line across the whole side */}
      <Path d={sQuad(b, 0.025, 0.44, 0.96, 0.8)} fill={ISO.glassSide} />
      {/* doors dropping out of the band */}
      <Path d={sQuad(b, 0.06, 0.08, 0.15, 0.8)} fill={ISO.glassDoor} />
      <Path d={sQuad(b, 0.42, 0.08, 0.54, 0.8)} fill={ISO.glassDoor} />
      <Line x1={S(b, 0.48, 0.09)[0]} y1={S(b, 0.48, 0.09)[1]} x2={S(b, 0.48, 0.79)[0]} y2={S(b, 0.48, 0.79)[1]} stroke={ISO.glassSide} strokeWidth={0.8} />
      <Path d={sQuad(b, 0.85, 0.08, 0.93, 0.8)} fill={ISO.glassDoor} />
      {/* window pillars */}
      <Line x1={S(b, 0.22, 0.45)[0]} y1={S(b, 0.22, 0.45)[1]} x2={S(b, 0.22, 0.79)[0]} y2={S(b, 0.22, 0.79)[1]} stroke={ISO.whiteSide} strokeWidth={1} />
      <Line x1={S(b, 0.6, 0.45)[0]} y1={S(b, 0.6, 0.45)[1]} x2={S(b, 0.6, 0.79)[0]} y2={S(b, 0.6, 0.79)[1]} stroke={ISO.whiteSide} strokeWidth={1} />
      <Line x1={S(b, 0.72, 0.45)[0]} y1={S(b, 0.72, 0.45)[1]} x2={S(b, 0.72, 0.79)[0]} y2={S(b, 0.72, 0.79)[1]} stroke={ISO.whiteSide} strokeWidth={1} />
      {/* only TWO articulation joints (three long sections) */}
      <Path d={sQuad(b, 0.325, 0.08, 0.35, 0.96)} fill={ISO.under} />
      <Path d={sQuad(b, 0.655, 0.08, 0.68, 0.96)} fill={ISO.under} />
      {/* front face */}
      <Path d={FRONT_BODY} fill={ISO.white} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={fQuad(b, 0, 0.14, 1, 0.42)} fill={ISO.red} />
      <Path d={fQuad(b, 0, 0.06, 1, 0.14)} fill={ISO.grey} />
      {/* windscreen with V peak + glint */}
      <Path d={WINDSCREEN} fill={ISO.glass} stroke={ISO.glass} strokeWidth={1.6} strokeLinejoin="round" />
      <Path d={poly(F(b, 0.58, 0.44), F(b, 0.72, 0.44), F(b, 0.52, 0.86), F(b, 0.4, 0.85))} fill={ISO.glint} opacity={0.26} />
      <Circle cx={F(b, 0.78, 0.76)[0]} cy={F(b, 0.78, 0.76)[1]} r={1.2} fill={ISO.glint} opacity={0.85} />
      {/* full-width LED destination at the roofline */}
      <Path d={fQuad(b, 0.17, 0.9, 0.83, 0.97)} fill={ISO.charcoal} stroke={ISO.charcoal} strokeWidth={1} strokeLinejoin="round" />
      <Path d={fQuad(b, 0.22, 0.917, 0.32, 0.952)} fill={ISO.amber} opacity={0.95} />
      <Path d={fQuad(b, 0.38, 0.917, 0.72, 0.952)} fill={ISO.amber} opacity={0.95} />
      {/* angular cheekbone lamp clusters */}
      <Path d={CHEEK_NEAR} fill={ISO.charcoal} />
      <Path d={CHEEK_FAR} fill={ISO.charcoal} />
      <Path d={LAMP_NEAR} fill={ISO.warm} />
      <Path d={LAMP_FAR} fill={ISO.warm} />
      <Circle cx={F(b, 0.14, 0.24)[0]} cy={F(b, 0.14, 0.24)[1]} r={0.7} fill="#FFFFFF" opacity={0.9} />
      <Circle cx={F(b, 0.86, 0.24)[0]} cy={F(b, 0.86, 0.24)[1]} r={0.7} fill="#FFFFFF" opacity={0.9} />
    </Svg>
  );
}
