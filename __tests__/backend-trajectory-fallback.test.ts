/// <reference types="jest" />
jest.mock('../lab/src/db', () => ({ round2: (n: number) => Math.round(n * 100) / 100 }));
import { needsTrajectoryFallback, isCurrentTrajectoryFix } from '../lab/src/trajectoryFallback';
import { MlClient, FEATURE_VERSION } from '../lab/src/ml';
import { isPublisherHealthy } from '../lab/src/publish';
const fix = {tripId:'trip',shapeDistM:100,observedAtMs:1000};
const previous = {tripId:'trip',opinion:[{t:1000,s:100},{t:121000,s:600}]};
describe('ML outage fallback', () => {
  it('holds a matching curve during a transient outage while its horizon covers now', () => {
    expect(needsTrajectoryFallback(previous,fix,60000)).toBe(false);
  });
  it('rebuilds an expired curve even when its historical anchor still agrees', () => {
    expect(needsTrajectoryFallback(previous,fix,121000)).toBe(true);
    expect(needsTrajectoryFallback(previous,fix,500000)).toBe(true);
  });
  it('rebuilds for a new trip or a newer fix proving the old prediction wrong', () => {
    expect(needsTrajectoryFallback(undefined,fix,65000)).toBe(true);
    expect(needsTrajectoryFallback(previous,{...fix,tripId:'next'},60000)).toBe(true);
    expect(needsTrajectoryFallback(previous,{...fix,shapeDistM:800},60000)).toBe(true);
  });
});
it('does not report a configured publisher healthy until it has actually delivered', () => {
  expect(isPublisherHealthy({enabled:true,lastOkAtMs:0},65000)).toBe(false);
  expect(isPublisherHealthy({enabled:true,lastOkAtMs:10000},65000)).toBe(true);
  expect(isPublisherHealthy({enabled:true,lastOkAtMs:10000},70000)).toBe(false);
  expect(isPublisherHealthy({enabled:false,lastOkAtMs:0},65000)).toBe(true);
});
describe('ML response validation', () => {
  const originalFetch = global.fetch;
  afterEach(() => {global.fetch=originalFetch;});
  it('rejects a persisted/service feature version with different target-clock semantics', async () => {
    global.fetch = jest.fn().mockResolvedValue({ok:true,json:async()=>({version:2,ready:true,gbdt:[1],mlp:[1]})});
    const client = new MlClient();
    expect(await client.predictBatch([[1]])).toBeNull();
    expect(client.lastError).toMatch(/feature version 2 != 3/);
    expect(client.modelsReady).toBe(false);
  });
  it('treats malformed ready payload as an outage instead of throwing during fleet construction', async () => {
    global.fetch = jest.fn().mockResolvedValue({ok:true,json:async()=>({version:FEATURE_VERSION,ready:true,gbdt:[],mlp:[]})});
    const client = new MlClient();
    expect(await client.predictBatch([[1]])).toBeNull();
    expect(client.lastError).toMatch(/row count/);
    expect(client.inFlight).toBe(false);
    expect(client.lastLatencyMs).not.toBeNull();
  });
});

it('rejects delayed inference after newer stop credit, trip change or vehicle removal', async () => {
  const captured = {tripId:'trip',observedAtMs:1000};
  let current: typeof captured | undefined = captured;
  let finish!: () => void;
  const inference = new Promise<void>(resolve => {finish=resolve;});
  const emitted: number[] = [];
  const refresh = inference.then(() => {
    if (isCurrentTrajectoryFix(current,captured)) emitted.push(captured.observedAtMs);
  });
  // A same-platform fix advances the standing credit while ML is in flight.
  current = {...captured,observedAtMs:31000};
  finish(); await refresh;
  expect(emitted).toEqual([]);
  expect(isCurrentTrajectoryFix({...captured,tripId:'next'},captured)).toBe(false);
  expect(isCurrentTrajectoryFix(undefined,captured)).toBe(false);
  expect(isCurrentTrajectoryFix(captured,captured)).toBe(true);
});
