import { DEBUG_SAMPLE_MS } from '../src/components/debug/diagnostics';
/// <reference types="jest" />

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('debug live-readout performance budget', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/components/debug/DebugOverlay.tsx'),
    'utf8',
  );

  it('uses a foreground-only 1 Hz timer instead of display-rate React commits', () => {
    expect(DEBUG_SAMPLE_MS).toBeGreaterThanOrEqual(1000);
    expect(source).toMatch(/DEBUG_LIVE_INTERVAL_MS\s*=\s*DEBUG_SAMPLE_MS/);
    expect(source).toMatch(/setInterval\(read, DEBUG_LIVE_INTERVAL_MS\)/);
    expect(source).toMatch(/clearInterval\(id\)/);
    expect(source).toContain('active && !paused');
    expect(source).toContain("AppState.addEventListener('change'");
    expect(source).not.toMatch(/\b(?:request|cancel)AnimationFrame\s*\(/);
  });
});
