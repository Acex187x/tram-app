// Deterministic Europe/Prague timezone helpers — the ONE shared source of the
// CET/CEST offset rule. Imported by both the engine (speedProfile's TOD/hour
// fallback) and golemio/gtfs (service-day resolution), which must agree on the
// Prague hour or TOD buckets and schedule anchors drift apart by an hour.
// Pure TS, no Intl dependency: Intl timezone support is unreliable on Hermes,
// and a host-timezone or fixed-offset fallback is wrong half the year
// (audit 2026-07-13: the engine's old fallback hardcoded UTC+2 — an hour off
// through the whole CET winter).

/**
 * UTC offset (seconds) for Europe/Prague at a given instant, computed from the
 * EU DST rule (CEST +2h from the last Sunday of March 01:00 UTC to the last
 * Sunday of October 01:00 UTC; CET +1h otherwise).
 */
export function pragueOffsetSeconds(utcMs: number): number {
  const year = new Date(utcMs).getUTCFullYear();
  const lastSundayUtc1am = (monthZeroBased: number): number => {
    const lastDay = new Date(Date.UTC(year, monthZeroBased + 1, 0));
    const date = lastDay.getUTCDate() - lastDay.getUTCDay();
    return Date.UTC(year, monthZeroBased, date, 1, 0, 0);
  };
  const dstStart = lastSundayUtc1am(2); // March
  const dstEnd = lastSundayUtc1am(9); // October
  return utcMs >= dstStart && utcMs < dstEnd ? 7200 : 3600;
}
