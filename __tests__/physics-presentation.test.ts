import {
  advancePresentation,
  advanceTransition,
  presentationBrakingDistance,
  type PresentationTransition,
} from "@/lib/physics/presentation";

it.each([10, 30, 60])(
  "preserves position, both acceleration bounds and jerk through a revision at %i Hz",
  (fps) => {
    const p = { s: 0, v: 10, a: 0 };
    const dt = 1 / fps;
    let old = { ...p };
    for (let n = 1; n <= fps * 24; n++) {
      const time = n * dt;
      const target =
        time < 5 ? 10 * time : time < 14 ? 20 : 200 + 10 * (time - 14);
      advancePresentation(
        p,
        dt,
        target,
        time < 5 || time >= 14 ? 10 : 0,
        0,
        time < 14 && time >= 5 ? 20 : null,
      );
      expect(p.s).toBeGreaterThanOrEqual(old.s);
      expect(p.v).toBeGreaterThanOrEqual(0);
      expect(p.v).toBeLessThanOrEqual(25);
      expect(Math.abs(p.v - old.v)).toBeLessThanOrEqual(2.5 * dt + 1e-7);
      expect(Math.abs(p.a - old.a)).toBeLessThanOrEqual(4 * dt + 1e-7);
      expect(p.s - old.s).toBeLessThanOrEqual(25 * dt + 1e-7);
      old = { ...p };
    }
    expect(p.s).toBeGreaterThan(120);
  },
);

it.each([10, 30, 60])(
  "brakes into an already supplied stationary endpoint without a speed snap at %i Hz",
  (fps) => {
    const p = { s: 0, v: 10, a: 0 };
    const dt = 1 / fps;
    const stop = 70;
    for (let n = 1; n <= fps * 20; n++) {
      const t = n * dt;
      const target = Math.min(stop, 10 * t);
      advancePresentation(p, dt, target, target < stop ? 10 : 0, 0, stop);
    }
    expect(p.s).toBeGreaterThan(stop - 1);
    expect(p.s).toBeLessThanOrEqual(stop + 0.2);
    expect(p.v).toBeLessThan(0.01);
    expect(Math.abs(p.a)).toBeLessThan(0.01);
  },
);

it("keeps bounded integration after a missed frame and leaves lifecycle gaps to the transition owner", () => {
  const p = { s: 0, v: 10, a: 0 };
  advancePresentation(p, 3, 100, 10, 0, null);
  expect(p.s).toBeGreaterThan(30);
  expect(p.s).toBeLessThan(45);
  const previous = { ...p };
  advancePresentation(p, 6, 1000, 10, 0, null);
  expect(p).toEqual(previous);
  expect(presentationBrakingDistance(10, 0)).toBeGreaterThan(20);
});

it("requires distinct acknowledged old-zero and new-zero frames before revealing a correction", () => {
  let token = 0;
  const t: PresentationTransition = {
    id: 1,
    reason: "trip-change",
    stage: "out",
    atMs: 0,
    hiddenFrameId: undefined,
    acknowledged: false,
  };
  const tick = (now: number) => advanceTransition(t, now, () => ++token);
  expect(tick(300)).toEqual({ opacity: 0, rebase: false, done: false });
  const oldToken = t.hiddenFrameId;
  expect(tick(60000).rebase).toBe(false); // wall time never substitutes for native acceptance
  t.acknowledged = true;
  expect(tick(60001)).toEqual({ opacity: 0, rebase: true, done: false });
  expect(t.hiddenFrameId).not.toBe(oldToken);
  expect(t.acknowledged).toBe(false);
  expect(tick(90000).opacity).toBe(0);
  t.acknowledged = true;
  expect(tick(90001).opacity).toBe(0);
  expect(tick(90201).opacity).toBe(0.5);
  expect(tick(90401)).toEqual({ opacity: 1, rebase: false, done: true });
});
