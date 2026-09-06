/** Suppress native source invalidations for changes smaller than a display pixel.
 * Coordinates themselves are never rounded. Compare against the last payload
 * actually offered to SourceWriter, so a slow crawl accumulates and cannot freeze.
 * SourceWriter still owns retries, native acknowledgement and backpressure.
 */
export class VisualPayload {
  private previous: GeoJSON.FeatureCollection | null = null;
  private payload = '';

  serialize(frame: GeoJSON.FeatureCollection, zoom: number, force = false): string {
    if (!force && this.previous && equivalent(this.previous, frame, zoom)) return this.payload;
    this.previous = frame;
    this.payload = JSON.stringify(frame);
    return this.payload;
  }
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!valuesEqual(a[i], b[i])) return false;
  return true;
}

function equivalent(a: GeoJSON.FeatureCollection, b: GeoJSON.FeatureCollection, zoom: number): boolean {
  if (a.features.length !== b.features.length) return false;
  // Mapbox uses 512 style-pixel tiles. Mercator x/y differences are compared
  // in style pixels; no device pixel ratio or approximate latitude multiplier.
  const worldPixels = 512 * 2 ** zoom;
  for (let i = 0; i < a.features.length; i++) {
    const old = a.features[i];
    const next = b.features[i];
    if (old.id !== next.id || old.geometry?.type !== 'Point' || next.geometry?.type !== 'Point') return false;
    const p = old.geometry.coordinates;
    const q = next.geometry.coordinates;
    const dx = (q[0] - p[0]) / 360 * worldPixels;
    const dy = p[1] === q[1] ? 0 : (mercatorY(q[1]) - mercatorY(p[1])) * worldPixels;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) >= 0.5) return false;
    const ap = old.properties ?? {};
    const bp = next.properties ?? {};
    for (const key in bp) if (!(key in ap)) return false;
    for (const key in ap) {
      if (!(key in bp)) return false;
      if (key === 'bearing' && typeof ap[key] === 'number' && typeof bp[key] === 'number') {
        const delta = Math.abs(((bp[key] - ap[key] + 540) % 360) - 180);
        if (!Number.isFinite(delta) || delta >= 0.5) return false;
      } else if (!valuesEqual(ap[key], bp[key])) return false;
    }
  }
  return true;
}

function mercatorY(lat: number): number {
  return Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / (2 * Math.PI);
}
