// Škoda 52T ForCity Plus — the new one (ref 9506). THE SHAPE: a TALL, almost
// VERTICAL face (barely 1.5px of lean) topped by one big smooth radius — the
// crown rolls 6px back into the roof like a streamlined helmet. The glossy
// BLACK visor wraps the high windscreen and sweeps up over that crown; below
// it a slim grey band holds the LED lamp clusters, and the apron splits
// white / RED with the "pid" mark. White flank, red beltline sweep, black
// visor wrapping the cab side glass, single-arm pantograph.
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { F, fQuad, ISO, isoBox, LONG_W, N3, P, poly, S, singleArm, sQuad, VB } from './lib';
import { Stage } from './stage';

const b = isoBox(LONG_W);
const np = (a: number, d: number, z: number) => P(N3(b, a, d, z));

const GREY_BAND = '#C9CDCE';

// Nose profile: near-vertical (1.5px lean to z 0.80), then the big helmet
// crown rolling 6px back into the roof.
const noseD = (z: number): number => (z <= 0.8 ? Math.max(0, (1.5 * (z - 0.06)) / 0.74) : 1.5);
const VP = (a: number, z: number) => N3(b, a, noseD(z), z);
const vp = (a: number, z: number) => P(VP(a, z));

const FRONT_BODY = `M${np(0, 0, 0.06)} Q${np(0.5, -1.2, 0.06)} ${np(1, 0, 0.06)} L${np(1, 1.5, 0.8)} Q${np(1, 5.8, 1)} ${np(0.83, 7, 1)} L${np(0.17, 7, 1)} Q${np(0, 5.8, 1)} ${np(0, 1.5, 0.8)} L${np(0, 0, 0.06)} Z`;
const SIDE_BODY = `M${np(0, 0, 0.06)} L${np(0, 37, 0.06)} Q${np(0, 39.3, 0.5)} ${np(0, 37, 1)} L${np(0, 7, 1)} Q${np(0, 5.8, 1)} ${np(0, 1.5, 0.8)} L${np(0, 0, 0.06)} Z`;
const ROOF = `M${np(0, 6.8, 1)} L${np(1, 6.8, 1)} L${np(1, 36.8, 1)} L${np(0, 37, 1)} Z`;
// Glossy black VISOR: tall glass, sweeping over the crown with the body roll,
// bowed lower edge (the mask is curved in plan).
const VISOR = `M${vp(0.05, 0.45)} Q${np(0.5, noseD(0.45) - 1, 0.45)} ${vp(0.95, 0.45)} L${vp(0.95, 0.78)} Q${np(0.95, 5.4, 0.99)} ${np(0.79, 6.6, 1)} L${np(0.21, 6.6, 1)} Q${np(0.05, 5.4, 0.99)} ${vp(0.05, 0.78)} Z`;
// ...continuing onto the roof as a short black strip.
const VISOR_ROOF = `M${np(0.19, 6.7, 1)} L${np(0.81, 6.7, 1)} L${np(0.83, 9.5, 1)} L${np(0.17, 9.5, 1)} Z`;
// Windscreen glass inside the visor.
const GLASS = `M${vp(0.14, 0.5)} Q${np(0.5, noseD(0.5) - 0.8, 0.5)} ${vp(0.86, 0.5)} L${vp(0.86, 0.74)} Q${vp(0.86, 0.9)} ${vp(0.64, 0.91)} L${vp(0.36, 0.91)} Q${vp(0.14, 0.9)} ${vp(0.14, 0.74)} Z`;
// Red sweep on the flank: dives from the cab down the beltline toward the rear.
const SWEEP = `M${np(0, 4.5, 0.52)} L${np(0, 37.5, 0.44)} L${np(0, 37.5, 0.5)} L${np(0, 6.8, 0.6)} Z`;

const panto = singleArm(N3(b, 0.5, 16, 1));

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
      {/* roof: white helmet dome, red mid segment, AC boxes */}
      <Path d={ROOF} fill={ISO.whiteRoof} stroke={ISO.outline} strokeWidth={1.1} strokeLinejoin="round" />
      <Path d={poly(N3(b, 0, 19, 1), N3(b, 1, 19, 1), N3(b, 1, 22.5, 1), N3(b, 0, 22.5, 1))} fill={ISO.redRoof} />
      <Path d={poly(N3(b, 0.28, 11, 1), N3(b, 0.74, 11, 1), N3(b, 0.74, 15.5, 1), N3(b, 0.28, 15.5, 1))} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} />
      <Path d={poly(N3(b, 0.28, 27, 1), N3(b, 0.74, 27, 1), N3(b, 0.74, 31.5, 1), N3(b, 0.28, 31.5, 1))} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} />
      {/* SINGLE-ARM pantograph */}
      <Path d={panto.arm} stroke={ISO.charcoal} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d={panto.bar} stroke={ISO.charcoal} strokeWidth={1.7} strokeLinecap="round" fill="none" />
      {/* flank: white shell, grey glazing band, red beltline sweep */}
      <Path d={SIDE_BODY} fill={ISO.whiteSide} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.12, 0.52, 0.97, 0.86)} fill={ISO.glassSide} />
      <Path d={SWEEP} fill={ISO.redSide} />
      {/* the black visor wraps around the cab side glass */}
      <Path d={poly(N3(b, 0, 0.6, 0.5), N3(b, 0, 4, 0.5), N3(b, 0, 4, 0.95), N3(b, 0, 2.2, 0.95))} fill={ISO.visor} />
      <Path d={poly(N3(b, 0, 1.3, 0.56), N3(b, 0, 3.5, 0.56), N3(b, 0, 3.5, 0.89), N3(b, 0, 2.5, 0.89))} fill={ISO.glassSide} />
      {/* glassy double doors */}
      {[0.16, 0.46, 0.76].map((u) => (
        <Path key={u} d={sQuad(b, u, 0.06, u + 0.09, 0.86)} fill={ISO.glassDoor} />
      ))}
      {[0.205, 0.505, 0.805].map((u) => (
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
      <Path d={sQuad(b, 0.34, 0.07, 0.353, 0.94)} fill={ISO.under} opacity={0.85} />
      <Path d={sQuad(b, 0.64, 0.07, 0.653, 0.94)} fill={ISO.under} opacity={0.85} />
      {/* front — the tall WHITE helmet */}
      <Path d={FRONT_BODY} fill={ISO.white} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      {/* slim grey band under the glass */}
      <Path d={fQuad(b, 0, 0.32, 1, 0.45)} fill={GREY_BAND} />
      {/* apron: white shell, RED "pid" block bottom-CENTER, number near it */}
      <Path d={poly(N3(b, 0.34, -0.9, 0.06), N3(b, 0.68, -0.9, 0.06), N3(b, 0.68, -0.9, 0.32), N3(b, 0.34, -0.9, 0.32))} fill={ISO.red} />
      <Path d={poly(N3(b, 0.41, -0.9, 0.17), N3(b, 0.61, -0.9, 0.17), N3(b, 0.61, -0.9, 0.215), N3(b, 0.41, -0.9, 0.215))} fill="#FFFFFF" opacity={0.92} />
      <Path d={fQuad(b, 0.08, 0.17, 0.28, 0.21)} fill={ISO.charcoal} opacity={0.55} />
      {/* glossy BLACK visor over glass and crown */}
      <Path d={VISOR} fill={ISO.visor} stroke={ISO.visor} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={VISOR_ROOF} fill={ISO.visor} />
      <Path d={GLASS} fill={ISO.glass} />
      <Path d={poly(VP(0.55, 0.52), VP(0.68, 0.52), VP(0.44, 0.9), VP(0.33, 0.9))} fill={ISO.glint} opacity={0.24} />
      <Path d={poly(VP(0.75, 0.52), VP(0.8, 0.52), VP(0.55, 0.9), VP(0.51, 0.9))} fill={ISO.glint} opacity={0.14} />
      <Circle cx={VP(0.8, 0.8)[0]} cy={VP(0.8, 0.8)[1]} r={1.1} fill={ISO.glint} opacity={0.8} />
      {/* AMBER LED destination band high in the visor */}
      <Path d={poly(N3(b, 0.3, 2.6, 0.9), N3(b, 0.7, 2.6, 0.9), N3(b, 0.7, 4, 0.955), N3(b, 0.3, 4, 0.955))} fill={ISO.ledOrange} opacity={0.95} />
      {/* black LED lamp clusters in the grey-band corners */}
      <LampCluster u={0.03} />
      <LampCluster u={0.77} />
      {/* body-colored skirt — just a soft seam, explicitly NO bumper mass */}
      <Line x1={F(b, 0.05, 0.06)[0]} y1={F(b, 0.05, 0.06)[1]} x2={F(b, 0.95, 0.06)[0]} y2={F(b, 0.95, 0.06)[1]} stroke={ISO.whiteSide} strokeWidth={1} />
    </Svg>
  );
}
