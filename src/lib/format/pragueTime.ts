// Pure time formatting helpers. Timetable epochs coming out of the GTFS layer
// are Prague wall-clock instants, so any clock label built from them must be
// rendered in Europe/Prague regardless of the device timezone. Kept dependency-
// free (no React/RN imports) so it is unit-testable in isolation.

let clockFormatter: Intl.DateTimeFormat | null | undefined;

/**
 * H:mm clock label (24h) in Europe/Prague wall time. Falls back to device-local
 * time only if Intl/timeZone data is unavailable.
 */
export function formatPragueClock(ms: number): string {
  if (clockFormatter === undefined) {
    try {
      clockFormatter = new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Europe/Prague',
      });
    } catch {
      clockFormatter = null;
    }
  }
  if (clockFormatter) {
    const s = clockFormatter.format(new Date(ms));
    if (s) return s;
  }
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}
