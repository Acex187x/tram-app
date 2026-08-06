import {
  contentBlurOverlayFor,
  contentGlassTintFor,
} from '@/components/ui/glass-appearance';

describe('content glass appearance', () => {
  it('uses a dark material tint behind light dark-mode glyphs', () => {
    expect(contentGlassTintFor('dark')).toBe('rgba(18,18,20,0.72)');
    expect(contentBlurOverlayFor('dark')).toBe('rgba(0,0,0,0.28)');
  });

  it('uses a light material tint behind dark light-mode glyphs', () => {
    expect(contentGlassTintFor('light')).toBe('rgba(250,250,252,0.72)');
    expect(contentBlurOverlayFor('light')).toBe('rgba(255,255,255,0.24)');
  });
});
