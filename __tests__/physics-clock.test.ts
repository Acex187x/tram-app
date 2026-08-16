/// <reference types="jest" />
//
// Clock sync (physics-v3-protocol goal #3). The curves are stamped in SERVER
// time; a device clock that is minutes off would draw the whole fleet minutes
// down the line. Correcting by a measured, smoothed offset is what makes two
// phones agree — see physics-determinism.test.ts for the end-to-end proof.

import {
  CLOCK_DECAY,
  CLOCK_IMPLAUSIBLE_MS,
  CLOCK_WINDOW,
  ClockSync,
  weightedOffset,
} from '@/lib/physics/clock';

describe('weightedOffset', () => {
  it('is zero with no samples', () => {
    expect(weightedOffset([])).toBe(0);
  });

  it('returns the sample itself when there is only one', () => {
    expect(weightedOffset([1_234])).toBe(1_234);
  });

  it('returns the common value when every sample agrees (a steady clock skew)', () => {
    expect(weightedOffset([500, 500, 500])).toBeCloseTo(500, 9);
  });

  it('weights the NEWEST sample most (samples are ordered oldest → newest)', () => {
    const out = weightedOffset([0, 0, 700]);
    // Weights 0.25/0.5/1 → 700 × (1 / 1.75) = 400.
    expect(out).toBeCloseTo(700 / (1 + CLOCK_DECAY + CLOCK_DECAY ** 2), 9);
    expect(out).toBeGreaterThan(weightedOffset([700, 0, 0]));
  });

  it('damps a single outlier rather than following it', () => {
    const steady = 500;
    const withSpike = weightedOffset([steady, steady, steady + 1_000]);
    // The spike moves the estimate, but by well under its own size.
    expect(withSpike).toBeGreaterThan(steady);
    expect(withSpike - steady).toBeLessThan(1_000 * 0.7);
  });
});

describe('ClockSync', () => {
  it('starts unsynced with a zero offset', () => {
    const c = new ClockSync();
    expect(c.synced).toBe(false);
    expect(c.offsetMs).toBe(0);
    expect(c.now(1_000)).toBe(1_000);
  });

  it('offset = serverNow − localReceive', () => {
    const c = new ClockSync();
    // Device clock is 8 s BEHIND the server.
    c.sample(100_000, 92_000);
    expect(c.synced).toBe(true);
    expect(c.offsetMs).toBe(8_000);
    expect(c.now(92_000)).toBe(100_000);
  });

  it('corrects a device clock that runs FAST (negative offset)', () => {
    const c = new ClockSync();
    c.sample(100_000, 105_000);
    expect(c.offsetMs).toBe(-5_000);
    expect(c.now(105_000)).toBe(100_000);
  });

  it('keeps only the last CLOCK_WINDOW samples', () => {
    const c = new ClockSync();
    // Three wildly wrong samples, then three consistent ones.
    for (const bad of [900_000, 800_000, 700_000]) c.sample(bad, 0);
    for (let i = 0; i < CLOCK_WINDOW; i++) c.sample(1_000 + i, i);
    // The old samples are fully evicted: the estimate is now ~1000.
    expect(c.offsetMs).toBeCloseTo(1_000, 6);
  });

  it('ignores non-finite samples instead of poisoning the offset', () => {
    const c = new ClockSync();
    c.sample(100_000, 92_000);
    c.sample(NaN, 92_000);
    c.sample(100_000, Infinity);
    expect(c.offsetMs).toBe(8_000);
  });

  it('reset() drops every sample (feed restart)', () => {
    const c = new ClockSync();
    c.sample(100_000, 92_000);
    c.reset();
    expect(c.synced).toBe(false);
    expect(c.offsetMs).toBe(0);
  });

  it('flags an implausible offset but still applies it', () => {
    const c = new ClockSync();
    const off = CLOCK_IMPLAUSIBLE_MS + 60_000;
    c.sample(off, 0);
    expect(c.implausible).toBe(true);
    // Still applied — a genuinely wrong device clock must be corrected, loudly.
    expect(c.now(0)).toBe(off);
  });

  it('a normal offset is not flagged', () => {
    const c = new ClockSync();
    c.sample(2_000, 0);
    expect(c.implausible).toBe(false);
  });

  it('converges on a steady skew across repeated fetches', () => {
    const c = new ClockSync();
    const skew = 4_200;
    for (let i = 0; i < 6; i++) c.sample(i * 5_000 + skew, i * 5_000);
    expect(c.offsetMs).toBeCloseTo(skew, 6);
  });
});
