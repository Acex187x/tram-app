// Tatra T3R.PLF — the champagne-silver T3 (ref 8269). Same rounded BUN shell
// as the T3 (imported from ./t3) — raked windscreen, crown rolled into the
// roof — but a SILVER shell with the dark-wine package: one smooth SINGLE
// curved windscreen (no divider), a WINE cowl ringing the roof edge, an
// orange LED header, and a wine bib low on the nose made of two rounded lobes
// holding the chrome headlights. Flank: wine belt with silver slashes and the
// WIDE low-floor center door. Roof carries the boxy AC unit.
import Svg, { Circle, Path } from 'react-native-svg';

import { diamond, diamondBar, F, ISO, N3, P, poly, sQuad, VB } from './lib';
import { Stage } from './stage';
import { b, BP, BUN_CAP, BUN_FRONT, BUN_ROOF, BUN_SCREEN, BUN_SIDE, BunChassis, BunCornerGlass, capD } from './t3';

const f = (u: number, v: number) => P(F(b, u, v));
const np = (a: number, d: number, z: number) => P(N3(b, a, d, z));

// Wine bib: two rounded lobes hanging low on the nose, lifted at the center.
const BIB = `M${np(0.02, 0, 0.4)} Q${np(0.5, -1.5, 0.4)} ${np(0.98, 0, 0.4)} L${f(0.98, 0.28)} Q${f(0.93, 0.1)} ${f(0.76, 0.11)} Q${np(0.55, -1.6, 0.13)} ${np(0.5, -1.6, 0.3)} Q${np(0.45, -1.6, 0.13)} ${f(0.24, 0.11)} Q${f(0.07, 0.1)} ${f(0.02, 0.28)} Z`;
// Silver slashes cutting through the wine flank band toward the rear.
const SLASH1 = poly(N3(b, 0, 20.4, 0.22), N3(b, 0, 22.5, 0.22), N3(b, 0, 25.2, 0.54), N3(b, 0, 23.1, 0.54));
const SLASH2 = poly(N3(b, 0, 24.5, 0.22), N3(b, 0, 26.6, 0.22), N3(b, 0, 29.4, 0.54), N3(b, 0, 27.3, 0.54));

const pantoM = N3(b, 0.5, 19, 1);

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      <Stage b={b} />
      <BunChassis />
      {/* smooth silver roof + boxy AC unit up front */}
      <Path d={BUN_ROOF} fill={ISO.silverRoof} stroke={ISO.outline} strokeWidth={1.1} strokeLinejoin="round" />
      <Path d={poly(N3(b, 0.18, 8.5, 1), N3(b, 0.82, 8.5, 1), N3(b, 0.82, 15.5, 1), N3(b, 0.18, 15.5, 1))} fill="#CFCBBF" stroke={ISO.silverSide} strokeWidth={0.9} strokeLinejoin="round" />
      {/* yellow DIAMOND scissor pantograph */}
      <Path d={diamond(pantoM)} stroke={ISO.pantoY} strokeWidth={1.4} strokeLinejoin="round" fill="none" />
      <Path d={diamondBar(pantoM)} stroke={ISO.charcoal} strokeWidth={1.6} strokeLinecap="round" fill="none" />
      {/* flank: champagne-silver shell + wine belt and swooshes */}
      <Path d={BUN_SIDE} fill={ISO.silverSide} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0, 0.22, 0.94, 0.54)} fill={ISO.wineSide} />
      <Path d={SLASH1} fill={ISO.silverSide} />
      <Path d={SLASH2} fill={ISO.silverSide} />
      {/* front door – window – WIDE low-floor center door – window – rear door */}
      <Path d={sQuad(b, 0.055, 0.14, 0.16, 0.86)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.2, 0.54, 0.35, 0.86)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.1} strokeLinejoin="round" />
      {/* the LOW-FLOOR plug door: glass drops well below the belt line */}
      <Path d={sQuad(b, 0.4, 0.06, 0.56, 0.86)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.61, 0.54, 0.76, 0.86)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.1} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.8, 0.14, 0.88, 0.86)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.2} strokeLinejoin="round" />
      {/* front — silver bun */}
      <Path d={BUN_FRONT} fill={ISO.silver} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      {/* wine bib lobes + silver center wedge */}
      <Path d={BIB} fill={ISO.wine} />
      {/* smooth SINGLE curved windscreen (no divider) + corner spill */}
      <BunCornerGlass />
      <Path d={BUN_SCREEN} fill={ISO.glass} stroke={ISO.glass} strokeWidth={1.3} strokeLinejoin="round" />
      <Path d={poly(BP(0.58, 0.55), BP(0.72, 0.55), BP(0.5, 0.84), BP(0.38, 0.84))} fill={ISO.glint} opacity={0.28} />
      <Circle cx={BP(0.8, 0.78)[0]} cy={BP(0.8, 0.78)[1]} r={1.1} fill={ISO.glint} opacity={0.85} />
      {/* WINE cowl ringing the roof edge, orange LED header set into it */}
      <Path d={BUN_CAP} fill={ISO.wine} stroke={ISO.wineSide} strokeWidth={1} strokeLinejoin="round" />
      <Path d={poly(N3(b, 0.18, capD(0.878) - 1, 0.878), N3(b, 0.82, capD(0.878) - 1, 0.878), N3(b, 0.82, capD(0.942), 0.942), N3(b, 0.18, capD(0.942), 0.942))} fill={ISO.charcoal} strokeLinejoin="round" />
      <Path d={poly(N3(b, 0.21, capD(0.89) - 1, 0.89), N3(b, 0.33, capD(0.89) - 1, 0.89), N3(b, 0.33, capD(0.93), 0.93), N3(b, 0.21, capD(0.93), 0.93))} fill={ISO.ledOrange} opacity={0.95} />
      <Path d={poly(N3(b, 0.4, capD(0.89) - 1, 0.89), N3(b, 0.78, capD(0.89) - 1, 0.89), N3(b, 0.78, capD(0.93), 0.93), N3(b, 0.4, capD(0.93), 0.93))} fill={ISO.ledOrange} opacity={0.85} />
      {/* round chrome headlights nested in the wine lobes */}
      <Circle cx={N3(b, 0.25, -0.9, 0.25)[0]} cy={N3(b, 0.25, -0.9, 0.25)[1]} r={2.9} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.4} />
      <Circle cx={N3(b, 0.75, -0.9, 0.25)[0]} cy={N3(b, 0.75, -0.9, 0.25)[1]} r={2.9} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.4} />
      <Circle cx={N3(b, 0.28, -0.9, 0.29)[0]} cy={N3(b, 0.28, -0.9, 0.29)[1]} r={0.9} fill="#FFFFFF" opacity={0.9} />
      <Circle cx={N3(b, 0.78, -0.9, 0.29)[0]} cy={N3(b, 0.78, -0.9, 0.29)[1]} r={0.9} fill="#FFFFFF" opacity={0.9} />
      {/* silver skirt lip */}
      <Path d={`M${f(0.07, 0.09)} Q${np(0.5, -2, 0.02)} ${f(0.93, 0.09)}`} stroke={ISO.chrome} strokeWidth={1.6} strokeLinecap="round" fill="none" />
    </Svg>
  );
}
