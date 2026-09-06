/** A current revision can be evaluated in the past, but it cannot be described
 * as a causal prediction if its inputs only became available afterwards. */
export interface PredictionTiming {
  predictionEvaluatedAtMs?: number;
  predictionInputsAvailableAtMs?: number | null;
}
export type PredictionTimingReason = 'eligible' | 'unknown-availability' | 'timestamp-mismatch' | 'future-input';
export function predictionTimingEligibility(timing: PredictionTiming | undefined, observedAtMs: number): PredictionTimingReason {
  const evaluated = timing?.predictionEvaluatedAtMs;
  const available = timing?.predictionInputsAvailableAtMs;
  if (!Number.isFinite(evaluated) || !Number.isFinite(available)) return 'unknown-availability';
  if (!Number.isFinite(observedAtMs) || Math.abs(evaluated! - observedAtMs) > 1) return 'timestamp-mismatch';
  return available! > observedAtMs + 1 ? 'future-input' : 'eligible';
}
