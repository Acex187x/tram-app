import { simulatorPerfScenario } from '@/lib/performance/simulatorScenario';

describe('simulator performance scenarios', () => {
  it.each([
    ['city', 12, 0],
    ['badges', 14.2, 35],
    ['models', 16.8, 55],
  ] as const)('maps %s to a deterministic camera', (scenario, zoomLevel, pitch) => {
    expect(
      simulatorPerfScenario(scenario),
    ).toEqual({
      id: scenario,
      centerCoordinate: [14.42, 50.082],
      zoomLevel,
      pitch,
      heading: 0,
    });
  });

  it.each([
    null,
    undefined,
    '',
    16.8,
    'unknown',
  ])('ignores non-benchmark launch argument %p', (value) => {
    expect(simulatorPerfScenario(value)).toBeNull();
  });
});
