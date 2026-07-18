// Face sprite generator: rasterizes the SAME vector faces the app renders
// (src/components/tram/faces/*.tsx via TramFace) into transparent PNG sprites
// for the map, at FACE_SPRITE_SCALE (3×) raw pixels:
//
//   assets/images/faces/<modelId>.png     (192×192, transparent)
//
// registered by src/lib/fleet/faceIcons.ts (FACE_SPRITE_ASSETS).
//
// How: esbuild bundles the real .tsx components with `react-native-svg`
// aliased to plain SVG string tags, a tiny serializer walks the React element
// tree into SVG markup, and sharp (librsvg) rasterizes it. Single source of
// truth — the sprite can't drift from the in-app vector.
//
// Also writes a human-checkable contact sheet (all 7 faces over light + dark
// tiles) to /tmp/face-sprites-sheet.png.
//
// Usage:   node scripts/tram-models/render-face-sprites.mjs
// Tooling is installed AD HOC — `npm i -D --no-save puppeteer sharp esbuild`
// — and must NOT be added to package.json.

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = join(root, 'assets/images/faces');
const SHEET_PATH = '/tmp/face-sprites-sheet.png';

// Keep in sync with FACE_SPRITE_SCALE in src/lib/fleet/faceIcons.ts.
const SPRITE_SCALE = 3;
const SPRITE_PX = 64 * SPRITE_SCALE;

const MODEL_IDS = ['t3', 't3rp', 't3rplf', 'kt8d5', '14t', '15t', '52t'];

// ── Bundle the real face components (react-native-svg → string tags) ─────────
const cacheDir = join(root, 'node_modules/.cache/face-sprites');
mkdirSync(cacheDir, { recursive: true });

const shimPath = join(cacheDir, 'rn-svg-shim.mjs');
writeFileSync(
  shimPath,
  `// react-native-svg → plain SVG element tag names (for serialization).
export default 'svg';
export const Path = 'path';
export const Rect = 'rect';
export const Circle = 'circle';
export const Ellipse = 'ellipse';
export const Line = 'line';
export const Polygon = 'polygon';
export const Polyline = 'polyline';
export const G = 'g';
export const Defs = 'defs';
export const LinearGradient = 'linearGradient';
export const RadialGradient = 'radialGradient';
export const Stop = 'stop';
export const ClipPath = 'clipPath';
`,
);

const entryPath = join(cacheDir, 'entry.mjs');
writeFileSync(
  entryPath,
  `import { Face14T } from '${join(root, 'src/components/tram/faces/14t.tsx')}';
import { Face15T } from '${join(root, 'src/components/tram/faces/15t.tsx')}';
import { Face52T } from '${join(root, 'src/components/tram/faces/52t.tsx')}';
import { FaceKT8D5 } from '${join(root, 'src/components/tram/faces/kt8d5.tsx')}';
import { FaceT3 } from '${join(root, 'src/components/tram/faces/t3.tsx')}';
import { FaceT3RP } from '${join(root, 'src/components/tram/faces/t3rp.tsx')}';
import { FaceT3RPLF } from '${join(root, 'src/components/tram/faces/t3rplf.tsx')}';

export const FACES = {
  t3: FaceT3,
  t3rp: FaceT3RP,
  t3rplf: FaceT3RPLF,
  kt8d5: FaceKT8D5,
  '14t': Face14T,
  '15t': Face15T,
  '52t': Face52T,
};
`,
);

const bundlePath = join(cacheDir, 'faces-bundle.mjs');
execSync(
  [
    'npx esbuild',
    entryPath,
    '--bundle',
    '--format=esm',
    '--jsx=automatic',
    `--alias:react-native-svg=${shimPath}`,
    `--outfile=${bundlePath}`,
  ].join(' '),
  { cwd: root, stdio: 'inherit' },
);

const { FACES } = await import(pathToFileURL(bundlePath).href);

// ── React element tree → SVG markup ──────────────────────────────────────────
// Attributes that must keep their camelCase in SVG.
const KEEP_CAMEL = new Set([
  'viewBox',
  'gradientUnits',
  'gradientTransform',
  'preserveAspectRatio',
  'patternUnits',
  'clipPathUnits',
]);
const attrName = (k) => (KEEP_CAMEL.has(k) ? k : k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));

function serialize(node) {
  if (node == null || node === false || node === true) return '';
  if (Array.isArray(node)) return node.map(serialize).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  const { type, props } = node;
  if (typeof type === 'function') return serialize(type(props ?? {}));
  const { children, ...attrs } = props ?? {};
  const attrStr = Object.entries(attrs)
    .filter(([, v]) => v != null && (typeof v === 'string' || typeof v === 'number'))
    .map(([k, v]) => ` ${attrName(k)}="${v}"`)
    .join('');
  const inner = serialize(children);
  return inner ? `<${type}${attrStr}>${inner}</${type}>` : `<${type}${attrStr}/>`;
}

function faceSvg(modelId, sizePx) {
  const el = FACES[modelId]({ size: sizePx });
  const markup = serialize(el);
  if (!markup.startsWith('<svg')) throw new Error(`face ${modelId}: root is not <svg>`);
  return markup.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
}

// ── Rasterize sprites ────────────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true });
for (const id of MODEL_IDS) {
  const svg = faceSvg(id, SPRITE_PX);
  const out = join(OUT_DIR, `${id}.png`);
  await sharp(Buffer.from(svg)).png().toFile(out);
  console.log(`rendered ${id}.png (${SPRITE_PX}×${SPRITE_PX})`);
}
console.log(`wrote ${MODEL_IDS.length} sprites → ${OUT_DIR}`);

// ── Contact sheet: all faces over light + dark map-ish tiles ─────────────────
{
  const cell = 240;
  const pad = (cell - SPRITE_PX) / 2;
  const cols = MODEL_IDS.length;
  const label = (id, x, y, color) =>
    `<text x="${x}" y="${y}" font-family="Helvetica, sans-serif" font-size="20" fill="${color}" text-anchor="middle">${id}</text>`;
  const rows = [
    { bg: '#ECE7DC', fg: '#3A362F' },
    { bg: '#171A21', fg: '#C9CCD4' },
  ];
  const parts = [];
  rows.forEach((row, r) => {
    parts.push(`<rect x="0" y="${r * cell}" width="${cols * cell}" height="${cell}" fill="${row.bg}"/>`);
    MODEL_IDS.forEach((id, i) => {
      const inner = faceSvg(id, SPRITE_PX).replace(
        '<svg ',
        `<svg x="${i * cell + pad}" y="${r * cell + pad - 8}" `,
      );
      parts.push(inner);
      parts.push(label(id, i * cell + cell / 2, (r + 1) * cell - 12, row.fg));
    });
  });
  const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cell}" height="${rows.length * cell}">${parts.join('')}</svg>`;
  await sharp(Buffer.from(sheet)).png().toFile(SHEET_PATH);
  console.log(`contact sheet → ${SHEET_PATH}`);
}
