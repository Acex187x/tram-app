// Entry point. `__DEV__` must exist before ANY engine module is evaluated
// (speedProfile reads it at module scope) — same pattern as
// scripts/calibration/replay-v2.ts. `import` statements hoist above
// statements in CJS output, so run.ts is loaded via require AFTER the global
// is set.

(globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;

/* eslint-disable @typescript-eslint/no-require-imports */
const { start } = require('./run') as typeof import('./run');

process.on('unhandledRejection', (e) => {
  console.error('[lab] unhandled rejection', e);
});

start();
