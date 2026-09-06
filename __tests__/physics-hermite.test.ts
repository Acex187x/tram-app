import { packTrack } from '@/lib/physics/bundle';
import { crossingTimeMs, evalTrajectory, type PreparedTrack } from '@/lib/physics/evaluator';
import { trackEndSpeedMs } from '@/lib/physics/fixForward';

const value = (track: Float64Array, seconds: number) => evalTrajectory(track, seconds * 1000);
const speed = (track: Float64Array, seconds: number) =>
  (value(track, seconds + 0.0001) - value(track, seconds - 0.0001)) / 0.0002;

it('reconstructs constant acceleration instead of a constant-speed chord', () => {
  const track = packTrack([
    { t: 0, s: 0, v: 0 },
    { t: 10000, s: 50, v: 10 },
  ]);
  expect(value(track, 2)).toBeCloseTo(2, 8);
  expect(value(track, 5)).toBeCloseTo(12.5, 8);
  expect(speed(track, 5)).toBeCloseTo(5, 6);
  expect(trackEndSpeedMs(track)).toBeCloseTo(10, 8);
  // Old clients still read the same position/time pair layout.
  expect(Array.from(track)).toEqual([0, 0, 10000, 50]);
});

it('remains C1 across acceleration/braking knots with matching supplied velocities', () => {
  const track = packTrack([
    { t: 0, s: 0, v: 0 },
    { t: 6000, s: 18, v: 6 },
    { t: 11000, s: 38, v: 2 },
  ]);
  expect(speed(track, 5.999)).toBeCloseTo(5.999, 4);
  expect(speed(track, 6.001)).toBeCloseTo(5.9992, 4);
  expect(Math.abs(speed(track, 6.001) - speed(track, 5.999))).toBeLessThan(0.001);
});

it('keeps exact modal holds and leaves a zero-speed stop continuously', () => {
  const track = packTrack([
    { t: 0, s: 50, v: 0 },
    { t: 10000, s: 50, v: 0 },
    { t: 20000, s: 100, v: 10 },
  ]);
  for (let t = 0; t <= 10; t += 0.1) expect(value(track, t)).toBe(50);
  expect(value(track, 10.001) - 50).toBeLessThan(0.000001);
  expect(crossingTimeMs(track, 50)).toBe(0); // first crossing, not stop departure
});

it('the inverse agrees with the rendered cubic, including near zero-speed endpoints', () => {
  const track = packTrack([
    { t: 0, s: 100, v: 0 },
    { t: 10000, s: 150, v: 10 },
  ]);
  for (const t of [0.001, 0.01, 0.1, 1, 2, 5, 9.99, 9.999]) {
    expect(crossingTimeMs(track, value(track, t))).toBeCloseTo(t * 1000, 2);
  }
  expect(Number.isNaN(crossingTimeMs(track, 151))).toBe(true);
});

it.each([undefined, NaN, Infinity, -1, 16.8, '5'])(
  'falls back exactly to linear with invalid/missing endpoint velocity %s',
  (v) => {
    const track = packTrack([
      { t: 0, s: 0, v },
      { t: 10000, s: 50, v: 10 },
    ]);
    expect(value(track, 2)).toBe(10);
    expect((track as PreparedTrack).hermite).toBeUndefined();
  },
);

it.each(
  [
    [
      { t: 0, s: 0, v: 1 },
      { t: 10000, s: 0.1, v: 1 },
    ], // reverses in the middle despite valid ends
    [
      { t: 0, s: 0, v: 16 },
      { t: 20000, s: 332, v: 16 },
    ], // overshoots speed ceiling inside span
    [
      { t: 0, s: 0, v: 0 },
      { t: 2000, s: 10, v: 0 },
    ], // excessive acceleration
    [
      { t: 0, s: 0, v: 0 },
      { t: 1, s: 1, v: 0 },
    ], // short/ill-conditioned span
    [
      { t: 0, s: 10, v: 0 },
      { t: 10000, s: 0, v: 0 },
    ], // malformed reverse wire
  ].map((points) => [points]),
)('rejects a physically infeasible cubic without inventing or moving endpoints', (points) => {
  const track = packTrack(points);
  expect((track as PreparedTrack).hermite).toBeUndefined();
  expect(value(track, points[1].t / 2000)).toBe((points[0].s + points[1].s) / 2);
});

it('keeps velocity slots aligned when malformed knots are discarded', () => {
  const track = packTrack([
    { t: 0, s: 0, v: 0 },
    { t: NaN, s: 20, v: 100 },
    { t: 10000, s: 50, v: 10 },
  ]);
  expect(value(track, 5)).toBeCloseTo(12.5, 8);
});

it('samples an admissible nonconstant-acceleration cubic within speed and acceleration limits', () => {
  const track = packTrack([
    { t: 0, s: 0, v: 2 },
    { t: 8000, s: 32, v: 4 },
  ]);
  expect((track as PreparedTrack).hermite).toBeDefined();
  let prev = value(track, 0);
  for (let i = 1; i < 800; i++) {
    const t = i / 100;
    const s = value(track, t),
      v = speed(track, t);
    const a = (speed(track, t + 0.001) - speed(track, t - 0.001)) / 0.002;
    expect(s).toBeGreaterThanOrEqual(prev);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(16.7);
    expect(a).toBeGreaterThanOrEqual(-1.4 - 1e-5);
    expect(a).toBeLessThanOrEqual(1.3 + 1e-5);
    prev = s;
  }
});
