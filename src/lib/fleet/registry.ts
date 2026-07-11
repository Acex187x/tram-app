// Fleet-number → tram model detection, plus the coupled-pair heuristic.
//
// Ranges are the live-verified table from docs/architecture.md §Fleet registry
// (2026-07, cross-checked against a live vehiclepositions snapshot: observed reg
// range 6004–9520). Anything outside a known range falls back to 't3rp', the
// most common single-body type. T6A5 (retired 2021) and other gaps therefore
// resolve to the fallback rather than a wrong model.

import type { TramModelId, TramModelSpec } from '@/lib/types';

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

const FALLBACK_MODEL: TramModelId = 't3rp';

/**
 * Map a DPP fleet ("evidenční") number to a tram model id. Unknown/out-of-range
 * numbers (and null) resolve to the 't3rp' fallback.
 */
export function regNumberToModelId(reg: number | null): TramModelId {
  if (reg == null || !Number.isFinite(reg)) return FALLBACK_MODEL;
  const r = Math.trunc(reg);
  for (const range of RANGES) {
    if (r >= range.min && r <= range.max) return range.model;
  }
  return FALLBACK_MODEL;
}

const T3_FAMILY: ReadonlySet<TramModelId> = new Set<TramModelId>([
  't3',
  't3rp',
  't3rplf',
]);

/**
 * Whether a vehicle of `modelId` on `line` is likely a coupled two-car T3 set.
 *
 * Golemio reports only the LEAD car of a consist (verified live 2026-07-11:
 * zero trips with more than one vehicle entry) and exposes no consist-size
 * field anywhere in the API, so this cannot be derived from data. Per product
 * decision, T3-family cars are assumed to ALWAYS run as two-car sets — a
 * solo T3 rendered as a pair is less wrong than a pair rendered solo, which
 * was the common visible error with the old day-line heuristic.
 */
export function isLikelyCoupledPair(modelId: TramModelId, _line: string): boolean {
  return T3_FAMILY.has(modelId);
}

/**
 * Look up the full spec for a model id. MODEL_SPECS is authored in
 * '@/lib/fleet/modelSpecs' (a separate module, per its documented contract
 * `export const MODEL_SPECS: Record<TramModelId, TramModelSpec>`). It is
 * required lazily so this module — and its pure-logic unit tests — load even
 * before that file exists; swap to a static import once it lands.
 */
export function getModelSpec(id: TramModelId): TramModelSpec {
  const mod = require('@/lib/fleet/modelSpecs') as {
    MODEL_SPECS: Record<TramModelId, TramModelSpec>;
  };
  return mod.MODEL_SPECS[id];
}
