// Tatra T3 — the 1960s classic. THE SHAPE (from t3-34.jpg): a rounded cream
// "bun" on a LONG car — the flank dominates, the face is narrow. The
// windscreen leans gently backwards, above the destination header the whole
// nose ROLLS OVER into the roof in one big radius, and the face BULGES toward
// the viewer in plan (bowed bottom edge, belt and glass) — never a flat
// vertical slab. Rear end is rounded too. Livery: cream body, red belt band,
// two big round chrome headlights in the red, chrome bumper smile, blue
// route-number box perched on the crown, ribbed canvas roof, diamond panto.
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { diamond, diamondBar, F, fQuad, ISO, isoBox, N3, P, poly, SHORT_W, sQuad, VB } from './lib';
import { Stage } from './stage';

export const b = isoBox(SHORT_W);
const np = (a: number, d: number, z: number) => P(N3(b, a, d, z));
const f = (u: number, v: number) => P(F(b, u, v));

// ── Shared T3-family shell (t3 / t3rp / t3rplf are the same body) ────────────
// Nose profile: vertical to the windscreen base (z 0.5), gentle rake to the
// header top (z 0.86, 2.2px back), then the crown rolls over to the roof
// front edge 6.5px back. The cap plane continues the roll above the header.
export const bunD = (z: number): number => (z <= 0.5 ? 0 : (2.2 * (z - 0.5)) / 0.36);
export const capD = (z: number): number => 2.2 + (4.3 * (z - 0.86)) / 0.14;
export const BP = (a: number, z: number) => N3(b, a, bunD(z), z);
const bp = (a: number, z: number) => P(BP(a, z));

// Front: bowed bottom edge (the bun bulges toward the viewer), raked screen
// zone, big rounded crown.
export const BUN_FRONT = `M${np(0, 0, 0.07)} Q${np(0.5, -1.8, 0.07)} ${np(1, 0, 0.07)} L${np(1, 0, 0.5)} L${np(1, 2.2, 0.86)} Q${np(1, 5.6, 0.99)} ${np(0.85, 6.5, 1)} L${np(0.15, 6.5, 1)} Q${np(0, 5.6, 0.99)} ${np(0, 2.2, 0.86)} L${np(0, 0, 0.5)} Z`;
// Rounded cowl between the (bowed) header line and the roof edge.
export const BUN_CAP = `M${np(0, 2.2, 0.86)} Q${np(0.5, 1, 0.86)} ${np(1, 2.2, 0.86)} Q${np(1, 5.6, 0.99)} ${np(0.85, 6.5, 1)} L${np(0.15, 6.5, 1)} Q${np(0, 5.6, 0.99)} ${np(0, 2.2, 0.86)} Z`;
// Flank: nose profile up front, bulged rounded rear.
export const BUN_SIDE = `M${np(0, 0, 0.07)} L${np(0, 32.5, 0.07)} Q${np(0, 36.7, 0.52)} ${np(0, 31.5, 1)} L${np(0, 6.5, 1)} Q${np(0, 5.6, 0.99)} ${np(0, 2.2, 0.86)} L${np(0, 0, 0.5)} Z`;
// Roof plate: starts at the crown edge, skewed rear ≈ rounded end.
export const BUN_ROOF = `M${np(0, 6.2, 1)} L${np(1, 6.2, 1)} L${np(1, 32, 1)} L${np(0, 31.5, 1)} Z`;
// Windscreen ON the raked plane, bulging with the nose (bowed edges).
export const BUN_SCREEN = `M${np(0.06, 0, 0.52)} Q${np(0.5, -1.2, 0.52)} ${np(0.94, 0, 0.52)} L${np(0.94, 1.75, 0.82)} Q${np(0.94, 2.18, 0.855)} ${np(0.85, 2.18, 0.855)} Q${np(0.5, 0.95, 0.855)} ${np(0.15, 2.18, 0.855)} Q${np(0.06, 2.18, 0.855)} ${np(0.06, 1.75, 0.82)} Z`;
/** Windscreen center mullion (t3/t3rp two-piece glass). */
export const BUN_MULLION = { x1: N3(b, 0.5, -1, 0.545)[0], y1: N3(b, 0.5, -1, 0.545)[1], x2: N3(b, 0.5, 0.8, 0.845)[0], y2: N3(b, 0.5, 0.8, 0.845)[1] };

/** Underframe + the two end bogies every T3-family car shows. */
export function BunChassis() {
  return (
    <>
      <Path d={fQuad(b, 0.05, -0.03, 0.95, 0.08)} fill={ISO.under} />
      <Path d={sQuad(b, 0, -0.03, 0.93, 0.08)} fill={ISO.under} />
      <Path d={sQuad(b, 0.12, -0.08, 0.32, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0.64, -0.08, 0.84, 0.02)} fill={ISO.outline} stroke={ISO.outline} strokeWidth={2} strokeLinejoin="round" />
    </>
  );
}

/** Wrap-around cab corner pane spilling from the windscreen onto the side. */
export function BunCornerGlass() {
  return <Path d={sQuad(b, 0.02, 0.52, 0.1, 0.85)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1} strokeLinejoin="round" />;
}

// ── T3-specific bits ─────────────────────────────────────────────────────────
// Red belt wrapping the nose: bowed top under the glass, shallow V below.
const APRON = `M${np(0.02, 0, 0.5)} Q${np(0.5, -1.6, 0.5)} ${np(0.98, 0, 0.5)} L${np(0.98, 0, 0.19)} Q${np(0.5, -1.8, 0.1)} ${np(0.02, 0, 0.19)} Z`;
// Little blue route-number box perched on the crown.
const BLUE_BOX = poly(N3(b, 0.38, 7.2, 1.005), N3(b, 0.62, 7.2, 1.005), N3(b, 0.62, 7.2, 1.17), N3(b, 0.38, 7.2, 1.17));

const pantoM = N3(b, 0.5, 18, 1);

/** Standard side window sitting in the cream band. */
function SideGlass({ u0, u1 }: { u0: number; u1: number }) {
  return <Path d={sQuad(b, u0, 0.54, u1, 0.86)} fill={ISO.glassSide} stroke={ISO.glassSide} strokeWidth={1.1} strokeLinejoin="round" />;
}

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox={VB}>
      <Stage b={b} />
      <BunChassis />
      {/* roof plate + pale ribbed canvas cover */}
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
      {/* flank: cream body, red belt below the windows, cream skirt */}
      <Path d={BUN_SIDE} fill={ISO.creamSide} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d={sQuad(b, 0, 0.19, 0.95, 0.52)} fill={ISO.redSide} />
      <Path d={sQuad(b, 0, 0.5, 0.95, 0.52)} fill={ISO.maroon} opacity={0.5} />
      {/* door – window – window – door – window – door */}
      <Path d={sQuad(b, 0.13, 0.14, 0.23, 0.86)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.2} strokeLinejoin="round" />
      <SideGlass u0={0.27} u1={0.38} />
      <SideGlass u0={0.42} u1={0.53} />
      <Path d={sQuad(b, 0.57, 0.14, 0.67, 0.86)} fill={ISO.glassDoor} stroke={ISO.glassDoor} strokeWidth={1.2} strokeLinejoin="round" />
      <SideGlass u0={0.71} u1={0.82} />
      <SideGlass u0={0.86} u1={0.92} />
      {/* front — cream bun rolling into the roof */}
      <Path d={BUN_FRONT} fill={ISO.cream} stroke={ISO.outline} strokeWidth={1.2} strokeLinejoin="round" />
      {/* red belt wraps the nose, shallow V toward the coupler */}
      <Path d={APRON} fill={ISO.red} />
      <Path d={`M${np(0.02, 0, 0.19)} Q${np(0.5, -1.8, 0.1)} ${np(0.98, 0, 0.19)}`} stroke={ISO.maroon} strokeWidth={0.8} fill="none" opacity={0.55} />
      {/* wrap-around glass: corner pane spilling onto the side */}
      <BunCornerGlass />
      <Path d={BUN_SCREEN} fill={ISO.glass} stroke={ISO.glass} strokeWidth={1.3} strokeLinejoin="round" />
      <Line x1={BUN_MULLION.x1} y1={BUN_MULLION.y1} x2={BUN_MULLION.x2} y2={BUN_MULLION.y2} stroke={ISO.cream} strokeWidth={1.1} />
      <Path d={poly(BP(0.6, 0.55), BP(0.73, 0.55), BP(0.5, 0.84), BP(0.39, 0.84))} fill={ISO.glint} opacity={0.26} />
      <Circle cx={BP(0.8, 0.78)[0]} cy={BP(0.8, 0.78)[1]} r={1.1} fill={ISO.glint} opacity={0.85} />
      {/* rounded cowl over the header — the roll-over that makes it a bun */}
      <Path d={BUN_CAP} fill={ISO.creamRoof} stroke={ISO.outline} strokeWidth={1} strokeLinejoin="round" />
      {/* white destination window on the cowl */}
      <Path d={poly(N3(b, 0.32, capD(0.875) - 1, 0.875), N3(b, 0.68, capD(0.875) - 1, 0.875), N3(b, 0.68, capD(0.945), 0.945), N3(b, 0.32, capD(0.945), 0.945))} fill="#FDFBF4" stroke="#C9BD9F" strokeWidth={0.8} strokeLinejoin="round" />
      {/* little BLUE route-number box perched on the crown (classic tell) */}
      <Path d={BLUE_BOX} fill={ISO.blue} stroke="#163B78" strokeWidth={1} strokeLinejoin="round" />
      <Path d={poly(N3(b, 0.44, 7.2, 1.04), N3(b, 0.49, 7.2, 1.04), N3(b, 0.49, 7.2, 1.13), N3(b, 0.44, 7.2, 1.13))} fill="#FFFFFF" opacity={0.95} />
      <Path d={poly(N3(b, 0.52, 7.2, 1.04), N3(b, 0.57, 7.2, 1.04), N3(b, 0.57, 7.2, 1.13), N3(b, 0.52, 7.2, 1.13))} fill="#FFFFFF" opacity={0.95} />
      {/* two BIG round chrome-ringed headlights in the red */}
      <Circle cx={N3(b, 0.24, -0.9, 0.33)[0]} cy={N3(b, 0.24, -0.9, 0.33)[1]} r={3} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.4} />
      <Circle cx={N3(b, 0.76, -0.9, 0.33)[0]} cy={N3(b, 0.76, -0.9, 0.33)[1]} r={3} fill={ISO.warm} stroke={ISO.chrome} strokeWidth={1.4} />
      <Circle cx={N3(b, 0.27, -0.9, 0.37)[0]} cy={N3(b, 0.27, -0.9, 0.37)[1]} r={0.9} fill="#FFFFFF" opacity={0.9} />
      <Circle cx={N3(b, 0.79, -0.9, 0.37)[0]} cy={N3(b, 0.79, -0.9, 0.37)[1]} r={0.9} fill="#FFFFFF" opacity={0.9} />
      {/* chrome bumper smile on the cream skirt */}
      <Path d={`M${f(0.08, 0.12)} Q${np(0.5, -2, 0.03)} ${f(0.92, 0.12)}`} stroke={ISO.chrome} strokeWidth={1.8} strokeLinecap="round" fill="none" />
    </Svg>
  );
}
