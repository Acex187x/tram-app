import { createDemandRenderer, nextMechanismFrame } from '@/components/model/demandRenderer';
import { CLOSED_DOORS, changeDoorTarget } from '@/components/model/mechanismMath';

describe('viewer demand rendering', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(0); });
  afterEach(() => jest.useRealTimers());
  it('renders one initial frame and does no work over twenty idle minutes', () => {
    const draw = jest.fn(() => null);
    const loop = createDemandRenderer(draw, 33);
    loop.request();
    jest.advanceTimersByTime(20 * 60_000);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('coalesces gesture events to the budget and draws the final pose', () => {
    let pose = 0;
    const drawn: number[] = [];
    const loop = createDemandRenderer(() => { drawn.push(pose); return null; }, 33);
    for (let i = 0; i < 100; i++) { pose = i; loop.request(); jest.advanceTimersByTime(1); }
    jest.advanceTimersByTime(33);
    expect(drawn.length).toBeLessThanOrEqual(5);
    expect(drawn.at(-1)).toBe(99);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('door animation settles and indicator wakes only on lamp edges', () => {
    const door = changeDoorTarget(CLOSED_DOORS, true, 0);
    expect(nextMechanismFrame(1599, door, 'off', 0, false, 33)).toBe(33);
    expect(nextMechanismFrame(1600, door, 'off', 0, false, 33)).toBeNull();
    expect(nextMechanismFrame(0, CLOSED_DOORS, 'left', 0, false, 33)).toBe(400);
    expect(nextMechanismFrame(450, CLOSED_DOORS, 'left', 0, false, 33)).toBe(350);
    expect(nextMechanismFrame(450, door, 'left', 0, true, 33)).toBeNull();
  });
  it('suspends active animation in background and cannot restart after disposal', () => {
    const draw = jest.fn(() => 33);
    const loop = createDemandRenderer(draw, 33);
    loop.request(); jest.advanceTimersByTime(100);
    loop.setActive(false);
    const count = draw.mock.calls.length;
    jest.advanceTimersByTime(120_000);
    expect(draw).toHaveBeenCalledTimes(count);
    loop.setActive(true); jest.advanceTimersByTime(100);
    expect(draw.mock.calls.length).toBeGreaterThan(count);
    loop.dispose(); loop.request(); loop.setActive(true);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('a gesture interrupts a pending slow indicator edge', () => {
    const draw = jest.fn(() => 400);
    const loop = createDemandRenderer(draw, 33);
    loop.request(); jest.advanceTimersByTime(50); loop.request();
    jest.advanceTimersByTime(1);
    expect(draw).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1);
    loop.dispose();
  });
});
