// Registration-number → tram model, server side.
//
// PORTED (not imported) from src/lib/fleet/registry.ts. That module cannot be
// bundled into Convex as-is: `getModelSpec` does a runtime
// `require('@/lib/fleet/modelSpecs')`, which is neither an ESM import nor a
// resolvable path outside Metro. The RANGES table itself is pure data, so it is
// mirrored here verbatim.
//
// KEEP IN SYNC with src/lib/fleet/registry.ts — the ranges are the live-verified
// table from docs/architecture.md §Fleet registry (2026-07, observed reg range
// 6004–9520). Anything outside a known range falls back to 't3rp', the most
// common single-body type, so retired types (T6A5) resolve to the fallback
// rather than to a wrong model.

import type { TramModelId } from '../../src/lib/types';

interface RegRange {
  min: number;
  max: number;
  model: TramModelId;
}

const RANGES: readonly RegRange[] = [
  { min: 0, max: 8014, model: 't3' }, // historic ≤ 8014 → T3
  { min: 8015, max: 8249, model: 't3rp' }, // T3R.P
  { min: 8251, max: 8299, model: 't3rplf' }, // T3R.PLF (first series)
  { min: 8300, max: 8579, model: 't3rp' }, // T3R.P (in-house rebuilds)
  { min: 8750, max: 8806, model: 't3rplf' }, // T3R.PLF (second series)
  { min: 9051, max: 9113, model: 'kt8d5' }, // KT8D5.RN2P
  { min: 9114, max: 9199, model: '14t' }, // Škoda 14T
  { min: 9200, max: 9499, model: '15t' }, // Škoda 15T ForCity Alfa
  { min: 9500, max: 9599, model: '52t' }, // Škoda 52T ForCity Plus
];

export const FALLBACK_MODEL: TramModelId = 't3rp';

/** Map a DPP fleet ("evidenční") number to a tram model id. */
export function regNumberToModelId(reg: number | null): TramModelId {
  if (reg == null || !Number.isFinite(reg)) return FALLBACK_MODEL;
  const r = Math.trunc(reg);
  for (const range of RANGES) {
    if (r >= range.min && r <= range.max) return range.model;
  }
  return FALLBACK_MODEL;
}
