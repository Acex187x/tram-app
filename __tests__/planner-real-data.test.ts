// Repro harness for the Codex-reported planner geometry bug, driven by REAL
// exported trip geometries (skipped when absent). Export only from a caller's
// leased simulator; a unit test must not reach into an unrelated device.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { planItineraries } from '@/lib/planner/planner';
import type { RouteGeometry } from '@/lib/types';

function loadRealGeometries(): RouteGeometry[] | null {
  try {
    const dir = process.env.TRAM_PLANNER_GEOMETRY_DIR;
    if (!dir) return null;
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => (JSON.parse(readFileSync(join(dir, f), 'utf8')) as { geometry: RouteGeometry }).geometry);
  } catch {
    return null;
  }
}

const geometries = loadRealGeometries();
const maybe = geometries && geometries.length > 50 ? describe : describe.skip;

maybe('planner with real Prague data', () => {
  it('leg polylines end at the destination stop', () => {
    const its = planItineraries('Malostranská', 'Národní divadlo', geometries!);
    expect(its.length).toBeGreaterThan(0);
    for (const it of its) {
      const lastLeg = it.legs[it.legs.length - 1];
      const coords = lastLeg.coordinates;
      expect(coords.length).toBeGreaterThanOrEqual(2);
      const end = coords[coords.length - 1];
      // Find the destination stop's actual coordinates in some geometry.
      const dest = geometries!
        .flatMap((g) => g.stops)
        .find((s) => s.name === lastLeg.toStopName);
      expect(dest).toBeDefined();
      const dLng = (end[0] - dest!.coordinates[0]) * 71500; // ~m per deg lng at Prague
      const dLat = (end[1] - dest!.coordinates[1]) * 111320;
      const distM = Math.hypot(dLng, dLat);
      // The drawn line must END near the destination stop (well under 300 m).
      if (distM > 300) {
        throw new Error(
          `leg ${lastLeg.line} ${lastLeg.fromStopName}→${lastLeg.toStopName}: polyline ends ${Math.round(distM)}m from destination (stops ${lastLeg.stopCount})`,
        );
      }
    }
  });
});
