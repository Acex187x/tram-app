/** Position evidence age is independent of publication/transport freshness.
 * This signal changes visibility only; it cannot stop, move or reset a tram. */
export interface SourceFreshness {
  sourceFreshness: "fresh" | "aging" | "stale" | "unknown";
  sourceAgeS: number | null;
  sourceOpacity: number;
}
export function sourceFreshness(
  observedAtMs: number,
  serverNowMs: number,
  clockTrusted: boolean,
): SourceFreshness {
  if (
    !clockTrusted ||
    !Number.isFinite(observedAtMs) ||
    !Number.isFinite(serverNowMs) ||
    observedAtMs > serverNowMs + 5_000
  ) {
    return {
      sourceFreshness: "unknown",
      sourceAgeS: null,
      sourceOpacity: 0.55,
    };
  }
  const sourceAgeS = Math.max(0, (serverNowMs - observedAtMs) / 1000);
  return {
    sourceAgeS,
    sourceFreshness:
      sourceAgeS <= 60 ? "fresh" : sourceAgeS <= 120 ? "aging" : "stale",
    sourceOpacity: 1 - 0.45 * Math.min(1, Math.max(0, (sourceAgeS - 60) / 60)),
  };
}
