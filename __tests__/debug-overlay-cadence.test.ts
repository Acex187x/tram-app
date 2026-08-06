/// <reference types="jest" />

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('debug live-readout performance budget', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/components/debug/DebugOverlay.tsx'),
    'utf8',
  );

  it('uses a bounded 10 Hz timer instead of display-rate React commits', () => {
    expect(source).toMatch(/DEBUG_LIVE_INTERVAL_MS\s*=\s*100/);
    expect(source).toMatch(/setInterval\(read, DEBUG_LIVE_INTERVAL_MS\)/);
    expect(source).toMatch(/clearInterval\(id\)/);
    expect(source).not.toMatch(/\b(?:request|cancel)AnimationFrame\s*\(/);
  });
});
