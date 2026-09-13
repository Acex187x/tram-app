import React from 'react';
import { useServerDebug, type ServerDebugState } from '../src/components/debug/serverDebug';
const { act, create } = require('react-test-renderer');
const mockStateListeners = new Set<(state: string) => void>();
const mockAppState = { currentState: 'active', addEventListener: (_: string, listener: (state: string) => void) => { mockStateListeners.add(listener); return { remove: () => mockStateListeners.delete(listener) }; } };
jest.mock('react-native', () => ({ TurboModuleRegistry: {get: () => null}, Platform: {OS: 'ios', select: (o: any) => o.ios ?? o.default}, AppState: { get currentState() { return mockAppState.currentState; }, addEventListener: (...args: [string, (state: string) => void]) => mockAppState.addEventListener(...args) } }));
let values: Record<string, ServerDebugState> = {};
function Consumer({ id, tramKey }: { id: string; tramKey: string }) { values[id] = useServerDebug(tramKey); return null; }
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('shared server diagnostics lifecycle', () => {
  let root: ReturnType<typeof create> | null;
  const originalFetch = Object.getOwnPropertyDescriptor(global, 'fetch');
  beforeEach(() => { Object.defineProperty(global, 'fetch', {value:undefined,writable:true,configurable:true}); jest.useFakeTimers(); mockAppState.currentState = 'active'; values = {}; root = null; (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
  afterEach(async () => { if (root) await act(async () => root.unmount()); if (originalFetch) Object.defineProperty(global, 'fetch', originalFetch); else delete (global as any).fetch; jest.useRealTimers(); });
  it('coalesces overlay/map requests, preserves unknown metadata, stops on unmount', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ found: true }) })) as any;
    await act(async () => { root = create(React.createElement(React.Fragment, null, React.createElement(Consumer, { id: 'map', tramKey: '1' }), React.createElement(Consumer, { id: 'panel', tramKey: '1' }))); await flush(); });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(values.map.data).toEqual({ found: true });
    expect(values.panel.data?.publish).toBeUndefined();
    await act(async () => { jest.advanceTimersByTime(3000); await flush(); });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    await act(async () => { root.unmount(); root = null; });
    await act(async () => { jest.advanceTimersByTime(30000); await flush(); });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mockStateListeners.size).toBe(0);
  });
  it('aborts inflight work in background and refuses its late result', async () => {
    let resolveRequest: (value: any) => void = () => {};
    global.fetch = jest.fn(() => new Promise((resolve) => { resolveRequest = resolve; })) as any;
    await act(async () => { root = create(React.createElement(Consumer, { id: 'panel', tramKey: '2' })); });
    const signal = (global.fetch as jest.Mock).mock.calls[0][1].signal;
    await act(async () => { mockAppState.currentState = 'background'; mockStateListeners.forEach((listener) => listener('background')); });
    expect(signal.aborted).toBe(true);
    await act(async () => { resolveRequest({ok:true,json:async()=>({found:true,tripId:'stale'})}); await flush(); jest.advanceTimersByTime(30000); });
    expect(values.panel.data).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await act(async () => { mockAppState.currentState = 'active'; mockStateListeners.forEach((listener) => listener('active')); });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
  it('does not overlap slow requests or leak a previous tram into new selection', async () => {
    global.fetch = jest.fn(() => new Promise(() => {})) as any;
    await act(async () => { root = create(React.createElement(Consumer, { id: 'panel', tramKey: '3' })); });
    const firstSignal = (global.fetch as jest.Mock).mock.calls[0][1].signal;
    await act(async () => { jest.advanceTimersByTime(6000); });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await act(async () => { root.update(React.createElement(Consumer, { id: 'panel', tramKey: '4' })); });
    expect(firstSignal.aborted).toBe(true);
    expect(values.panel.data).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
