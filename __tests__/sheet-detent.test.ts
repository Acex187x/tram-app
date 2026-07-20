/// <reference types="jest" />

// Home-sheet chrome positioning contract: the map chrome springs between three
// resting offsets driven purely by the sheet's detent (peek / medium / large).
// See src/components/maps-kit/sheetDetent.ts.

import {
  chromeLayoutForDetent,
  classifyDetent,
  type NativeDetent,
} from '@/components/maps-kit/sheetDetent';

const PEEK = 86;

describe('classifyDetent', () => {
  it('maps the peek height detent to peek', () => {
    expect(classifyDetent({ height: PEEK }, PEEK)).toBe('peek');
  });

  it('maps a taller custom height to medium', () => {
    expect(classifyDetent({ height: 420 }, PEEK)).toBe('medium');
  });

  it('maps the half-screen fraction to medium', () => {
    expect(classifyDetent({ fraction: 0.5 }, PEEK)).toBe('medium');
  });

  it('maps large (preset and near-full fraction) to large', () => {
    expect(classifyDetent('large', PEEK)).toBe('large');
    expect(classifyDetent({ fraction: 0.99 }, PEEK)).toBe('large');
  });

  it('maps the system medium preset to medium', () => {
    expect(classifyDetent('medium', PEEK)).toBe('medium');
  });

  it('is defensive against an unexpected shape', () => {
    expect(classifyDetent({} as NativeDetent, PEEK)).toBe('peek');
  });
});

describe('chromeLayoutForDetent', () => {
  const opts = { peekPx: PEEK, windowHeight: 800 };

  it('rests at peek with no shift, fully visible', () => {
    expect(chromeLayoutForDetent('peek', opts)).toEqual({ shift: 0, opacity: 1 });
  });

  it('rides up at medium while staying visible', () => {
    const l = chromeLayoutForDetent('medium', opts);
    expect(l.shift).toBeGreaterThan(0);
    expect(l.shift).toBe(800 * 0.5 - PEEK);
    expect(l.opacity).toBe(1);
  });

  it('fades out at large without jumping from the medium offset', () => {
    const medium = chromeLayoutForDetent('medium', opts);
    const large = chromeLayoutForDetent('large', opts);
    expect(large.opacity).toBe(0);
    expect(large.shift).toBe(medium.shift);
  });

  it('never returns a negative shift on a very short window', () => {
    const l = chromeLayoutForDetent('medium', { peekPx: 400, windowHeight: 500 });
    expect(l.shift).toBeGreaterThanOrEqual(0);
  });
});
