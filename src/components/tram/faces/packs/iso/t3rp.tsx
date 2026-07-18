// Tatra T3R.P — the modernized classic (ref 8326). Same rounded cream BUN
// shell as the T3 (imported from ./t3): raked windscreen, crown rolling into
// the roof, rounded rear. Its own tells: a DARK header with the green/orange
// LED route + destination (no blue roof box), the red belt drops much deeper
// (window sills down to a chunky dark bumper), and the chrome headlights ride
// low, just above the bumper. Diamond scissor pantograph like every Tatra.
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { diamond, diamondBar, F, ISO, N3, P, poly, sQuad, VB } from './lib';
import { Stage } from './stage';
import { b, BP, BUN_CAP, BUN_FRONT, BUN_MULLION, BUN_ROOF, BUN_SCREEN, BUN_SIDE, BunChassis, BunCornerGlass, capD } from './t3';

const f = (u: number, v: number) => P(F(b, u, v));
const np = (a: number, d: number, z: number) => P(N3(b, a, d, z));

// Deep red apron: from the glass all the way down to the bumper (bowed).
const APRON = `M${np(0.02, 0, 0.5)} Q${np(0.5, -1.6, 0.5)} ${np(0.98, 0, 0.5)} L${np(0.98, 0, 0.12)} Q${np(0.5, -1.8, 0.07)} ${np(0.02, 0, 0.12)} Z`;

const pantoM = N3(b, 0.5, 18, 1);

function SideGlass({ u0, u1 }: { u0: number; u1: number }) {
  return <Path d={sQuad(b, u0, 0.54, u1, 0.86)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.1} strokeLinejoin="round" />;
}

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      <Stage b={b} />
      <BunChassis />
      {/* roof plate + ribbed canvas cover */}
      <Path d={BUN_ROOF} fill={ISO.creamRoof} stroke={ISO.outline} strokeWidth={1.1} strokeLinejoin="round" />
      <Path d={poly(N3(b, 0.1, 8.5, 1), N3(b, 0.9, 8.5, 1), N3(b, 0.9, 29.5, 1), N3(b, 0.1, 29.5, 1))} fill="#D3CDBB" stroke="#BFB8A2" strokeWidth={0.8} strokeLinejoin="round" />
      {[13, 18, 23].map((d) => (
        <Line
          key={d}
          x1={N3(b, 0.12, d, 1)[0]}
          y1={N3(b, 0.12, d, 1)[1]}
          x2={N3(b, 0.88, d, 1)[0]}
          y2={N3(b, 0.88, d, 1)[1]}
          stroke="#B9B29D"
          strokeWidth={0.9}
        />
      ))}
      {/* yellow DIAMOND scissor pantograph */}
      <Path d={diamond(pantoM)} stroke={ISO.pantoY} strokeWidth={1.4} strokeLinejoin="round" fill="none" />
      <Path d={diamondBar(pantoM)} stroke={ISO.charcoal} strokeWidth={1.6} strokeLinecap="round" fill="none" />
      {/* flank: cream window band, DEEP red belt down to the dark trim */}
      <Path d={BUN_SIDE} fill={ISO.creamSide} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0, 0.1, 0.94, 0.52)} fill={ISO.redSide} />
      <Path d={sQuad(b, 0, 0.07, 0.93, 0.11)} fill={ISO.charcoal} />
      {/* door – window – window – door – window – door */}
      <Path d={sQuad(b, 0.13, 0.14, 0.23, 0.86)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.2} strokeLinejoin="round" />
      <SideGlass u0={0.27} u1={0.38} />
      <SideGlass u0={0.42} u1={0.53} />
      <Path d={sQuad(b, 0.57, 0.14, 0.67, 0.86)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.2} strokeLinejoin="round" />
      <SideGlass u0={0.71} u1={0.82} />
      <SideGlass u0={0.86} u1={0.92} />
      {/* front — cream bun with a deep red face */}
      <Path d={BUN_FRONT} fill={ISO.cream} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={APRON} fill={ISO.red} />
      {/* chunky dark bumper under the red */}
      <Path d={`M${np(0.03, 0, 0.12)} Q${np(0.5, -1.9, 0.05)} ${np(0.97, 0, 0.12)} L${f(0.97, 0.06)} L${f(0.03, 0.06)} Z`} fill={ISO.charcoal} />
      {/* wrap-around glass + corner pane */}
      <BunCornerGlass />
      <Path d={BUN_SCREEN} fill={ISO.glass} stroke={ISO.glass} strokeWidth={1.3} strokeLinejoin="round" />
      <Line x1={BUN_MULLION.x1} y1={BUN_MULLION.y1} x2={BUN_MULLION.x2} y2={BUN_MULLION.y2} stroke={ISO.cream} strokeWidth={1.1} />
      <Path d={poly(BP(0.6, 0.55), BP(0.73, 0.55), BP(0.5, 0.84), BP(0.39, 0.84))} fill={ISO.glint} opacity={0.26} />
      <Circle cx={BP(0.8, 0.78)[0]} cy={BP(0.8, 0.78)[1]} r={1.1} fill={ISO.glint} opacity={0.85} />
      {/* rounded cowl, carrying the DARK LED header (the T3R.P tell) */}
      <Path d={BUN_CAP} fill={ISO.creamRoof} stroke={ISO.outline} strokeWidth={1} strokeLinejoin="round" />
      <Path d={poly(N3(b, 0.1, capD(0.87) - 1, 0.87), N3(b, 0.9, capD(0.87) - 1, 0.87), N3(b, 0.9, capD(0.955), 0.955), N3(b, 0.1, capD(0.955), 0.955))} fill="#23262B" stroke="#23262B" strokeWidth={0.8} strokeLinejoin="round" />
      <Path d={poly(N3(b, 0.15, capD(0.885) - 1, 0.885), N3(b, 0.28, capD(0.885) - 1, 0.885), N3(b, 0.28, capD(0.938), 0.938), N3(b, 0.15, capD(0.938), 0.938))} fill={ISO.ledOrange} />
      <Path d={poly(N3(b, 0.35, capD(0.885) - 1, 0.885), N3(b, 0.85, capD(0.885) - 1, 0.885), N3(b, 0.85, capD(0.938), 0.938), N3(b, 0.35, capD(0.938), 0.938))} fill={ISO.ledOrange} opacity={0.85} />
      {/* round chrome headlights riding LOW, just above the bumper */}
      <Circle cx={N3(b, 0.24, -0.9, 0.26)[0]} cy={N3(b, 0.24, -0.9, 0.26)[1]} r={3} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.4} />
      <Circle cx={N3(b, 0.76, -0.9, 0.26)[0]} cy={N3(b, 0.76, -0.9, 0.26)[1]} r={3} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.4} />
      <Circle cx={N3(b, 0.27, -0.9, 0.3)[0]} cy={N3(b, 0.27, -0.9, 0.3)[1]} r={0.9} fill="#FFFFFF" opacity={0.9} />
      <Circle cx={N3(b, 0.79, -0.9, 0.3)[0]} cy={N3(b, 0.79, -0.9, 0.3)[1]} r={0.9} fill="#FFFFFF" opacity={0.9} />
    </Svg>
  );
}
