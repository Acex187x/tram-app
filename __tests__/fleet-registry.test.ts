import { describe, expect, it } from '@jest/globals';

import { isLikelyCoupledPair, regNumberToModelId } from '@/lib/fleet/registry';
import type { TramModelId } from '@/lib/types';

describe('regNumberToModelId', () => {
  const cases: [number | null, TramModelId][] = [
    [6004, 't3'], // historic
    [7269, 't3'],
    [7290, 't3'],
    [8014, 't3'], // upper bound of historic
    [8015, 't3rp'],
    [8100, 't3rp'],
    [8249, 't3rp'],
    [8260, 't3rplf'], // 8251–8299
    [8299, 't3rplf'],
    [8300, 't3rp'], // in-house rebuilds
    [8579, 't3rp'],
    [8650, 't3rp'], // gap (retired T6A5) → fallback
    [8780, 't3rplf'], // 8750–8806
    [8806, 't3rplf'],
    [9051, 'kt8d5'],
    [9113, 'kt8d5'],
    [9114, '14t'],
    [9128, '14t'], // live-observed line 17 car
    [9199, '14t'],
    [9200, '15t'],
    [9286, '15t'], // live-observed line 1 car
    [9499, '15t'],
    [9500, '52t'],
    [9520, '52t'], // live-observed max
    [9599, '52t'],
    [9700, 't3rp'], // above known ranges → fallback
    [null, 't3rp'],
  ];

  it.each(cases)('reg %p → %p', (reg, expected) => {
    expect(regNumberToModelId(reg)).toBe(expected);
  });

  it('handles NaN and fractional inputs', () => {
    expect(regNumberToModelId(Number.NaN)).toBe('t3rp');
    expect(regNumberToModelId(9128.9)).toBe('14t');
  });
});

describe('isLikelyCoupledPair', () => {
  it('is true for T3-family cars on numeric day lines 1–26 except 23', () => {
    expect(isLikelyCoupledPair('t3rp', '5')).toBe(true);
    expect(isLikelyCoupledPair('t3', '1')).toBe(true);
    expect(isLikelyCoupledPair('t3rplf', '26')).toBe(true);
  });

  it('is false for line 23', () => {
    expect(isLikelyCoupledPair('t3rp', '23')).toBe(false);
  });

  it('is false for night lines and lines above 26', () => {
    expect(isLikelyCoupledPair('t3rp', '91')).toBe(false);
    expect(isLikelyCoupledPair('t3rp', '31')).toBe(false);
  });

  it('is false for non-T3 models', () => {
    expect(isLikelyCoupledPair('15t', '5')).toBe(false);
    expect(isLikelyCoupledPair('kt8d5', '9')).toBe(false);
    expect(isLikelyCoupledPair('14t', '5')).toBe(false);
  });
});
