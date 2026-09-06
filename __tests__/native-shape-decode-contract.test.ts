/// <reference types="jest" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const native = (name: string) => readFileSync(join(process.cwd(),
  'node_modules/@rnmapbox/maps/ios/RNMBX', name), 'utf8');

// Architectural boundary guard: the C++ executable checks actual gate ordering;
// native integration/profile checks decoding and Mapbox behavior at runtime.
describe('native GeoJSON decode boundary', () => {
  const swift = native('RNMBXShapeSource.swift');
  const update = swift.slice(swift.indexOf('@objc public func updateShape('),
    swift.indexOf('private static let shapeDecodeQueue'));
  it('decodes on the worker and applies/acknowledges only on main', () => {
    const worker = update.indexOf('Self.shapeDecodeQueue.async');
    const decode = update.indexOf('Self.decodeShape(shapeJSON)');
    const main = update.indexOf('DispatchQueue.main.async');
    const token = update.indexOf('shouldApply()');
    const apply = update.indexOf('try map.mapboxMap.style.updateGeoJSONSource');
    const ack = update.indexOf('resolver(true)');
    expect(worker).toBeGreaterThan(0);
    expect(decode).toBeGreaterThan(worker);
    expect(main).toBeGreaterThan(decode);
    expect(token).toBeGreaterThan(main);
    expect(apply).toBeGreaterThan(token);
    expect(ack).toBeGreaterThan(apply);
    expect(update.slice(main, apply)).toContain('self.shapeUpdateGeneration == generation');
    expect(update.slice(main, apply)).toContain('sourceExists(withId: self.id)');
    expect(update.slice(worker, main)).toContain('[weak self]');
  });
  it('invalidates in-flight decoding when ownership or source content changes', () => {
    for (const anchor of ['@objc public var url', '@objc public var shape :',
      'public override func removeFromMap(', 'func shapeUpdated(']) {
      const start = swift.indexOf(anchor);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(swift.slice(start, start + 240)).toContain('shapeUpdateGeneration &+= 1');
    }
  });
  it('checks delayed lookups before Swift but consumes only at final application', () => {
    const module = native('RNMBXShapeSourceModule.mm');
    const start = module.indexOf('RCT_EXPORT_METHOD(updateShape:');
    const end = module.indexOf('RCT_EXPORT_METHOD(getClusterLeaves:', start);
    const method = module.slice(start, end);
    const current = method.indexOf('_shapeUpdates.isCurrent(viewTag, token)');
    const invoke = method.indexOf('[view updateShapeWithShapeJSON:');
    const apply = method.indexOf('shouldApply:^BOOL');
    const consume = method.indexOf('_shapeUpdates.consume(viewTag, token)');
    expect(current).toBeGreaterThan(0);
    expect(invoke).toBeGreaterThan(current);
    expect(apply).toBeGreaterThan(invoke);
    expect(consume).toBeGreaterThan(apply);
  });
});
