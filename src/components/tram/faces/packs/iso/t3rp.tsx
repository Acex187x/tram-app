// Tatra T3R.P — the modernized classic (ref 8326): identical cream bun
// silhouette, but the header is a DARK box with an orange LED route number +
// destination (no little blue box on the roof), the red belt drops much
// deeper — red runs from the window sills down to a chunky DARK bumper — and
// the round chrome headlights ride lower, just above the bumper. Diamond
// scissor pantograph like every Tatra.
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { diamond, diamondBar, F, fQuad, ISO, isoBox, P, poly, R, rQuad, S, SHORT_W, sQuad, VB } from './lib';
import { Stage } from './stage';

const b = isoBox(SHORT_W);
const f = (u: number, v: number) => P(F(b, u, v));
const s = (u: number, v: number) => P(S(b, u, v));

const FRONT_BODY = `M${f(0, 0.07)} L${f(1, 0.07)} L${f(1, 0.72)} Q${f(1, 1.035)} ${f(0.64, 1.015)} L${f(0.36, 1.015)} Q${f(0, 1.035)} ${f(0, 0.72)} Z`;
const SIDE_BODY = `M${s(0, 0.07)} L${s(0.93, 0.07)} Q${s(1.05, 0.52)} ${s(0.9, 1)} L${s(0, 1)} Z`;
const WINDSCREEN = `M${f(0.09, 0.5)} L${f(0.91, 0.5)} L${f(0.91, 0.74)} Q${f(0.91, 0.88)} ${f(0.79, 0.88)} L${f(0.21, 0.88)} Q${f(0.09, 0.88)} ${f(0.09, 0.74)} Z`;
// Deep red apron: from the glass all the way down to the bumper.
const APRON = `M${f(0.02, 0.5)} L${f(0.98, 0.5)} L${f(0.98, 0.12)} Q${f(0.5, 0.07)} ${f(0.02, 0.12)} Z`;

const pantoM = R(b, 0.5, 0.45);

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
      {/* flank: cream window band, DEEP red belt down to the dark trim */}
      <Path d={SIDE_BODY} fill={ISO.creamSide} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0, 0.1, 0.94, 0.5)} fill={ISO.redSide} />
      <Path d={sQuad(b, 0, 0.07, 0.93, 0.11)} fill={ISO.charcoal} />
      {/* door – window – window – door – window – door */}
      <SideGlass u0={0.055} u1={0.165} door />
      <SideGlass u0={0.205} u1={0.315} />
      <SideGlass u0={0.355} u1={0.465} />
      <SideGlass u0={0.505} u1={0.615} door />
      <SideGlass u0={0.655} u1={0.765} />
      <SideGlass u0={0.805} u1={0.9} door />
      {/* front — cream bun with a deep red face */}
      <Path d={FRONT_BODY} fill={ISO.cream} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={APRON} fill={ISO.red} />
      {/* chunky dark bumper under the red */}
      <Path d={`M${f(0.03, 0.12)} Q${f(0.5, 0.05)} ${f(0.97, 0.12)} L${f(0.97, 0.06)} L${f(0.03, 0.06)} Z`} fill={ISO.charcoal} />
      {/* wrap-around glass + corner pane */}
      <Path d={sQuad(b, 0.015, 0.52, 0.085, 0.87)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.1} strokeLinejoin="round" />
      <Path d={WINDSCREEN} fill={ISO.glass} stroke={ISO.glass} strokeWidth={1.4} strokeLinejoin="round" />
      <Line x1={F(b, 0.5, 0.51)[0]} y1={F(b, 0.5, 0.51)[1]} x2={F(b, 0.5, 0.875)[0]} y2={F(b, 0.5, 0.875)[1]} stroke={ISO.cream} strokeWidth={1.1} />
      <Path d={poly(F(b, 0.6, 0.51), F(b, 0.73, 0.51), F(b, 0.5, 0.87), F(b, 0.39, 0.87))} fill={ISO.glint} opacity={0.26} />
      <Circle cx={F(b, 0.8, 0.8)[0]} cy={F(b, 0.8, 0.8)[1]} r={1.1} fill={ISO.glint} opacity={0.85} />
      {/* DARK header with orange LED route + destination (the T3R.P tell) */}
      <Path d={fQuad(b, 0.08, 0.9, 0.92, 1.0)} fill="#23262B" stroke="#23262B" strokeWidth={1} strokeLinejoin="round" />
      <Path d={fQuad(b, 0.14, 0.925, 0.26, 0.977)} fill={ISO.ledOrange} />
      <Path d={fQuad(b, 0.33, 0.925, 0.86, 0.977)} fill={ISO.ledOrange} opacity={0.85} />
      {/* round chrome headlights riding LOW, just above the bumper */}
      <Circle cx={F(b, 0.24, 0.26)[0]} cy={F(b, 0.24, 0.26)[1]} r={3} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.4} />
      <Circle cx={F(b, 0.76, 0.26)[0]} cy={F(b, 0.76, 0.26)[1]} r={3} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.4} />
      <Circle cx={F(b, 0.27, 0.3)[0]} cy={F(b, 0.27, 0.3)[1]} r={0.9} fill="#FFFFFF" opacity={0.9} />
      <Circle cx={F(b, 0.79, 0.3)[0]} cy={F(b, 0.79, 0.3)[1]} r={0.9} fill="#FFFFFF" opacity={0.9} />
    </Svg>
  );
}
