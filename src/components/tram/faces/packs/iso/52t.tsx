// Škoda 52T ForCity Plus — the new WHITE one (ref 9503/9506): clean white
// body with a glossy BLACK visor that wraps the windscreen, sweeps up over
// the roof crown and around the cab side windows. Under the glass a slim
// grey band holds black LED lamp clusters in the corners, and the apron is
// split in half: white with the fleet number / RED with the white "pid" —
// the red accent, explicitly NO chunky bumper (the skirt stays body-colored
// and low). White flank with a red beltline sweep, single-arm pantograph.
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { F, fQuad, ISO, isoBox, LONG_W, P, poly, R, rQuad, S, singleArm, sQuad, VB } from './lib';
import { Stage } from './stage';

const b = isoBox(LONG_W);
const f = (u: number, v: number) => P(F(b, u, v));
const s = (u: number, v: number) => P(S(b, u, v));

const GREY_BAND = '#C9CDCE';

// Soft helmet dome: generous rounding into the roofline.
const FRONT_BODY = `M${f(0, 0.06)} L${f(1, 0.06)} L${f(1, 0.74)} Q${f(1, 1.05)} ${f(0.7, 1.02)} L${f(0.3, 1.02)} Q${f(0, 1.05)} ${f(0, 0.74)} Z`;
const SIDE_BODY = `M${s(0, 0.06)} L${s(0.98, 0.06)} Q${s(1.02, 0.52)} ${s(0.98, 1)} L${s(0, 1)} Z`;
// Glossy black VISOR: wraps the glass, sweeps over the crown, drops down the
// A-pillars and stops above the light band.
const VISOR = `M${f(0.04, 0.44)} L${f(0.96, 0.44)} L${f(0.96, 0.74)} Q${f(0.96, 1.04)} ${f(0.69, 1.015)} L${f(0.31, 1.015)} Q${f(0.04, 1.04)} ${f(0.04, 0.74)} Z`;
// Windscreen glass inside the visor.
const GLASS = `M${f(0.13, 0.5)} L${f(0.87, 0.5)} L${f(0.87, 0.7)} Q${f(0.87, 0.89)} ${f(0.64, 0.89)} L${f(0.36, 0.89)} Q${f(0.13, 0.89)} ${f(0.13, 0.7)} Z`;
// Red sweep on the flank: dives from the cab down the beltline toward the rear.
const SWEEP = `M${s(0.1, 0.52)} L${s(0.99, 0.44)} L${s(0.99, 0.5)} L${s(0.16, 0.6)} Z`;

const panto = singleArm(R(b, 0.5, 0.4));

/** Black LED lamp cluster tucked in a corner of the grey band. */
function LampCluster({ u }: { u: number }) {
  return (
    <>
      <Path d={fQuad(b, u, 0.335, u + 0.2, 0.435)} fill={ISO.visor} stroke={ISO.visor} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={fQuad(b, u + 0.03, 0.37, u + 0.09, 0.4)} fill="#EAF6FE" />
      <Path d={fQuad(b, u + 0.11, 0.37, u + 0.17, 0.4)} fill="#EAF6FE" />
    </>
  );
}

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      <Stage b={b} />
      {/* LOW slim underframe — the skirt hugs the rails */}
      <Path d={fQuad(b, 0.05, -0.02, 0.95, 0.06)} fill={ISO.under} />
      <Path d={sQuad(b, 0.01, -0.02, 0.97, 0.06)} fill={ISO.under} />
      {/* roof: BLACK visor crown up front, white roof, red mid segment, AC boxes */}
      <Path d={rQuad(b, 0, 0, 1, 1)} fill={ISO.whiteRoof} stroke={ISO.outline} strokeWidth={1.1} strokeLinejoin="round" />
      <Path d={rQuad(b, 0, 0, 1, 0.1)} fill={ISO.visor} />
      <Path d={rQuad(b, 0, 0.48, 1, 0.58)} fill={ISO.redRoof} />
      <Path d={rQuad(b, 0.28, 0.18, 0.74, 0.3)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} />
      <Path d={rQuad(b, 0.28, 0.68, 0.74, 0.8)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} />
      {/* SINGLE-ARM pantograph */}
      <Path d={panto.arm} stroke={ISO.charcoal} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d={panto.bar} stroke={ISO.charcoal} strokeWidth={1.7} strokeLinecap="round" fill="none" />
      {/* flank: white shell, grey glazing band, red beltline sweep */}
      <Path d={SIDE_BODY} fill={ISO.whiteSide} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.1, 0.52, 0.97, 0.86)} fill={ISO.glassSide} />
      <Path d={SWEEP} fill={ISO.redSide} />
      {/* the black visor wraps around the cab side glass */}
      <Path d={sQuad(b, 0.005, 0.5, 0.09, 0.97)} fill={ISO.visor} />
      <Path d={sQuad(b, 0.02, 0.56, 0.075, 0.9)} fill={ISO.glassSide} />
      {/* glassy double doors */}
      {[0.14, 0.44, 0.74].map((u) => (
        <Path key={u} d={sQuad(b, u, 0.06, u + 0.09, 0.86)} fill={ISO.glassDoor} />
      ))}
      {[0.185, 0.485, 0.785].map((u) => (
        <Line
          key={u}
          x1={S(b, u, 0.07)[0]}
          y1={S(b, u, 0.07)[1]}
          x2={S(b, u, 0.85)[0]}
          y2={S(b, u, 0.85)[1]}
          stroke={ISO.glassSide}
          strokeWidth={0.8}
        />
      ))}
      {/* articulation joints */}
      <Path d={sQuad(b, 0.32, 0.07, 0.333, 0.94)} fill={ISO.under} opacity={0.85} />
      <Path d={sQuad(b, 0.62, 0.07, 0.633, 0.94)} fill={ISO.under} opacity={0.85} />
      {/* front — WHITE helmet */}
      <Path d={FRONT_BODY} fill={ISO.white} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      {/* slim grey band under the glass */}
      <Path d={fQuad(b, 0, 0.32, 1, 0.44)} fill={GREY_BAND} />
      {/* apron split: near half white with the number, far half RED with pid */}
      <Path d={fQuad(b, 0.5, 0.06, 0.97, 0.32)} fill={ISO.red} />
      <Path d={fQuad(b, 0.62, 0.17, 0.85, 0.215)} fill="#FFFFFF" opacity={0.92} />
      <Path d={fQuad(b, 0.15, 0.17, 0.38, 0.21)} fill={ISO.charcoal} opacity={0.55} />
      {/* glossy BLACK visor over glass and crown */}
      <Path d={VISOR} fill={ISO.visor} stroke={ISO.visor} strokeWidth={1.4} strokeLinejoin="round" />
      <Path d={GLASS} fill={ISO.glass} />
      <Path d={poly(F(b, 0.55, 0.51), F(b, 0.68, 0.51), F(b, 0.44, 0.88), F(b, 0.33, 0.88))} fill={ISO.glint} opacity={0.24} />
      <Path d={poly(F(b, 0.75, 0.51), F(b, 0.8, 0.51), F(b, 0.55, 0.88), F(b, 0.51, 0.88))} fill={ISO.glint} opacity={0.14} />
      <Circle cx={F(b, 0.8, 0.8)[0]} cy={F(b, 0.8, 0.8)[1]} r={1.1} fill={ISO.glint} opacity={0.8} />
      {/* AMBER LED destination band in the visor above the glass */}
      <Path d={fQuad(b, 0.28, 0.915, 0.72, 0.965)} fill={ISO.ledOrange} opacity={0.95} />
      {/* black LED lamp clusters in the grey-band corners */}
      <LampCluster u={0.03} />
      <LampCluster u={0.77} />
      {/* body-colored skirt — just a soft seam, explicitly NO bumper mass */}
      <Line x1={F(b, 0.05, 0.06)[0]} y1={F(b, 0.05, 0.06)[1]} x2={F(b, 0.95, 0.06)[0]} y2={F(b, 0.95, 0.06)[1]} stroke={ISO.whiteSide} strokeWidth={1} />
    </Svg>
  );
}
