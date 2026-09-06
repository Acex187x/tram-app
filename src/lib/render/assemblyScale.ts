/** One sampled scale for both rigid meshes and their along-route spacing. */
export const ASSEMBLY_SCALE_STOPS = [[14.8, 5], [15.6, 3.2], [16.4, 1.6], [17, 1]] as const;

/** Matches Mapbox's former exponential(1.6) ramp, including fractional zoom. */
export function assemblyScale(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  if (zoom <= ASSEMBLY_SCALE_STOPS[0][0]) return ASSEMBLY_SCALE_STOPS[0][1];
  for (let i = 1; i < ASSEMBLY_SCALE_STOPS.length; i++) {
    const [hi, b] = ASSEMBLY_SCALE_STOPS[i];
    const [lo, a] = ASSEMBLY_SCALE_STOPS[i - 1];
    if (zoom <= hi) {
      const t = (1.6 ** (zoom - lo) - 1) / (1.6 ** (hi - lo) - 1);
      return a + (b - a) * t;
    }
  }
  return 1;
}
