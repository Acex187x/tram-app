import { VisualPayload } from '@/lib/render/visualPayload';
import { buildFrame, sourceOpacityOf, metersPerStylePx } from '@/lib/render/featureBuilder';
import { SourceWriter } from '@/lib/render/sourceWriter';
import { TramFleet } from '@/lib/physics/fleet';
import { TrajectoryStore } from '@/lib/physics/trajectoryStore';
import { getModelSpec } from '@/lib/fleet/registry';
import { T0, snapshot, straightGeometry, wireBundle } from './physicsFixtures';

function fleet(distanceM = 0, properties = {}, count = 1): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: Array.from({ length: count }, (_, i) => ({
    type: 'Feature' as const, id: i,
    geometry: { type: 'Point' as const, coordinates: [14.42 + (distanceM * (1 - i / count / 2)) / (111320 * Math.cos(50 * Math.PI / 180)), 50 + i / 10000] },
    properties: { key: String(i), bearing: 0, presentationOpacity: 1, sourceOpacity: 1, ...properties },
  })) };
}

it('accumulates subpixel motion against the submitted position, without rounding it', () => {
  const gate = new VisualPayload();
  const initial = gate.serialize(fleet(), 12);
  expect(gate.serialize(fleet(metersPerStylePx(50, 12) * 0.49), 12)).toBe(initial);
  const moved = fleet(metersPerStylePx(50, 12) * 0.6);
  expect(gate.serialize(moved, 12)).toBe(JSON.stringify(moved));
});

it('preserves selection, removals, geometry changes and both explicit zero-frame barriers', () => {
  const gate = new VisualPayload();
  const a = gate.serialize(fleet(), 12);
  expect(gate.serialize(fleet(0, { selected: 1 }), 12)).not.toBe(a);
  for (const frame of [fleet(0, { presentationOpacity: 0 }), fleet(0.01, { presentationOpacity: 0 }), fleet(0.01)]) {
    expect(gate.serialize(frame, 12, true)).toBe(JSON.stringify(frame));
  }
  const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
  expect(gate.serialize(empty, 12)).toBe(JSON.stringify(empty));
});

it('retries suppressed geometry if native submission failed', async () => {
  const gate = new VisualPayload();
  const writer = new SourceWriter();
  const target = { updateShape: jest.fn().mockResolvedValueOnce(false).mockResolvedValue(true) };
  expect(await writer.send('gate-retry', target, gate.serialize(fleet(), 12), 0)).toBe(false);
  expect(await writer.send('gate-retry', target, gate.serialize(fleet(0.01), 12), 100)).toBe(true);
  expect(target.updateShape).toHaveBeenCalledTimes(2);
  writer.dispose();
});

it('does not lose a subpixel position change when zooming into detail', () => {
  const gate = new VisualPayload();
  const old = gate.serialize(fleet(), 10);
  expect(gate.serialize(fleet(1), 10)).toBe(old);
  expect(gate.serialize(fleet(1), 17)).not.toBe(old);
});

it('wraps small bearing changes at north while preserving larger turns and badge offsets', () => {
  const gate = new VisualPayload();
  const old = gate.serialize(fleet(0, { bearing: 359.9, off: [1, 2] }), 12);
  expect(gate.serialize(fleet(0, { bearing: 0.1, off: [1, 2] }), 12)).toBe(old);
  expect(gate.serialize(fleet(0, { bearing: 0.6, off: [1, 2] }), 12)).not.toBe(old);
  expect(gate.serialize(fleet(0, { bearing: 0.6, off: [2, 2] }), 12)).toContain('"off":[2,2]');
});

it('counts actual native submissions on identical 200-tram workloads, including zero-benefit close motion', async () => {
  const results = [];
  for (const scenario of [
    { name: 'stationary-aging', zoom: 14.2, step: 66, speed: 0, aging: true },
    { name: 'city-moving', zoom: 12, step: 400, speed: 10, aging: false },
    { name: 'city-selected-moving', zoom: 12, step: 100, speed: 10, aging: false },
    { name: 'badges-moving', zoom: 14.2, step: 66, speed: 10, aging: false },
    { name: 'close-moving', zoom: 17, step: 66, speed: 10, aging: false },
  ]) {
    const before = new SourceWriter();
    const after = new SourceWriter();
    const gate = new VisualPayload();
    const nativeBefore = { updateShape: jest.fn().mockResolvedValue(true) };
    const nativeAfter = { updateShape: jest.fn().mockResolvedValue(true) };
    let opportunities = 0;
    for (let t = 0; t < 10000; t += scenario.step) {
      const opacity = scenario.aging ? 1 - 0.45 * t / 60000 : 1;
      const distance = scenario.speed * t / 1000;
      await before.send('before', nativeBefore, JSON.stringify(fleet(distance, { sourceOpacity: opacity }, 200)), t);
      await after.send('after', nativeAfter, gate.serialize(fleet(distance, { sourceOpacity: sourceOpacityOf(opacity) }, 200), scenario.zoom), t);
      opportunities++;
    }
    results.push({ scenario: scenario.name, opportunities, before: nativeBefore.updateShape.mock.calls.length, after: nativeAfter.updateShape.mock.calls.length });
    before.dispose(); after.dispose();
  }
  expect(results).toEqual([
    { scenario: 'stationary-aging', opportunities: 152, before: 152, after: 8 },
    { scenario: 'city-moving', opportunities: 25, before: 25, after: 13 },
    { scenario: 'city-selected-moving', opportunities: 100, before: 100, after: 15 },
    { scenario: 'badges-moving', opportunities: 152, before: 152, after: 51 },
    { scenario: 'close-moving', opportunities: 152, before: 152, after: 152 },
  ]);
});

it('suppresses real buildFrame badge output including declutter properties, without inventing leader geometry', async () => {
  const store = new TrajectoryStore();
  const trams = new TramFleet({ trajectories: store, resolveModel: () => getModelSpec('15t') });
  const geometry = straightGeometry();
  trams.ingest([snapshot()], () => geometry, T0);
  store.ingest(wireBundle(), T0);
  const base = trams.getStates(T0, 'smooth', true)[0];
  const memory = new Map<string, number>();
  const gates = [new VisualPayload(), new VisualPayload()];
  const before = new SourceWriter();
  const after = new SourceWriter();
  const targetsBefore = [0, 1].map(() => ({ updateShape: jest.fn().mockResolvedValue(true) }));
  const targetsAfter = [0, 1].map(() => ({ updateShape: jest.fn().mockResolvedValue(true) }));
  for (let t = 0; t < 10000; t += 66) {
    const states = Array.from({ length: 200 }, (_, i) => ({ ...base,
      key: String(i), snapshot: { ...base.snapshot, key: String(i) },
      position: [14.4 + (i % 20) * 0.001 + t / 1000 * 10 / 71555, 50.07 + Math.floor(i / 20) * 0.001] as [number, number],
      bearing: 90, presentationOpacity: 1, sourceOpacity: 1,
    }));
    const frame = buildFrame(states, { zoom: 14.2, bbox: [14.39, 50.06, 14.44, 50.09] }, {
      selectedKey: null, favoriteKeys: new Set(), getGeometry: () => geometry,
      coupledPairFn: () => false, badgeMemory: memory, nowMs: T0 + t,
    });
    const frames = [frame.points, frame.badges!];
    for (let i = 0; i < frames.length; i++) {
      expect(frames[i].features).toHaveLength(200);
      expect(frames[i].features.every((f) => f.geometry.type === 'Point')).toBe(true);
      await before.send(`real-before-${i}`, targetsBefore[i], JSON.stringify(frames[i]), t);
      await after.send(`real-after-${i}`, targetsAfter[i], gates[i].serialize(frames[i], 14.2), t);
    }
  }
  expect(targetsBefore.map((t) => t.updateShape.mock.calls.length)).toEqual([152, 152]);
  expect(targetsAfter.map((t) => t.updateShape.mock.calls.length)).toEqual([51, 51]);
  before.dispose(); after.dispose();
});
