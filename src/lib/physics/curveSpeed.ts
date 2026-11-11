import type { RouteGeometry } from "@/lib/types";
import { curvatureProfile, segmentIndexAt } from "@/lib/geo/polyline";

/** Lateral comfort used by the server profile (lab/src/drive.ts A_LAT). */
const A_LAT = 0.98;
/** Deceleration assumed when approaching a slower curve (comfortable, below
 * the 1.4 m/s² service brake so the jerk-limited controller can follow it). */
const APPROACH_DECEL = 0.8;
const MIN_CURVE_SPEED = 1.4;
const caps = new WeakMap<RouteGeometry, Float64Array>();

function profileFor(g: RouteGeometry): Float64Array {
  let profile = caps.get(g);
  if (!profile) {
    const kappa = curvatureProfile(g.coordinates, g.cumDistM);
    profile = new Float64Array(kappa.length);
    for (let i = 0; i < kappa.length; i++)
      profile[i] =
        kappa[i] <= 1e-9
          ? Infinity
          : Math.max(MIN_CURVE_SPEED, 0.85 * Math.sqrt(A_LAT / kappa[i]));
    caps.set(g, profile);
  }
  return profile;
}

/** Curve speed ceiling at the displayed head `s` (moving at `v`), including a
 * braking envelope toward tighter curves within 400 m. Geometry can only lower
 * the presentation ceiling; the server curve already obeys the same rule, so
 * this only bites while the display is catching up. Weakly cached per axis. */
export function curveSpeedCap(
  g: RouteGeometry,
  s: number,
  v: number,
  ceiling: number,
): number {
  const profile = profileFor(g);
  let cap = ceiling;
  const margin = v * 3 + 3;
  for (
    let i = segmentIndexAt(g.cumDistM, Math.max(0, s - 15));
    i < profile.length && g.cumDistM[i] <= s + 400;
    i++
  ) {
    if (g.cumDistM[i] < s - 15 || profile[i] === Infinity) continue;
    const ahead = Math.max(0, g.cumDistM[i] - s - margin);
    cap = Math.min(cap, Math.sqrt(profile[i] ** 2 + 2 * APPROACH_DECEL * ahead));
  }
  return cap;
}
