// Deterministic camera presets for the CLI simulator performance benchmark.
// This module is deliberately pure so parsing stays unit-testable. The map
// only consumes it in __DEV__; normal launches and production builds ignore it.

export type SimulatorPerfScenario = 'city' | 'badges' | 'models';

export interface SimulatorPerfCamera {
  id: SimulatorPerfScenario;
  centerCoordinate: [number, number];
  zoomLevel: number;
  pitch: number;
  heading: number;
}

const PRAGUE_BENCHMARK_CENTER: [number, number] = [14.42, 50.082];

const SCENARIOS: Record<SimulatorPerfScenario, SimulatorPerfCamera> = {
  // Whole-city dots. The map should become event-driven between 5 s pushes.
  city: {
    id: 'city',
    centerCoordinate: PRAGUE_BENCHMARK_CENTER,
    zoomLevel: 12,
    pitch: 0,
    heading: 0,
  },
  // Fast badge cadence immediately above the detail threshold.
  badges: {
    id: 'badges',
    centerCoordinate: PRAGUE_BENCHMARK_CENTER,
    zoomLevel: 14.2,
    pitch: 35,
    heading: 0,
  },
  // Close 3D sections at the zoom used by the smoothness gate.
  models: {
    id: 'models',
    centerCoordinate: PRAGUE_BENCHMARK_CENTER,
    zoomLevel: 16.8,
    pitch: 55,
    heading: 0,
  },
};

/** Parse only the NSUserDefaults launch argument used by the CLI benchmark. */
export function simulatorPerfScenario(
  value: unknown,
): SimulatorPerfCamera | null {
  if (value !== 'city' && value !== 'badges' && value !== 'models') return null;
  return SCENARIOS[value];
}
