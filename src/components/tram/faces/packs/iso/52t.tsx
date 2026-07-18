// Škoda 52T ForCity Plus — the WHITE tram with the glossy BLACK helmet visor:
// black sweeps up over the roof cap and down the A-pillars around a huge
// windscreen. Amber LED destination band inside the visor top, slim 3-element
// LED lights low in the black lower corners, white apron with a single RED
// center panel (pid), red wave on the flank, LOW body-colored skirt (no
// bumper), red roof segment mid-length, single-arm pantograph. Long.
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { type Box, F, fQuad, ground, ISO, P, poly, R, S, sQuad, rQuad, VB } from './lib';

const b: Box = { cx: 31, cy: 78, w: 25, l: 52, h: 28 };
const f = (u: number, v: number) => P(F(b, u, v));
const s = (u: number, v: number) => P(S(b, u, v));

// Soft helmet dome: generous rounding into the roofline.
const FRONT_BODY = `M${f(0, 0.05)} L${f(1, 0.05)} L${f(1, 0.72)} Q${f(1, 1.04)} ${f(0.72, 1.02)} L${f(0.28, 1.02)} Q${f(0, 1.04)} ${f(0, 0.72)} Z`;
const SIDE_BODY = `M${s(0, 0.05)} L${s(0.98, 0.05)} Q${s(1.02, 0.5)} ${s(0.98, 1)} L${s(0, 1)} Z`;
// The glossy black VISOR: wraps the windscreen, sweeps up over the crown and
// down the A-pillars to just above the light line.
const VISOR = `M${f(0.05, 0.3)} L${f(0.95, 0.3)} L${f(0.95, 0.72)} Q${f(0.95, 1.03)} ${f(0.71, 1.015)} L${f(0.29, 1.015)} Q${f(0.05, 1.03)} ${f(0.05, 0.72)} Z`;
// Windscreen glass inside the visor.
const GLASS = `M${f(0.12, 0.4)} L${f(0.88, 0.4)} L${f(0.88, 0.68)} Q${f(0.88, 0.88)} ${f(0.66, 0.88)} L${f(0.34, 0.88)} Q${f(0.12, 0.88)} ${f(0.12, 0.68)} Z`;
// Red wave on the flank: skirt-level red that sweeps up around the mid doors
// and thins out toward the rear.
const WAVE = `M${s(0.34, 0.05)} L${s(0.97, 0.05)} L${s(0.97, 0.14)} Q${s(0.72, 0.3)} ${s(0.55, 0.3)} Q${s(0.42, 0.3)} ${s(0.34, 0.05)} Z`;

// Single-arm pantograph.
const p0 = R(b, 0.5, 0.36);
const knee = [p0[0] - 1.2, p0[1] - 5.8] as const;
const head = [knee[0] + 4.6, knee[1] - 2.4] as const;
const PANTO = `M${P(p0)} L${knee[0]} ${knee[1]} L${head[0]} ${head[1]}`;
const PANTO_BAR = `M${head[0] - 2.8} ${head[1] + 1.4} L${head[0] + 2.8} ${head[1] - 1.4}`;

/** Slim 3-element LED light bar tucked in a black visor corner. */
function LedBar({ u }: { u: number }) {
  return (
    <>
      <Path d={fQuad(b, u, 0.335, u + 0.045, 0.365)} fill="#EAF6FE" />
      <Path d={fQuad(b, u + 0.065, 0.335, u + 0.11, 0.365)} fill="#EAF6FE" />
      <Path d={fQuad(b, u + 0.13, 0.335, u + 0.175, 0.365)} fill="#EAF6FE" />
    </>
  );
}

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* ground shadow */}
      <Path d={ground(b)} fill={ISO.shadow} stroke={ISO.shadow} strokeWidth={4} strokeLinejoin="round" opacity={0.16} />
      {/* LOW slim underframe — body-colored skirt hugs the rails */}
      <Path d={fQuad(b, 0.05, -0.02, 0.95, 0.05)} fill={ISO.under} />
      <Path d={sQuad(b, 0.01, -0.02, 0.97, 0.05)} fill={ISO.under} />
      {/* roof: BLACK visor crown up front, white roof, red mid segment, AC boxes */}
      <Path d={rQuad(b, 0, 0, 1, 1)} fill={ISO.whiteRoof} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={rQuad(b, 0, 0, 1, 0.1)} fill={ISO.visor} />
      <Path d={rQuad(b, 0, 0.46, 1, 0.58)} fill={ISO.redRoof} />
      <Path d={rQuad(b, 0.3, 0.16, 0.72, 0.28)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} />
      <Path d={rQuad(b, 0.3, 0.68, 0.72, 0.8)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} />
      {/* SINGLE-ARM pantograph */}
      <Path d={PANTO} stroke={ISO.charcoal} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d={PANTO_BAR} stroke={ISO.charcoal} strokeWidth={1.7} strokeLinecap="round" fill="none" />
      {/* side: white shell, tall glazing, red wave low around the mid/rear */}
      <Path d={SIDE_BODY} fill={ISO.whiteSide} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={WAVE} fill={ISO.redSide} />
      <Path d={sQuad(b, 0.02, 0.44, 0.965, 0.84)} fill={ISO.glassSide} />
      {/* glassy double doors */}
      <Path d={sQuad(b, 0.06, 0.05, 0.15, 0.84)} fill={ISO.glassDoor} />
      <Line x1={S(b, 0.105, 0.06)[0]} y1={S(b, 0.105, 0.06)[1]} x2={S(b, 0.105, 0.83)[0]} y2={S(b, 0.105, 0.83)[1]} stroke={ISO.glassSide} strokeWidth={0.8} />
      <Path d={sQuad(b, 0.42, 0.05, 0.51, 0.84)} fill={ISO.glassDoor} />
      <Line x1={S(b, 0.465, 0.06)[0]} y1={S(b, 0.465, 0.06)[1]} x2={S(b, 0.465, 0.83)[0]} y2={S(b, 0.465, 0.83)[1]} stroke={ISO.glassSide} strokeWidth={0.8} />
      <Path d={sQuad(b, 0.76, 0.05, 0.85, 0.84)} fill={ISO.glassDoor} />
      <Line x1={S(b, 0.805, 0.06)[0]} y1={S(b, 0.805, 0.06)[1]} x2={S(b, 0.805, 0.83)[0]} y2={S(b, 0.805, 0.83)[1]} stroke={ISO.glassSide} strokeWidth={0.8} />
      {/* articulation joints */}
      <Path d={sQuad(b, 0.3, 0.06, 0.313, 0.93)} fill={ISO.under} opacity={0.85} />
      <Path d={sQuad(b, 0.64, 0.06, 0.653, 0.93)} fill={ISO.under} opacity={0.85} />
      {/* small red pid mark on the white flank near the front */}
      <Path d={sQuad(b, 0.19, 0.16, 0.26, 0.28)} fill={ISO.redSide} />
      {/* front face — WHITE helmet */}
      <Path d={FRONT_BODY} fill={ISO.white} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      {/* the glossy BLACK visor over the glass, crown and pillars */}
      <Path d={VISOR} fill={ISO.visor} stroke={ISO.visor} strokeWidth={1.4} strokeLinejoin="round" />
      <Path d={GLASS} fill={ISO.glass} />
      <Path d={poly(F(b, 0.55, 0.41), F(b, 0.68, 0.41), F(b, 0.44, 0.87), F(b, 0.33, 0.87))} fill={ISO.glint} opacity={0.24} />
      <Path d={poly(F(b, 0.75, 0.41), F(b, 0.8, 0.41), F(b, 0.55, 0.87), F(b, 0.51, 0.87))} fill={ISO.glint} opacity={0.14} />
      <Circle cx={F(b, 0.8, 0.8)[0]} cy={F(b, 0.8, 0.8)[1]} r={1.2} fill={ISO.glint} opacity={0.8} />
      {/* AMBER LED destination band inside the visor top */}
      <Path d={fQuad(b, 0.2, 0.9, 0.44, 0.945)} fill={ISO.ledOrange} opacity={0.95} />
      <Path d={fQuad(b, 0.5, 0.9, 0.8, 0.945)} fill={ISO.ledOrange} opacity={0.95} />
      {/* slim 3-element LED bars low in the black corners */}
      <LedBar u={0.075} />
      <LedBar u={0.75} />
      {/* white apron with the single RED center panel (pid + number) */}
      <Path d={fQuad(b, 0.4, 0.05, 0.6, 0.3)} fill={ISO.red} />
      <Path d={fQuad(b, 0.44, 0.2, 0.56, 0.24)} fill="#FFFFFF" opacity={0.9} />
      {/* body-colored skirt — just a soft seam, explicitly NO bumper mass */}
      <Line x1={F(b, 0.04, 0.05)[0]} y1={F(b, 0.04, 0.05)[1]} x2={F(b, 0.96, 0.05)[0]} y2={F(b, 0.96, 0.05)[1]} stroke={ISO.whiteSide} strokeWidth={1} />
    </Svg>
  );
}
