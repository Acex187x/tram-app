// Tatra T3 — the 1960s classic, drawn from the refs: rounded cream "bun" with
// a two-piece wrap-around windscreen, cream header carrying the destination
// window and the little BLUE route-number box perched on the roof, a red belt
// band below the windows that wraps the whole car (cream skirt under it), two
// BIG round chrome-ringed headlights sitting IN the red, chrome bumper smile,
// pale canvas roof with ribs and the yellow DIAMOND scissor pantograph.
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { diamond, diamondBar, F, fQuad, ISO, isoBox, P, poly, R, rQuad, S, SHORT_W, sQuad, VB } from './lib';
import { Stage } from './stage';

const b = isoBox(SHORT_W);
const f = (u: number, v: number) => P(F(b, u, v));
const s = (u: number, v: number) => P(S(b, u, v));

// Rounded bun: generous crown rounding, soft rear.
const FRONT_BODY = `M${f(0, 0.07)} L${f(1, 0.07)} L${f(1, 0.72)} Q${f(1, 1.035)} ${f(0.64, 1.015)} L${f(0.36, 1.015)} Q${f(0, 1.035)} ${f(0, 0.72)} Z`;
const SIDE_BODY = `M${s(0, 0.07)} L${s(0.93, 0.07)} Q${s(1.05, 0.52)} ${s(0.9, 1)} L${s(0, 1)} Z`;
// Two-piece windscreen with rounded top corners.
const WINDSCREEN = `M${f(0.09, 0.5)} L${f(0.91, 0.5)} L${f(0.91, 0.74)} Q${f(0.91, 0.88)} ${f(0.79, 0.88)} L${f(0.21, 0.88)} Q${f(0.09, 0.88)} ${f(0.09, 0.74)} Z`;
// Red belt wrapping the nose: straight top under the glass, shallow V below.
const APRON = `M${f(0.02, 0.5)} L${f(0.98, 0.5)} L${f(0.98, 0.19)} Q${f(0.5, 0.1)} ${f(0.02, 0.19)} Z`;

const pantoM = R(b, 0.5, 0.45);

/** Side window (v 0.54–0.86) or full-height folding door. */
function SideGlass({ u0, u1, door = false }: { u0: number; u1: number; door?: boolean }) {
  return door ? (
    <>
      <Path d={sQuad(b, u0, 0.14, u1, 0.86)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.2} strokeLinejoin="round" />
      <Line
        x1={S(b, (u0 + u1) / 2, 0.15)[0]}
        y1={S(b, (u0 + u1) / 2, 0.15)[1]}
        x2={S(b, (u0 + u1) / 2, 0.85)[0]}
        y2={S(b, (u0 + u1) / 2, 0.85)[1]}
        stroke={ISO.glassSide}
        strokeWidth={0.8}
      />
    </>
  ) : (
    <Path d={sQuad(b, u0, 0.54, u1, 0.86)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.1} strokeLinejoin="round" />
  );
}

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      <Stage b={b} />
      {/* underframe + two visible bogies */}
      <Path d={fQuad(b, 0.03, -0.03, 0.97, 0.08)} fill={ISO.under} />
      <Path d={sQuad(b, 0, -0.03, 0.93, 0.08)} fill={ISO.under} />
      <Path d={sQuad(b, 0.12, -0.08, 0.32, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.64, -0.08, 0.84, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      {/* roof: cream body rim curving into the pale canvas cover */}
      <Path d={rQuad(b, 0, 0, 1, 1)} fill={ISO.creamRoof} stroke={ISO.outline} strokeWidth={1.1} strokeLinejoin="round" />
      <Path d={rQuad(b, 0.08, 0.06, 0.92, 0.94)} fill="#D3CDBB" stroke="#BFB8A2" strokeWidth={0.8} strokeLinejoin="round" />
      {[0.3, 0.55, 0.8].map((v) => (
        <Line
          key={v}
          x1={R(b, 0.14, v)[0]}
          y1={R(b, 0.14, v)[1]}
          x2={R(b, 0.86, v)[0]}
          y2={R(b, 0.86, v)[1]}
          stroke="#B9B29D"
          strokeWidth={0.9}
        />
      ))}
      {/* yellow DIAMOND scissor pantograph */}
      <Path d={diamond(pantoM)} stroke={ISO.pantoY} strokeWidth={1.4} strokeLinejoin="round" fill="none" />
      <Path d={diamondBar(pantoM)} stroke={ISO.charcoal} strokeWidth={1.6} strokeLinecap="round" fill="none" />
      {/* flank: cream body, red belt below the windows, cream skirt */}
      <Path d={SIDE_BODY} fill={ISO.creamSide} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0, 0.17, 0.94, 0.5)} fill={ISO.redSide} />
      <Path d={sQuad(b, 0, 0.48, 0.94, 0.5)} fill={ISO.maroon} opacity={0.5} />
      {/* door – window – window – door – window – door */}
      <SideGlass u0={0.055} u1={0.165} door />
      <SideGlass u0={0.205} u1={0.315} />
      <SideGlass u0={0.355} u1={0.465} />
      <SideGlass u0={0.505} u1={0.615} door />
      <SideGlass u0={0.655} u1={0.765} />
      <SideGlass u0={0.805} u1={0.9} door />
      {/* front — cream bun */}
      <Path d={FRONT_BODY} fill={ISO.cream} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      {/* red belt wraps the nose, shallow V toward the coupler */}
      <Path d={APRON} fill={ISO.red} />
      <Path d={`M${f(0.02, 0.19)} Q${f(0.5, 0.1)} ${f(0.98, 0.19)}`} stroke={ISO.maroon} strokeWidth={0.8} fill="none" opacity={0.55} />
      {/* wrap-around glass: corner pane spilling onto the side */}
      <Path d={sQuad(b, 0.015, 0.52, 0.085, 0.87)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.1} strokeLinejoin="round" />
      <Path d={WINDSCREEN} fill={ISO.glass} stroke={ISO.glass} strokeWidth={1.4} strokeLinejoin="round" />
      <Line x1={F(b, 0.5, 0.51)[0]} y1={F(b, 0.5, 0.51)[1]} x2={F(b, 0.5, 0.875)[0]} y2={F(b, 0.5, 0.875)[1]} stroke={ISO.cream} strokeWidth={1.1} />
      <Path d={poly(F(b, 0.6, 0.51), F(b, 0.73, 0.51), F(b, 0.5, 0.87), F(b, 0.39, 0.87))} fill={ISO.glint} opacity={0.26} />
      <Circle cx={F(b, 0.8, 0.8)[0]} cy={F(b, 0.8, 0.8)[1]} r={1.1} fill={ISO.glint} opacity={0.85} />
      {/* cream header: white destination window over the glass */}
      <Path d={fQuad(b, 0.3, 0.9, 0.7, 0.99)} fill="#FDFBF4" stroke="#C9BD9F" strokeWidth={0.8} strokeLinejoin="round" />
      {/* little BLUE route-number box perched on the roof (classic tell) */}
      <Path d={fQuad(b, 0.36, 1.01, 0.64, 1.18)} fill={ISO.blue} stroke="#163B78" strokeWidth={1} strokeLinejoin="round" />
      <Path d={fQuad(b, 0.44, 1.05, 0.49, 1.14)} fill="#FFFFFF" opacity={0.95} />
      <Path d={fQuad(b, 0.52, 1.05, 0.57, 1.14)} fill="#FFFFFF" opacity={0.95} />
      {/* two BIG round chrome-ringed headlights in the red */}
      <Circle cx={F(b, 0.24, 0.33)[0]} cy={F(b, 0.24, 0.33)[1]} r={3} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.4} />
      <Circle cx={F(b, 0.76, 0.33)[0]} cy={F(b, 0.76, 0.33)[1]} r={3} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.4} />
      <Circle cx={F(b, 0.27, 0.37)[0]} cy={F(b, 0.27, 0.37)[1]} r={0.9} fill="#FFFFFF" opacity={0.9} />
      <Circle cx={F(b, 0.79, 0.37)[0]} cy={F(b, 0.79, 0.37)[1]} r={0.9} fill="#FFFFFF" opacity={0.9} />
      {/* chrome bumper smile on the cream skirt */}
      <Path d={`M${f(0.08, 0.11)} Q${f(0.5, 0.03)} ${f(0.92, 0.11)}`} stroke={ISO.chrome} strokeWidth={1.8} strokeLinecap="round" fill="none" />
    </Svg>
  );
}
