// Škoda 14T Elektra — the "Porsche" tram (Porsche Design body).
// Tells: smoothly rounded ONE-PIECE mask, steeply raked windscreen with
// rounded top corners blending into the roof (destination LED glows behind the
// glass), round lamp clusters RECESSED low in the curved mask, NO front door.
// Side: the caterpillar — FIVE short articulated sections, four body joints,
// undulating beltline, long front overhang, grey skirt, red-and-cream livery.
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { type Box, F, fQuad, ground, ISO, P, poly, R, S, sQuad, rQuad, VB } from './lib';

const b: Box = { cx: 32, cy: 78, w: 26, l: 52, h: 26 };
const f = (u: number, v: number) => P(F(b, u, v));
const s = (u: number, v: number) => P(S(b, u, v));

const FRONT_BODY = `M${f(0, 0.06)} L${f(1, 0.06)} L${f(1, 0.55)} Q${f(0.99, 0.97)} ${f(0.72, 1.01)} L${f(0.28, 1.01)} Q${f(0.01, 0.97)} ${f(0, 0.55)} Z`;
const SIDE_BODY = `M${s(0, 0.06)} L${s(0.96, 0.06)} Q${s(1.03, 0.5)} ${s(0.96, 1)} L${s(0, 1)} Z`;
// Tall raked windscreen, top corners melting into the roofline.
const WINDSCREEN = `M${f(0.13, 0.4)} L${f(0.87, 0.4)} L${f(0.87, 0.72)} Q${f(0.86, 0.95)} ${f(0.6, 0.96)} L${f(0.4, 0.96)} Q${f(0.14, 0.95)} ${f(0.13, 0.72)} Z`;

// Single-arm pantograph over section 2.
const p0 = R(b, 0.5, 0.3);
const knee = [p0[0] - 1.2, p0[1] - 5.8] as const;
const head = [knee[0] + 4.6, knee[1] - 2.4] as const;
const PANTO = `M${P(p0)} L${knee[0]} ${knee[1]} L${head[0]} ${head[1]}`;
const PANTO_BAR = `M${head[0] - 2.8} ${head[1] + 1.4} L${head[0] + 2.8} ${head[1] - 1.4}`;

/** One accordion joint (thin dark band with a seam). */
function Joint({ u }: { u: number }) {
  return (
    <>
      <Path d={sQuad(b, u, 0.08, u + 0.028, 0.96)} fill={ISO.under} />
      <Line x1={S(b, u + 0.014, 0.1)[0]} y1={S(b, u + 0.014, 0.1)[1]} x2={S(b, u + 0.014, 0.94)[0]} y2={S(b, u + 0.014, 0.94)[1]} stroke={ISO.outline} strokeWidth={0.7} />
    </>
  );
}

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* ground shadow */}
      <Path d={ground(b)} fill={ISO.shadow} stroke={ISO.shadow} strokeWidth={4} strokeLinejoin="round" opacity={0.16} />
      {/* underframe */}
      <Path d={fQuad(b, 0.03, -0.04, 0.97, 0.07)} fill={ISO.under} />
      <Path d={sQuad(b, 0, -0.04, 0.97, 0.07)} fill={ISO.under} />
      <Path d={sQuad(b, 0.06, -0.08, 0.17, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.47, -0.08, 0.58, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.86, -0.08, 0.96, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      {/* roof: smooth cream with one AC pod */}
      <Path d={rQuad(b, 0, 0, 1, 1)} fill={ISO.creamRoof} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={rQuad(b, 0.3, 0.55, 0.72, 0.72)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} strokeLinejoin="round" />
      <Path d={PANTO} stroke={ISO.charcoal} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d={PANTO_BAR} stroke={ISO.charcoal} strokeWidth={1.7} strokeLinecap="round" fill="none" />
      {/* side: cream body, red band, grey skirt */}
      <Path d={SIDE_BODY} fill={ISO.creamSide} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0, 0.16, 0.965, 0.42)} fill={ISO.redSide} />
      <Path d={sQuad(b, 0, 0.06, 0.965, 0.16)} fill={ISO.greySide} />
      {/* section 1 — cab (glass partition, small cab door, NO passenger front door) */}
      <Path d={sQuad(b, 0.025, 0.48, 0.095, 0.8)} fill={ISO.glassSide} />
      <Path d={sQuad(b, 0.12, 0.52, 0.2, 0.8)} fill={ISO.glassSide} />
      <Joint u={0.235} />
      {/* section 2 — wide low-floor door */}
      <Path d={sQuad(b, 0.29, 0.1, 0.4, 0.8)} fill={ISO.glassDoor} />
      <Line x1={S(b, 0.345, 0.11)[0]} y1={S(b, 0.345, 0.11)[1]} x2={S(b, 0.345, 0.79)[0]} y2={S(b, 0.345, 0.79)[1]} stroke={ISO.glassSide} strokeWidth={0.8} />
      <Joint u={0.43} />
      {/* section 3 — deeper windows (the beltline undulates) */}
      <Path d={sQuad(b, 0.47, 0.46, 0.59, 0.82)} fill={ISO.glassSide} />
      <Joint u={0.625} />
      {/* section 4 — second wide door */}
      <Path d={sQuad(b, 0.665, 0.1, 0.775, 0.8)} fill={ISO.glassDoor} />
      <Line x1={S(b, 0.72, 0.11)[0]} y1={S(b, 0.72, 0.11)[1]} x2={S(b, 0.72, 0.79)[0]} y2={S(b, 0.72, 0.79)[1]} stroke={ISO.glassSide} strokeWidth={0.8} />
      <Joint u={0.815} />
      {/* section 5 — tail window */}
      <Path d={sQuad(b, 0.855, 0.52, 0.945, 0.8)} fill={ISO.glassSide} />
      {/* front face: one-piece rounded mask */}
      <Path d={FRONT_BODY} fill={ISO.cream} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={fQuad(b, 0, 0.16, 1, 0.38)} fill={ISO.red} />
      <Path d={fQuad(b, 0, 0.06, 1, 0.16)} fill={ISO.grey} />
      {/* raked windscreen with LED destination glowing behind the glass */}
      <Path d={WINDSCREEN} fill={ISO.glass} stroke={ISO.glass} strokeWidth={1.8} strokeLinejoin="round" />
      <Path d={fQuad(b, 0.32, 0.85, 0.68, 0.92)} fill={ISO.amber} opacity={0.9} />
      <Path d={poly(F(b, 0.58, 0.4), F(b, 0.72, 0.4), F(b, 0.5, 0.95), F(b, 0.38, 0.95))} fill={ISO.glint} opacity={0.26} />
      <Circle cx={F(b, 0.78, 0.85)[0]} cy={F(b, 0.78, 0.85)[1]} r={1.2} fill={ISO.glint} opacity={0.85} />
      {/* round lamp clusters recessed low in the mask */}
      <Circle cx={F(b, 0.2, 0.24)[0]} cy={F(b, 0.2, 0.24)[1]} r={3.1} fill={ISO.charcoal} />
      <Circle cx={F(b, 0.8, 0.24)[0]} cy={F(b, 0.8, 0.24)[1]} r={3.1} fill={ISO.charcoal} />
      <Circle cx={F(b, 0.2, 0.24)[0]} cy={F(b, 0.2, 0.24)[1]} r={1.9} fill={ISO.warm} />
      <Circle cx={F(b, 0.8, 0.24)[0]} cy={F(b, 0.8, 0.24)[1]} r={1.9} fill={ISO.warm} />
      <Circle cx={F(b, 0.23, 0.27)[0]} cy={F(b, 0.23, 0.27)[1]} r={0.7} fill="#FFFFFF" opacity={0.9} />
      <Circle cx={F(b, 0.83, 0.27)[0]} cy={F(b, 0.83, 0.27)[1]} r={0.7} fill="#FFFFFF" opacity={0.9} />
      {/* smooth grey bumper lip */}
      <Path d={`M${f(0.06, 0.1)} Q${f(0.5, 0.045)} ${f(0.94, 0.1)}`} stroke={ISO.greySide} strokeWidth={1.6} strokeLinecap="round" fill="none" />
    </Svg>
  );
}
