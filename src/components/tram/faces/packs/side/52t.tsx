// Side Profile pack — Škoda 52T ForCity Plus Praha: the glassy flagship.
// FIVE sections, white body with thin red PID stripes, TALL front glass
// sweeping from the low skirt into the roofline (dark mask, slim DRL strip),
// five wide floor-to-ceiling glazed doors, flat roof with AC modules,
// low small skirt — the sleekest, most minimal profile in the fleet.
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

const P = {
  plate: '#232932',
  edge: 'rgba(154,166,183,0.42)',
  rail: '#909CAD',
  wheel: '#3C434F',
  red: '#D5372E',
  glass: '#9AD4EA',
  glassDeep: '#6FB6D4',
  grey: '#7A828E',
  amber: '#FFB03A',
  dark: '#151A21',
  white: '#F4F5F3',
} as const;

const BODY =
  'M9 28.5 L58.8 28.5 Q60.8 28.5 60.8 30.5 L60.8 41.4 Q60.8 43 58.8 43 L5.6 43 Q4.2 43 4.2 41.4 L4.2 33 C4.2 30.2 6.2 28.5 9 28.5 Z';

function GlassDoor({ x }: { x: number }) {
  return (
    <>
      <Rect x={x} y={29.9} width={4.2} height={13.1} rx={0.5} fill={P.glassDeep} stroke={P.dark} strokeWidth={0.5} />
      <Line x1={x + 2.1} y1={30.3} x2={x + 2.1} y2={42.5} stroke={P.dark} strokeWidth={0.45} />
    </>
  );
}

function Joint({ x }: { x: number }) {
  return (
    <>
      <Rect x={x} y={28.6} width={1.4} height={14.4} fill={P.dark} opacity={0.85} />
      <Line x1={x + 0.7} y1={29.1} x2={x + 0.7} y2={42.5} stroke="#4A5260" strokeWidth={0.35} />
    </>
  );
}

export function Face({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Rect x={1.5} y={1.5} width={61} height={61} rx={14} fill={P.plate} stroke={P.edge} strokeWidth={1} />
      <Line x1={3} y1={46.2} x2={61} y2={46.2} stroke={P.rail} strokeWidth={1.1} strokeLinecap="round" />
      {/* single-arm pantograph */}
      <Path
        d="M36.8 28.3 L40.5 25 L43.3 25"
        stroke={P.rail}
        strokeWidth={1.1}
        strokeLinecap="round"
        fill="none"
      />
      <Line x1={41} y1={24.6} x2={45.4} y2={24.6} stroke={P.rail} strokeWidth={1.1} strokeLinecap="round" />
      {/* bogies */}
      <Circle cx={8.2} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={11.6} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={21.6} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={25} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={35.2} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={38.6} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={52.4} cy={44.6} r={1.6} fill={P.wheel} />
      <Circle cx={55.8} cy={44.6} r={1.6} fill={P.wheel} />
      {/* white body, flat continuous roofline */}
      <Path d={BODY} fill={P.white} />
      {/* thin red PID stripes: roofline + beltline */}
      <Rect x={10.9} y={28.9} width={49.5} height={0.55} fill={P.red} opacity={0.9} />
      <Rect x={10.9} y={37.3} width={49.5} height={1} fill={P.red} />
      {/* low SMALL skirt hugging the rails */}
      <Rect x={5.4} y={42.2} width={54.6} height={0.8} rx={0.4} fill={P.grey} opacity={0.85} />
      {/* roof AC modules */}
      <Rect x={17.5} y={27.4} width={5.4} height={1.15} rx={0.4} fill={P.grey} />
      <Rect x={30} y={27.4} width={5.4} height={1.15} rx={0.4} fill={P.grey} />
      <Rect x={42.5} y={27.4} width={5.4} height={1.15} rx={0.4} fill={P.grey} />
      {/* TALL windscreen: dark mask, glass from just above the skirt into the roofline */}
      <Path d="M4.85 41.2 L4.85 33 C4.85 30.7 6.4 29.35 9 29.25 L10.6 29.25 L10.6 41.2 Z" fill={P.dark} />
      <Path d="M5.55 40.5 L5.55 33.2 C5.55 31.3 6.9 30.05 9.2 29.95 L9.9 29.95 L9.9 40.5 Z" fill={P.glass} />
      {/* slim horizontal LED daytime-running strip, low beside the glass */}
      <Rect x={4.5} y={39.3} width={1.9} height={0.55} rx={0.27} fill="#FFF3D0" />
      {/* full-width LED destination at the top of the mask */}
      <Rect x={6.1} y={29.7} width={3.3} height={0.95} rx={0.3} fill={P.amber} />
      {/* five sections: four joints */}
      <Joint x={14.4} />
      <Joint x={26} />
      <Joint x={37.6} />
      <Joint x={49.2} />
      {/* one wide floor-to-ceiling glazed door per section + tall windows */}
      <GlassDoor x={10.9} />
      <Rect x={16.4} y={30.2} width={3.2} height={6.9} rx={0.6} fill={P.glass} />
      <GlassDoor x={20.3} />
      <Rect x={28} y={30.2} width={3.2} height={6.9} rx={0.6} fill={P.glass} />
      <GlassDoor x={31.8} />
      <Rect x={39.6} y={30.2} width={3.2} height={6.9} rx={0.6} fill={P.glass} />
      <GlassDoor x={43.4} />
      <Rect x={51.2} y={30.2} width={3.2} height={6.9} rx={0.6} fill={P.glass} />
      <GlassDoor x={55} />
      <Path d={BODY} fill="none" stroke={P.dark} strokeWidth={0.9} />
    </Svg>
  );
}
