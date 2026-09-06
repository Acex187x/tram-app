import { HiddenFrameAcks, SourceWriter, getMapSourceDeliveries } from '@/lib/render/sourceWriter';
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function deferred() { let resolve!: (value: unknown) => void; let reject!: (reason: unknown) => void; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
describe('bounded native source delivery', () => {
  let writer: SourceWriter;
  beforeEach(() => { writer = new SourceWriter(); });
  afterEach(() => { writer.dispose(); });
  it.each(['{"features":[]}', '{"features":[{"position":1}]}'])('suppresses repeated stationary payload %s', async (payload) => {
    const target = { updateShape: jest.fn().mockResolvedValue(true) };
    for (let frame = 0; frame < 100; frame++) writer.send('test', target, payload, frame * 100);
    await flush();
    expect(target.updateShape).toHaveBeenCalledTimes(1);
    expect(getMapSourceDeliveries().test).toMatchObject({ submitted: 1, unchanged: 99, pending: 0 });
  });
  it('preserves the hidden barriers when each phase waits for native acceptance', async () => {
    const target = { updateShape: jest.fn().mockResolvedValue(true) };
    for (const payload of ['old:1', 'old:0', 'new:0', 'new:1']) {
      expect(await writer.send('test', target, payload, 0)).toBe(true);
    }
    expect(target.updateShape.mock.calls.map((a) => a[0])).toEqual(['old:1', 'old:0', 'new:0', 'new:1']);
  });
  it('bounds a sustained native stall to one active and one latest queued payload', async () => {
    const active = deferred();
    const target = { updateShape: jest.fn().mockReturnValueOnce(active.promise).mockResolvedValue(true) };
    writer.send('test', target, 'initial', 0);
    const discarded = writer.send('test', target, 'queued1', 1);
    for (let i = 2; i <= 300; i++) writer.send('test', target, `queued${i}`, i);
    expect(await discarded).toBe(false);
    expect(target.updateShape).toHaveBeenCalledTimes(1);
    expect(writer.isBusy(['test'])).toBe(true);
    expect(getMapSourceDeliveries().test).toMatchObject({ pending: 1, queued: 1, coalesced: 299, submitted: 1 });
    active.resolve(true); await flush();
    expect(target.updateShape.mock.calls.map((a) => a[0])).toEqual(['initial', 'queued300']);
    expect(getMapSourceDeliveries().test).toMatchObject({ pending: 0, queued: 0, acknowledged: 2 });
    expect(writer.isBusy(['test'])).toBe(false);
  });
  it('retries identical clearing data after a native rejection', async () => {
    const target = { updateShape: jest.fn().mockRejectedValueOnce(new Error('style unavailable')).mockResolvedValue(true) };
    writer.send('test', target, 'empty', 0); await flush();
    expect(getMapSourceDeliveries().test.lastError).toBe('style unavailable');
    writer.send('test', target, 'empty', 100); await flush();
    expect(target.updateShape).toHaveBeenCalledTimes(2);
    expect(getMapSourceDeliveries().test).toMatchObject({ failures: 1, lastError: null, pending: 0 });
  });
  it('does not let an older failed request invalidate a newer successful payload', async () => {
    const first = deferred();
    const target = { updateShape: jest.fn().mockReturnValueOnce(first.promise).mockResolvedValue(true) };
    writer.send('test', target, 'old', 0); writer.send('test', target, 'new', 100); await flush();
    first.reject('old failure'); await flush(); writer.send('test', target, 'new', 200);
    expect(target.updateShape).toHaveBeenCalledTimes(2);
    expect(getMapSourceDeliveries().test.failures).toBe(1);
  });
  it('resends for a newly mounted source and forgets disposed diagnostics', async () => {
    writer.send('test', null, 'same', 0);
    const a = { updateShape: jest.fn().mockResolvedValue(true) }; const b = { updateShape: jest.fn().mockResolvedValue(true) };
    writer.send('test', a, 'same', 0); writer.send('test', b, 'same', 1); await flush();
    expect(a.updateShape).toHaveBeenCalledTimes(1); expect(b.updateShape).toHaveBeenCalledTimes(1);
    writer.dispose(); expect(getMapSourceDeliveries()).toEqual({});
  });
  it('records synchronous and latest false failures without swallowing them', async () => {
    const target = { updateShape: jest.fn().mockImplementationOnce(() => { throw new Error('bad tag'); }).mockResolvedValue(false) };
    writer.send('test', target, 'same', 0); writer.send('test', target, 'same', 100); await flush();
    expect(getMapSourceDeliveries().test).toMatchObject({ failures: 2, pending: 0 });
  });
});


describe('hidden frame acknowledgement barrier', () => {
  it('waits for every visible source and does not reuse old-zero for new-zero', async () => {
    const barrier = new HiddenFrameAcks(), callback = jest.fn();
    const old = deferred();
    barrier.wait('tram', 1, [Promise.resolve(true), old.promise as Promise<boolean>], callback);
    await flush(); expect(callback).not.toHaveBeenCalled();
    old.resolve(true); await flush(); expect(callback).toHaveBeenLastCalledWith('tram', 1);
    const next = deferred();
    barrier.wait('tram', 2, [next.promise as Promise<boolean>], callback);
    await flush(); expect(callback).toHaveBeenCalledTimes(1);
    next.resolve(true); await flush(); expect(callback).toHaveBeenLastCalledWith('tram', 2);
  });
  it('does not approve missing or rejected sources and permits a retry', async () => {
    const barrier = new HiddenFrameAcks(), callback = jest.fn();
    barrier.wait('tram', 1, [null], callback);
    barrier.wait('tram', 1, [Promise.resolve(false)], callback);
    await flush(); expect(callback).not.toHaveBeenCalled();
    barrier.wait('tram', 1, [Promise.resolve(true)], callback);
    await flush(); expect(callback).toHaveBeenCalledTimes(1);
  });
  it('ignores stale completions after route teardown', async () => {
    const barrier = new HiddenFrameAcks(), callback = jest.fn(), pending = deferred();
    barrier.wait('tram', 1, [pending.promise as Promise<boolean>], callback);
    barrier.dispose(); pending.resolve(true); await flush(); expect(callback).not.toHaveBeenCalled();
  });
});
