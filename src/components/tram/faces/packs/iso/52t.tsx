// Škoda 52T ForCity Plus Praha — Red Dot 2025, the glassiest face in the fleet.
// Tells: a very TALL upright one-piece windscreen (~70%+ of the face height,
// rising from just above the skirt and sweeping into the roofline), thin black
// mask framing the glass, slim horizontal LED daytime-running strips flanking
// the LOWER windscreen, and a LOW, SMALL skirt hugging the rails — explicitly
// no chunky bumper. White body with red stripe accents (new PID livery).
// Side: FIVE sections, five wide floor-to-ceiling glazed double doors, flat
// continuous roof with AC modules.
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { type Box, F, fQuad, ground, ISO, P, poly, R, S, sQuad, rQuad, VB } from './lib';

const b: Box = { cx: 32, cy: 78, w: 26, l: 54, h: 29 };
const f = (u: number, v: number) => P(F(b, u, v));
const s = (u: number, v: number) => P(S(b, u, v));

const FRONT_BODY = `M${f(0, 0.04)} L${f(1, 0.04)} L${f(1, 0.75)} Q${f(1, 1.03)} ${f(0.74, 1.01)} L${f(0.26, 1.01)} Q${f(0, 1.03)} ${f(0, 0.75)} Z`;
const SIDE_BODY = `M${s(0, 0.04)} L${s(0.97, 0.04)} Q${s(1.02, 0.5)} ${s(0.97, 1)} L${s(0, 1)} Z`;
// Thin black mask around the glass, sweeping into the roofline.
const MASK = `M${f(0.08, 0.13)} L${f(0.92, 0.13)} L${f(0.92, 0.72)} Q${f(0.92, 0.995)} ${f(0.7, 0.995)} L${f(0.3, 0.995)} Q${f(0.08, 0.995)} ${f(0.08, 0.72)} Z`;
// The tall windscreen itself: v 0.18 → 0.93 of the face height.
const GLASS = `M${f(0.14, 0.18)} L${f(0.86, 0.18)} L${f(0.86, 0.66)} Q${f(0.86, 0.925)} ${f(0.64, 0.925)} L${f(0.36, 0.925)} Q${f(0.14, 0.925)} ${f(0.14, 0.66)} Z`;

// Single-arm pantograph over section 2.
const p0 = R(b, 0.5, 0.28);
const knee = [p0[0] - 1.2, p0[1] - 5.8] as const;
const head = [knee[0] + 4.6, knee[1] - 2.4] as const;
const PANTO = `M${P(p0)} L${knee[0]} ${knee[1]} L${head[0]} ${head[1]}`;
const PANTO_BAR = `M${head[0] - 2.8} ${head[1] + 1.4} L${head[0] + 2.8} ${head[1] - 1.4}`;

/** One wide floor-to-ceiling glazed double door. */
function DoubleDoor({ u }: { u: number }) {
  const mid = u + 0.045;
  return (
    <>
      <Path d={sQuad(b, u, 0.04, u + 0.09, 0.82)} fill={ISO.glassDoor} />
      <Line x1={S(b, mid, 0.05)[0]} y1={S(b, mid, 0.05)[1]} x2={S(b, mid, 0.81)[0]} y2={S(b, mid, 0.81)[1]} stroke={ISO.glassSide} strokeWidth={0.8} />
    </>
  );
}

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      {/* ground shadow */}
      <Path d={ground(b)} fill={ISO.shadow} stroke={ISO.shadow} strokeWidth={4} strokeLinejoin="round" opacity={0.16} />
      {/* LOW, slim underframe — the body hugs the rails, no bumper mass */}
      <Path d={fQuad(b, 0.05, -0.02, 0.95, 0.045)} fill={ISO.under} />
      <Path d={sQuad(b, 0.01, -0.02, 0.96, 0.045)} fill={ISO.under} />
      {/* flat continuous roof with AC modules */}
      <Path d={rQuad(b, 0, 0, 1, 1)} fill={ISO.whiteRoof} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={rQuad(b, 0.3, 0.14, 0.72, 0.26)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} strokeLinejoin="round" />
      <Path d={rQuad(b, 0.3, 0.46, 0.72, 0.58)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} strokeLinejoin="round" />
      <Path d={rQuad(b, 0.3, 0.76, 0.72, 0.88)} fill={ISO.grey} stroke={ISO.greySide} strokeWidth={0.8} strokeLinejoin="round" />
      <Path d={PANTO} stroke={ISO.charcoal} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d={PANTO_BAR} stroke={ISO.charcoal} strokeWidth={1.7} strokeLinecap="round" fill="none" />
      {/* side: white shell, continuous glazing, five glassy double doors */}
      <Path d={SIDE_BODY} fill={ISO.whiteSide} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.02, 0.42, 0.955, 0.82)} fill={ISO.glassSide} />
      <DoubleDoor u={0.045} />
      <DoubleDoor u={0.235} />
      <DoubleDoor u={0.425} />
      <DoubleDoor u={0.615} />
      <DoubleDoor u={0.805} />
      {/* four hairline articulation joints (five sections) */}
      <Path d={sQuad(b, 0.185, 0.06, 0.2, 0.95)} fill={ISO.under} opacity={0.85} />
      <Path d={sQuad(b, 0.375, 0.06, 0.39, 0.95)} fill={ISO.under} opacity={0.85} />
      <Path d={sQuad(b, 0.565, 0.06, 0.58, 0.95)} fill={ISO.under} opacity={0.85} />
      <Path d={sQuad(b, 0.755, 0.06, 0.77, 0.95)} fill={ISO.under} opacity={0.85} />
      {/* red PID stripe accents along the side */}
      <Path d={sQuad(b, 0, 0.85, 0.965, 0.895)} fill={ISO.redSide} />
      <Path d={sQuad(b, 0, 0.06, 0.965, 0.095)} fill={ISO.redSide} />
      {/* front face: white, minimal */}
      <Path d={FRONT_BODY} fill={ISO.white} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      {/* slim red stripe accent above the skirt */}
      <Path d={fQuad(b, 0, 0.065, 1, 0.1)} fill={ISO.red} />
      {/* black mask + the TALL windscreen */}
      <Path d={MASK} fill="#23262C" stroke="#23262C" strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={GLASS} fill={ISO.glass} stroke={ISO.glass} strokeWidth={1.4} strokeLinejoin="round" />
      <Path d={poly(F(b, 0.56, 0.18), F(b, 0.7, 0.18), F(b, 0.44, 0.92), F(b, 0.33, 0.9))} fill={ISO.glint} opacity={0.24} />
      <Path d={poly(F(b, 0.76, 0.18), F(b, 0.81, 0.18), F(b, 0.55, 0.92), F(b, 0.51, 0.92))} fill={ISO.glint} opacity={0.16} />
      <Circle cx={F(b, 0.79, 0.84)[0]} cy={F(b, 0.79, 0.84)[1]} r={1.2} fill={ISO.glint} opacity={0.85} />
      {/* full-width LED destination at the roofline (inside the mask top) */}
      <Path d={fQuad(b, 0.22, 0.938, 0.42, 0.972)} fill={ISO.amber} opacity={0.95} />
      <Path d={fQuad(b, 0.48, 0.938, 0.78, 0.972)} fill={ISO.amber} opacity={0.95} />
      {/* slim horizontal LED strips flanking the LOWER windscreen */}
      <Path d={fQuad(b, 0.005, 0.205, 0.072, 0.24)} fill="#E4F4FD" stroke="#E4F4FD" strokeWidth={0.6} strokeLinejoin="round" />
      <Path d={fQuad(b, 0.928, 0.205, 0.995, 0.24)} fill="#E4F4FD" stroke="#E4F4FD" strokeWidth={0.6} strokeLinejoin="round" />
      {/* echo of the DRL strips just inside the mask */}
      <Path d={fQuad(b, 0.095, 0.205, 0.135, 0.235)} fill="#DFF0FA" opacity={0.9} />
      <Path d={fQuad(b, 0.865, 0.205, 0.905, 0.235)} fill="#DFF0FA" opacity={0.9} />
    </Svg>
  );
}
