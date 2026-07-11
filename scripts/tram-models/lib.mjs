// Tram model authoring library — geometry primitives, shared material palette,
// reusable tram parts (walls, noses, bogies, pantographs) and GLB assembly via
// @gltf-transform. Pure Node ESM, no DOM.
//
// HARD CONVENTIONS (docs/architecture.md, spike-verified):
//   * Y-up, meters, real size. Ground = y0. FRONT of tram toward −Z.
//   * Each section centered at its own origin (x=0, z=0 at section center).
//   * Materials: metallicFactor ≤ 0.35, roughness 0.4–0.7 for body panels.
//   * Emissive via emissiveFactor only (layer sets model-emissive-strength).

import { ColorUtils, Document, NodeIO } from '@gltf-transform/core';
import { dedup, prune, weld } from '@gltf-transform/functions';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// ── Shared PBR material palette ──────────────────────────────────────────────
// Roughly 8 of these appear per GLB; hex colors are sRGB (converted by
// setBaseColorHex), emissive is a raw linear factor.

export const MATERIALS = {
  redClassic: { hex: 0xb02a26, rough: 0.48, metal: 0.08 }, // DPP traffic red
  redDark: { hex: 0x7a0603, rough: 0.5, metal: 0.08 }, // PID dark red
  cream: { hex: 0xf2e6c9, rough: 0.55, metal: 0.04 }, // DPP ivory
  white: { hex: 0xeff1f0, rough: 0.5, metal: 0.06 },
  silver: { hex: 0xc9ced3, rough: 0.42, metal: 0.3 }, // 14T Porsche silver
  greyLight: { hex: 0xd8dbdd, rough: 0.5, metal: 0.1 }, // 52T pale grey
  roof: { hex: 0x969c9f, rough: 0.65, metal: 0.15 },
  trim: { hex: 0x2e3134, rough: 0.68, metal: 0.1 }, // skirts, underframe
  black: { hex: 0x131518, rough: 0.6, metal: 0.05 },
  glass: {
    hex: 0x0b0f14,
    rough: 0.16,
    metal: 0.0,
    emissive: [0.05, 0.055, 0.06], // faint interior hint
  },
  brass: { hex: 0x9c7a2c, rough: 0.5, metal: 0.3 }, // T3 scissor pantograph
  headlight: { hex: 0xfff3d6, rough: 0.3, metal: 0, emissive: [1, 0.93, 0.72] },
  taillight: { hex: 0x9b1410, rough: 0.3, metal: 0, emissive: [1, 0.05, 0.03] },
  display: { hex: 0x201d16, rough: 0.4, metal: 0, emissive: [1, 0.82, 0.5] },
};

// ── MeshBuilder: accumulates flat-shaded triangles per material key ──────────

export class MeshBuilder {
  constructor() {
    /** @type {Map<string, {pos:number[], nrm:number[], idx:number[]}>} */
    this.groups = new Map();
  }

  group(mat) {
    if (!MATERIALS[mat]) throw new Error(`unknown material '${mat}'`);
    let g = this.groups.get(mat);
    if (!g) {
      g = { pos: [], nrm: [], idx: [] };
      this.groups.set(mat, g);
    }
    return g;
  }

  tri(mat, a, b, c) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return; // degenerate
    nx /= l; ny /= l; nz /= l;
    const g = this.group(mat);
    const base = g.pos.length / 3;
    for (const p of [a, b, c]) {
      g.pos.push(p[0], p[1], p[2]);
      g.nrm.push(nx, ny, nz);
    }
    g.idx.push(base, base + 1, base + 2);
  }

  quad(mat, a, b, c, d) {
    this.tri(mat, a, b, c);
    this.tri(mat, a, c, d);
  }

  /** Vertical rect on a plane x = const. dir: +1 → normal +x, -1 → −x. */
  rectX(mat, x, z0, z1, y0, y1, dir) {
    const a = [x, y0, z0], b = [x, y0, z1], c = [x, y1, z1], d = [x, y1, z0];
    if (dir > 0) this.quad(mat, b, a, d, c);
    else this.quad(mat, a, b, c, d);
  }

  /** Vertical rect on a plane z = const. dir: +1 → normal +z, -1 → −z. */
  rectZ(mat, z, x0, x1, y0, y1, dir) {
    const a = [x0, y0, z], b = [x1, y0, z], c = [x1, y1, z], d = [x0, y1, z];
    if (dir > 0) this.quad(mat, a, b, c, d);
    else this.quad(mat, b, a, d, c);
  }

  /** Horizontal rect on a plane y = const. dir: +1 → normal +y (up). */
  rectY(mat, y, x0, x1, z0, z1, dir) {
    const a = [x0, y, z0], b = [x1, y, z0], c = [x1, y, z1], d = [x0, y, z1];
    if (dir > 0) this.quad(mat, b, a, d, c);
    else this.quad(mat, a, b, c, d);
  }

  /**
   * Triangle-fan cap over a 3D polygon. `outward` hints the desired normal
   * direction; the point order is flipped automatically to honor it.
   */
  fan(mat, pts, outward) {
    if (pts.length < 3) return;
    const [a, b, c] = [pts[0], pts[1], pts[2]];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const dot = n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2];
    const ordered = dot >= 0 ? pts : [...pts].reverse();
    for (let i = 1; i < ordered.length - 1; i++) {
      this.tri(mat, ordered[0], ordered[i], ordered[i + 1]);
    }
  }

  /**
   * Ribbon of quads between two equal-length 3D polylines (low → high).
   * For arcs bulging toward −Z ordered left(−x)→right(+x), normals face
   * outward. For +Z (rear) arcs pass points right→left.
   */
  ribbon(mat, low, high) {
    for (let i = 0; i < low.length - 1; i++) {
      this.quad(mat, low[i], high[i], high[i + 1], low[i + 1]);
    }
  }

  /**
   * Extrude a closed 2D profile ([x,y] pairs, CCW viewed from +Z) from z0 to
   * z1. Caps optional.
   */
  prismZ(mat, profile, z0, z1, { capStart = true, capEnd = true } = {}) {
    const n = profile.length;
    for (let i = 0; i < n; i++) {
      const [x0, y0] = profile[i];
      const [x1, y1] = profile[(i + 1) % n];
      // wall quad, outward for CCW profile and z1 > z0
      this.quad(mat, [x0, y0, z0], [x1, y1, z0], [x1, y1, z1], [x0, y0, z1]);
    }
    if (capStart) this.fan(mat, profile.map(([x, y]) => [x, y, z0]), [0, 0, -1]);
    if (capEnd) this.fan(mat, profile.map(([x, y]) => [x, y, z1]), [0, 0, 1]);
  }

  /** Axis-aligned box centered at (x,y,z). */
  box(mat, { x = 0, y = 0, z = 0, w, h, d, bevel = 0 }) {
    const profile = bevel > 0
      ? octagonProfile(w, h, bevel).map(([px, py]) => [px + x, py + y])
      : [[x - w / 2, y - h / 2], [x + w / 2, y - h / 2], [x + w / 2, y + h / 2], [x - w / 2, y + h / 2]];
    this.prismZ(mat, profile, z - d / 2, z + d / 2);
  }

  /** Cylinder along `axis` ('x'|'y'|'z') centered at (x,y,z). */
  cylinder(mat, { x = 0, y = 0, z = 0, r, len, axis = 'y', seg = 12, caps = true, capMat }) {
    const ring0 = [], ring1 = [];
    for (let i = 0; i < seg; i++) {
      const t = (i / seg) * Math.PI * 2;
      const c = Math.cos(t) * r, s = Math.sin(t) * r;
      let p0, p1;
      if (axis === 'y') {
        p0 = [x + c, y - len / 2, z + s];
        p1 = [x + c, y + len / 2, z + s];
      } else if (axis === 'x') {
        p0 = [x - len / 2, y + c, z + s];
        p1 = [x + len / 2, y + c, z + s];
      } else {
        p0 = [x + c, y + s, z - len / 2];
        p1 = [x + c, y + s, z + len / 2];
      }
      ring0.push(p0);
      ring1.push(p1);
    }
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      // outward winding determined per-face by fan/quad normal calc: use
      // explicit ordering that yields outward normals for CCW rings.
      const a = ring0[i], b = ring0[j], c = ring1[j], d = ring1[i];
      if (axis === 'x') this.quad(mat, a, b, c, d);
      else this.quad(mat, b, a, d, c);
    }
    if (caps) {
      const axisVec = axis === 'y' ? [0, 1, 0] : axis === 'x' ? [1, 0, 0] : [0, 0, 1];
      const neg = axisVec.map((v) => -v);
      this.fan(capMat ?? mat, ring0, neg);
      this.fan(capMat ?? mat, ring1, axisVec);
    }
  }

  /** Square-section beam from point A to point B (pantograph arms, eyebrows). */
  beam(mat, A, B, w, h = w) {
    const t = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const tl = Math.hypot(...t);
    if (tl < 1e-9) return;
    const tn = t.map((v) => v / tl);
    const helper = Math.abs(tn[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let s = [
      tn[1] * helper[2] - tn[2] * helper[1],
      tn[2] * helper[0] - tn[0] * helper[2],
      tn[0] * helper[1] - tn[1] * helper[0],
    ];
    const sl = Math.hypot(...s);
    s = s.map((v) => (v / sl) * (w / 2));
    const u = [
      (tn[1] * s[2] - tn[2] * s[1]) / (w / 2) * (h / 2),
      (tn[2] * s[0] - tn[0] * s[2]) / (w / 2) * (h / 2),
      (tn[0] * s[1] - tn[1] * s[0]) / (w / 2) * (h / 2),
    ];
    const corner = (P, ds, du) => [P[0] + ds * s[0] + du * u[0], P[1] + ds * s[1] + du * u[1], P[2] + ds * s[2] + du * u[2]];
    const a0 = corner(A, -1, -1), a1 = corner(A, 1, -1), a2 = corner(A, 1, 1), a3 = corner(A, -1, 1);
    const b0 = corner(B, -1, -1), b1 = corner(B, 1, -1), b2 = corner(B, 1, 1), b3 = corner(B, -1, 1);
    this.quad(mat, a0, a1, b1, b0);
    this.quad(mat, a1, a2, b2, b1);
    this.quad(mat, a2, a3, b3, b2);
    this.quad(mat, a3, a0, b0, b3);
    this.fan(mat, [a0, a1, a2, a3], [-tn[0], -tn[1], -tn[2]]);
    this.fan(mat, [b0, b1, b2, b3], tn);
  }

  triangleCount() {
    let n = 0;
    for (const g of this.groups.values()) n += g.idx.length / 3;
    return n;
  }
}

/** Rectangle with 45° chamfers on all four corners (profile in a 2D plane). */
export function octagonProfile(w, h, c) {
  const hw = w / 2, hh = h / 2;
  return [
    [-hw + c, -hh], [hw - c, -hh], [hw, -hh + c], [hw, hh - c],
    [hw - c, hh], [-hw + c, hh], [-hw, hh - c], [-hw, -hh + c],
  ];
}

// ── Plan-view nose arcs ──────────────────────────────────────────────────────

/**
 * Rounded nose arc in plan view: [x,z] points from left (−hw at zStart)
 * through the tip (zStart − depth) to right (+hw at zStart). `p` shapes the
 * bluntness (<1 = blunter/wider tip, >1 = pointier).
 */
export function noseArc({ hw, zStart, depth, p = 1, n = 10 }) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const th = -Math.PI / 2 + (i / n) * Math.PI;
    pts.push([hw * Math.sin(th), zStart - depth * Math.pow(Math.cos(th), p)]);
  }
  return pts;
}

/** Angular "Porsche wedge" arc: flat front panel + straight cheek facets. */
export function wedgeArc({ hw, zStart, depth, frontW, n = 10 }) {
  // n+1 points total; distribute: 2 cheeks × k points + front flat
  const anchors = [
    [-hw, zStart],
    [-hw * 0.94, zStart - depth * 0.45],
    [-frontW / 2, zStart - depth * 0.96],
    [-frontW / 4, zStart - depth],
    [frontW / 4, zStart - depth],
    [frontW / 2, zStart - depth * 0.96],
    [hw * 0.94, zStart - depth * 0.45],
    [hw, zStart],
  ];
  return resamplePolyline(anchors, n);
}

/** Resample a 2D polyline to exactly n+1 evenly spaced points. */
export function resamplePolyline(pts, n) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const total = cum[cum.length - 1];
  const out = [];
  for (let i = 0; i <= n; i++) {
    const s = (i / n) * total;
    let j = 1;
    while (j < cum.length - 1 && cum[j] < s) j++;
    const t = (s - cum[j - 1]) / (cum[j] - cum[j - 1] || 1);
    out.push([
      pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * t,
      pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * t,
    ]);
  }
  return out;
}

/** Mirror a plan arc to the rear (+Z) and reverse order so ribbons wind outward. */
export function mirrorArcZ(arc) {
  return [...arc].reverse().map(([x, z]) => [x, -z]);
}

/** Lift a plan arc to 3D at height y. */
export function arcAt(arc, y) {
  return arc.map(([x, z]) => [x, y, z]);
}

/** Interpolated z of an arc at a given x (first crossing, left→right). */
export function arcZAtX(arc, x) {
  for (let i = 0; i < arc.length - 1; i++) {
    const [x0, z0] = arc[i], [x1, z1] = arc[i + 1];
    if ((x0 <= x && x <= x1) || (x1 <= x && x <= x0)) {
      const t = (x - x0) / (x1 - x0 || 1);
      return z0 + (z1 - z0) * t;
    }
  }
  return arc[Math.floor(arc.length / 2)][1];
}

/** Deepest z of an arc (tip). */
export function arcTipZ(arc) {
  return Math.min(...arc.map(([, z]) => z));
}

// ── Wall builder ─────────────────────────────────────────────────────────────

/**
 * Fill a wall run with alternating pillar/window segments summing to `len`.
 * Returns segment list [{t:'panel'|'win', len}].
 */
export function windowRun(len, targetWin = 1.3, pillar = 0.16) {
  const n = Math.max(1, Math.round((len - pillar) / (targetWin + pillar)));
  const win = (len - (n + 1) * pillar) / n;
  const segs = [{ t: 'panel', len: pillar }];
  for (let i = 0; i < n; i++) {
    segs.push({ t: 'win', len: win }, { t: 'panel', len: pillar });
  }
  return segs;
}

export const seg = (t, len) => ({ t, len });

/**
 * Distribute a wall run: fixed-size items (doors) + weighted 'run' items that
 * expand to pillar/window alternations filling the remaining length exactly.
 */
export function wallSegs(wallLen, items, winOpts = {}) {
  const fixed = items.filter((i) => i.t !== 'run').reduce((s, i) => s + i.len, 0);
  const wsum = items.filter((i) => i.t === 'run').reduce((s, i) => s + (i.weight ?? 1), 0);
  const rem = wallLen - fixed;
  if (rem < -1e-6) throw new Error(`wallSegs overflow: fixed ${fixed} > wall ${wallLen}`);
  const out = [];
  for (const i of items) {
    if (i.t === 'run') {
      out.push(...windowRun((rem * (i.weight ?? 1)) / wsum, winOpts.targetWin, winOpts.pillar));
    } else {
      out.push(i);
    }
  }
  return out;
}

/**
 * Build one side wall from a segment list.
 * cfg: {
 *   side: +1 (right, +x) | -1 (left), xw: outer half-width,
 *   z0: wall start (toward front), segments: [{t, len}],
 *   y0, sill, winTop, yTop  — wall bottom, window sill, window top, wall top
 *   mats: { lower, upper, pillar, glass, door, frame },
 *   doorLowY — doors drop to this y (defaults y0), glassInset, doorInset
 * }
 */
export function buildWall(mb, cfg) {
  const {
    side, xw, z0, segments, y0, sill, winTop, yTop, mats,
    doorLowY = cfg.y0, glassInset = 0.05, doorInset = 0.03, ventY,
  } = cfg;
  const x = side * xw;
  const xg = side * (xw - glassInset);
  const xd = side * (xw - doorInset);
  let z = z0;
  for (const s of segments) {
    const z1 = z + s.len;
    if (s.t === 'panel') {
      mb.rectX(mats.lower, x, z, z1, y0, sill, side);
      mb.rectX(mats.pillar ?? mats.upper, x, z, z1, sill, winTop, side);
      mb.rectX(mats.upper, x, z, z1, winTop, yTop, side);
    } else if (s.t === 'win') {
      mb.rectX(mats.lower, x, z, z1, y0, sill, side);
      mb.rectX(mats.glass, xg, z, z1, sill, winTop, side);
      mb.rectX(mats.upper, x, z, z1, winTop, yTop, side);
      // jambs (sill up-facing, header down-facing, sides inward)
      const [xi, xo] = side > 0 ? [xg, x] : [x, xg];
      mb.rectY(mats.upper, sill, xi, xo, z, z1, 1);
      mb.rectY(mats.upper, winTop, xi, xo, z, z1, -1);
      mb.rectZ(mats.upper, z, xi, xo, sill, winTop, 1);
      mb.rectZ(mats.upper, z1, xi, xo, sill, winTop, -1);
      // sliding-vent divider strip across the window (classic Tatra glazing)
      if (ventY) {
        mb.rectX(mats.upper, side * (xw - glassInset + 0.015), z, z1, ventY - 0.018, ventY + 0.018, side);
      }
    } else if (s.t === 'door') {
      const f = 0.05; // frame strip width at outer plane
      const yd = s.lowY ?? doorLowY;
      const dm = s.mat ?? mats.door;
      // outer frame strips
      mb.rectX(mats.frame ?? mats.lower, x, z, z + f, yd, yTop, side);
      mb.rectX(mats.frame ?? mats.lower, x, z1 - f, z1, yd, yTop, side);
      mb.rectX(s.topMat ?? mats.upper, x, z, z1, winTop, yTop, side);
      // recessed door panel: solid below sill, glass above
      mb.rectX(dm, xd, z + f, z1 - f, yd, sill, side);
      const xdg = side * (xw - doorInset - 0.015);
      mb.rectX(dm, xd, z + f, z + f + 0.09, sill, winTop, side);
      mb.rectX(dm, xd, z1 - f - 0.09, z1 - f, sill, winTop, side);
      mb.rectX(mats.glass, xdg, z + f + 0.09, z1 - f - 0.09, sill, winTop, side);
      // center split groove + grab handles on the leaves
      const zc = (z + z1) / 2;
      mb.rectX('black', side * (xw - doorInset + 0.005), zc - 0.015, zc + 0.015, yd, winTop, side);
      for (const dz of [-0.12, 0.12]) {
        mb.box('trim', {
          x: side * (xw - doorInset + 0.012), y: 1.35, z: zc + dz,
          w: 0.02, h: 0.55, d: 0.035,
        });
      }
      // jambs
      const [xi, xo] = side > 0 ? [xd, x] : [x, xd];
      mb.rectY(mats.frame ?? mats.lower, yTop, xi, xo, z + f, z1 - f, -1);
      mb.rectZ(mats.frame ?? mats.lower, z + f, xi, xo, yd, winTop, 1);
      mb.rectZ(mats.frame ?? mats.lower, z1 - f, xi, xo, yd, winTop, -1);
      // if the door drops below the wall bottom, close the underside
      if (yd < y0 - 1e-6) {
        mb.rectY(dm, yd, xi, xo, z + f, z1 - f, -1);
      }
    }
    z = z1;
  }
  return z;
}

// ── Shared tram parts ────────────────────────────────────────────────────────

/** Bogie: dark frame, side frames + 4 wheels (2 axles), under the skirt. */
export function bogie(mb, { z, width, axleSpacing = 1.8, wheelR = 0.33 }) {
  mb.box('trim', { x: 0, y: 0.42, z, w: width - 0.75, h: 0.42, d: axleSpacing + 0.7 });
  const xOff = width / 2 - 0.32;
  for (const sx of [-1, 1]) {
    mb.box('trim', { x: sx * (width / 2 - 0.16), y: 0.44, z, w: 0.1, h: 0.28, d: axleSpacing + 0.45 });
  }
  for (const dz of [-axleSpacing / 2, axleSpacing / 2]) {
    for (const sx of [-1, 1]) {
      mb.cylinder('black', {
        x: sx * xOff, y: wheelR, z: z + dz,
        r: wheelR, len: 0.1, axis: 'x', seg: 16,
      });
    }
  }
}

/** Lateral roof ribs (classic Tatra roofs). */
export function roofRibs(mb, { z0, z1, xw, y, count, mat = 'roof' }) {
  for (let i = 0; i < count; i++) {
    const z = z0 + ((i + 0.5) / count) * (z1 - z0);
    mb.box(mat, { x: 0, y: y + 0.015, z, w: 2 * (xw - 0.32), h: 0.035, d: 0.06 });
  }
}

/** Small equipment boxes hanging along the skirt line. */
export function skirtBoxes(mb, { zs, width, y = 0.28, h = 0.2 }) {
  for (const z of zs) {
    mb.box('trim', { x: 0, y, z, w: width - 0.4, h, d: 0.55 });
  }
}

/** Coupler head tucked under a cab mask (dark, below the skirt line). */
export function coupler(mb, { zEnd, dir }) {
  mb.beam('trim', [0, 0.32, zEnd - dir * 0.6], [0, 0.26, zEnd - dir * 0.14], 0.09);
  mb.box('trim', { x: 0, y: 0.26, z: zEnd - dir * 0.12, w: 0.24, h: 0.16, d: 0.18 });
}

/** Continuous under-floor equipment box (narrow so wheels stay visible). */
export function underframe(mb, { z0, z1, width, y0 }) {
  mb.box('trim', {
    x: 0, y: (0.16 + y0) / 2, z: (z0 + z1) / 2,
    w: width - 1.0, h: y0 - 0.16, d: z1 - z0,
  });
}

/** Classic T3 scissor pantograph (brass-yellow on Prague cars). */
export function scissorPantograph(mb, { z, yRoof, mat = 'brass' }) {
  const arm = 0.045;
  // 4 base insulators + base frame
  for (const [dx, dz] of [[-0.5, -0.55], [0.5, -0.55], [-0.5, 0.55], [0.5, 0.55]]) {
    mb.cylinder('trim', { x: dx, y: yRoof + 0.06, z: z + dz, r: 0.045, len: 0.12, axis: 'y', seg: 8 });
  }
  const yB = yRoof + 0.12;
  const yM = yRoof + 0.34, yT = yRoof + 0.5;
  for (const sx of [-1, 1]) {
    const x = sx * 0.42;
    // lower arms (crossing diagonals of the scissor)
    mb.beam(mat, [x, yB, z - 0.6], [x, yM, z + 0.25], arm);
    mb.beam(mat, [x, yB, z + 0.6], [x, yM, z - 0.25], arm);
    // upper arms to the collector
    mb.beam(mat, [x, yM, z + 0.25], [x * 0.6, yT, z + 0.02], arm);
    mb.beam(mat, [x, yM, z - 0.25], [x * 0.6, yT, z - 0.02], arm);
  }
  // cross bars + collector head
  mb.beam(mat, [-0.42, yM, z + 0.25], [0.42, yM, z + 0.25], 0.035);
  mb.beam(mat, [-0.42, yM, z - 0.25], [0.42, yM, z - 0.25], 0.035);
  mb.box(mat, { x: 0, y: yT + 0.02, z, w: 1.9, h: 0.045, d: 0.24 });
}

/** Modern single-arm (half) pantograph, folded low (fits under y = roof+0.45). */
export function singleArmPantograph(mb, { z, yRoof, mat = 'trim' }) {
  const arm = 0.05;
  mb.box('trim', { x: 0, y: yRoof + 0.06, z, w: 1.1, h: 0.12, d: 1.7 });
  const yB = yRoof + 0.12;
  const elbowZ = z - 0.75, headZ = z + 0.55;
  const yE = yRoof + 0.3, yH = yRoof + 0.36;
  for (const sx of [-1, 1]) {
    mb.beam(mat, [sx * 0.16, yB, z + 0.65], [sx * 0.05, yE, elbowZ], arm);
  }
  mb.beam(mat, [0, yE, elbowZ], [0, yH, headZ], arm * 0.9);
  mb.beam(mat, [0, yB + 0.02, z + 0.75], [0, yE - 0.06, elbowZ + 0.12], 0.025); // balance rod
  mb.box(mat, { x: 0, y: yH + 0.02, z: headZ, w: 1.8, h: 0.045, d: 0.22 });
  for (const sx of [-1, 1]) {
    mb.beam(mat, [sx * 0.88, yH, headZ - 0.1], [sx * 0.72, yH - 0.1, headZ - 0.28], 0.03); // horns
  }
}

/** Roof-mounted AC pod / equipment box with chamfered edges. */
export function roofPod(mb, { z, y, w = 1.5, h = 0.26, d = 2.2, mat = 'roof' }) {
  mb.box(mat, { x: 0, y: y + h / 2, z, w, h, d, bevel: Math.min(0.06, h / 3) });
}

/** Articulation bellows filling the rear `depth` of a section. */
export function bellows(mb, { zEnd, width, y0, yTop, depth = 0.28 }) {
  const n = 4;
  const step = depth / n;
  for (let i = 0; i < n; i++) {
    const w = i % 2 === 0 ? width - 0.14 : width - 0.3;
    mb.box('black', {
      x: 0, y: (y0 + yTop) / 2, z: zEnd - depth + step * (i + 0.5),
      w, h: yTop - y0, d: step,
    });
  }
}

/** Thin dark frame ring at a section's leading articulated end. */
export function jointFrame(mb, { z, width, y0, yTop }) {
  mb.box('black', { x: 0, y: (y0 + yTop) / 2, z: z + 0.03, w: width - 0.16, h: yTop - y0, d: 0.06 });
}

/**
 * Destination display: black casing + emissive warm-white face.
 * dir: -1 → faces −Z (front), +1 → faces +Z (rear cab).
 */
export function destinationDisplay(mb, { zFace, y, w = 0.95, h = 0.22, dir = -1, x = 0 }) {
  mb.box('black', { x, y, z: zFace - dir * 0.09, w: w + 0.08, h: h + 0.06, d: 0.16 });
  mb.rectZ('display', zFace, x - w / 2, x + w / 2, y - h / 2, y + h / 2, dir);
}

/** Round headlight/taillight: trim ring + emissive face. dir as above. */
export function roundLamp(mb, { x, y, zFace, r = 0.13, mat = 'headlight', dir = -1 }) {
  mb.cylinder('trim', {
    x, y, z: zFace - dir * 0.05, r: r + 0.02, len: 0.1, axis: 'z', seg: 12, caps: false,
  });
  mb.cylinder(mat, { x, y, z: zFace - dir * 0.02, r, len: 0.05, axis: 'z', seg: 12, caps: true, capMat: mat });
}

/** Simple flat end wall (articulated end cross-section). */
export function endWall(mb, { z, xw, y0, sill, yTop, dir, matLower, matUpper }) {
  mb.rectZ(matLower, z, -xw, xw, y0, sill, dir);
  mb.rectZ(matUpper, z, -xw, xw, sill, yTop, dir);
}

/** Close the floor (down-facing) under the section. */
export function floorPlate(mb, { z0, z1, xw, y0 }) {
  mb.rectY('trim', y0 + 0.01, -xw + 0.02, xw - 0.02, z0, z1, -1);
}

/**
 * Trapezoid roof prism from yTop to roofTop over [z0, z1].
 * shrink: horizontal inset of the roof top plateau.
 */
export function roofSlab(mb, { z0, z1, xw, yTop, roofTop, mat = 'roof', shrink = 0.22, caps = true }) {
  const profile = [
    [-xw, yTop], [xw, yTop], [xw - shrink, roofTop], [-xw + shrink, roofTop],
  ];
  mb.prismZ(mat, profile, z0, z1, { capStart: caps, capEnd: caps });
}

// ── Nose (cab end) builder ───────────────────────────────────────────────────

/**
 * Stack ribbon bands over plan arcs to form a cab nose (front dir = -1 → −Z
 * end) or tail (dir = +1). Bands: [{ y0, y1, mat, arc0, arc1 }] where arcs are
 * plan arcs already in final orientation. Adds a flat top cap at capY.
 */
export function noseBands(mb, { bands, capMat = 'roof', capCorners }) {
  let topBand = null;
  for (const b of bands) {
    mb.ribbon(b.mat, arcAt(b.arc0, b.y0), arcAt(b.arc1, b.y1));
    topBand = b;
  }
  if (topBand && capCorners) {
    const pts = [...arcAt(topBand.arc1, topBand.y1), ...capCorners.map(([x, z]) => [x, topBand.y1, z])];
    mb.fan(capMat, pts, [0, 1, 0]);
  }
}

// ── Section shell (common skeleton for every body section) ──────────────────

/**
 * Build the common part of one articulated section: side walls, roof slab,
 * floor plate, underframe, bogies, and the articulated-end treatments.
 * Cab ends (noses/tails) are added by the per-model builders.
 *
 * cfg: {
 *   length, width, y0, sill, winTop, yTop, roofTop,
 *   front: 'cab' | 'joint', rear: 'cab' | 'bellows' | 'joint',
 *   noseDepthF, noseDepthR, rightItems, leftItems (for wallSegs),
 *   mats { lower, upper, pillar?, glass, door, frame? }, roofMat,
 *   bogies: [z...], doorLowY?, roofShrink?, winOpts?
 * }
 * Returns { z0, z1 } — the wall extent (nose regions excluded).
 */
export function buildSectionShell(mb, cfg) {
  const {
    length, width, y0, sill, winTop, yTop, roofTop,
    front, rear, noseDepthF = 0, noseDepthR = 0,
    rightItems, leftItems, mats, roofMat = 'roof',
    bogies: bogieZs = [], doorLowY, roofShrink = 0.22, winOpts,
  } = cfg;
  const hw = width / 2;
  const L2 = length / 2;
  const z0 = front === 'cab' ? -L2 + noseDepthF : -L2 + 0.06;
  const z1 = rear === 'cab' ? L2 - noseDepthR : rear === 'bellows' ? L2 - 0.28 : L2 - 0.06;
  const wallLen = z1 - z0;

  const common = { xw: hw, z0, y0, sill, winTop, yTop, mats, doorLowY, ventY: cfg.ventY };
  buildWall(mb, { ...common, side: 1, segments: wallSegs(wallLen, rightItems, winOpts) });
  buildWall(mb, { ...common, side: -1, segments: wallSegs(wallLen, leftItems, winOpts) });

  roofSlab(mb, { z0, z1, xw: hw, yTop, roofTop, mat: roofMat, shrink: roofShrink });
  floorPlate(mb, { z0, z1, xw: hw, y0 });
  underframe(mb, { z0: z0 + 0.15, z1: z1 - 0.15, width, y0 });
  for (const bz of bogieZs) bogie(mb, { z: bz, width });

  if (front === 'joint') {
    jointFrame(mb, { z: -L2, width, y0, yTop });
    endWall(mb, { z: z0, xw: hw, y0, sill, yTop, dir: -1, matLower: mats.lower, matUpper: mats.upper });
  }
  if (rear === 'bellows') {
    endWall(mb, { z: z1, xw: hw, y0, sill, yTop, dir: 1, matLower: mats.lower, matUpper: mats.upper });
    bellows(mb, { zEnd: L2, width, y0: y0 + 0.05, yTop: yTop - 0.02 });
  } else if (rear === 'joint') {
    jointFrame(mb, { z: L2 - 0.06, width, y0, yTop });
    endWall(mb, { z: z1, xw: hw, y0, sill, yTop, dir: 1, matLower: mats.lower, matUpper: mats.upper });
  }
  return { z0, z1 };
}

// ── GLB assembly + validation ────────────────────────────────────────────────

export async function writeSectionGlb({ outPath, name, mb }) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene(name);
  doc.getRoot().setDefaultScene(scene);
  const mesh = doc.createMesh(name);

  for (const [matName, g] of mb.groups) {
    const def = MATERIALS[matName];
    const base = ColorUtils.hexToFactor(def.hex, [0, 0, 0, 1]);
    const mat = doc
      .createMaterial(matName)
      .setBaseColorFactor([base[0], base[1], base[2], 1])
      .setMetallicFactor(Math.min(def.metal ?? 0.1, 0.35))
      .setRoughnessFactor(def.rough ?? 0.6)
      .setDoubleSided(false);
    if (def.emissive) mat.setEmissiveFactor(def.emissive);
    const pos = doc.createAccessor().setType('VEC3').setArray(new Float32Array(g.pos)).setBuffer(buffer);
    const nrm = doc.createAccessor().setType('VEC3').setArray(new Float32Array(g.nrm)).setBuffer(buffer);
    const IndexArray = g.pos.length / 3 > 65535 ? Uint32Array : Uint16Array;
    const idx = doc.createAccessor().setType('SCALAR').setArray(new IndexArray(g.idx)).setBuffer(buffer);
    mesh.addPrimitive(
      doc.createPrimitive()
        .setAttribute('POSITION', pos)
        .setAttribute('NORMAL', nrm)
        .setIndices(idx)
        .setMaterial(mat),
    );
  }

  scene.addChild(doc.createNode(name).setMesh(mesh));
  await doc.transform(weld(), dedup(), prune());

  const glb = await new NodeIO().writeBinary(doc);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, glb);
  return glb.byteLength;
}

/** Read a GLB back and report bbox + triangle count (validation step). */
export async function readGlbStats(path) {
  const doc = await new NodeIO().read(path);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let tris = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const posAcc = prim.getAttribute('POSITION');
      const arr = posAcc.getArray();
      for (let i = 0; i < arr.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          if (arr[i + k] < min[k]) min[k] = arr[i + k];
          if (arr[i + k] > max[k]) max[k] = arr[i + k];
        }
      }
      const idxAcc = prim.getIndices();
      tris += (idxAcc ? idxAcc.getCount() : posAcc.getCount()) / 3;
    }
  }
  return {
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    tris,
  };
}
