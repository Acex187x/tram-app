// Face sprite generator: rasterizes the SAME vector faces the app renders
// (src/components/tram/faces/packs/<packId>/*.tsx via TramFace) into
// transparent PNG map sprites, one per pack × model, at FACE_SPRITE_SCALE (3×)
// raw pixels:
//
//   assets/images/faces/<packId>/<modelId>.png     (192×192, transparent)
//
// registered by src/lib/fleet/iconPacks.ts (ICON_PACKS[pack].sprites).
//
// How: esbuild bundles the real pack index.tsx files with `react-native-svg`
// aliased to plain SVG string tags, a tiny serializer walks the React element
// tree into SVG markup, and sharp (librsvg) rasterizes it. Single source of
// truth — a sprite can't drift from the in-app vector.
//
// Also writes a human-checkable contact sheet (every pack's 7 faces over
// light + dark tiles) to /tmp/face-sprites-sheet.png.
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

// Keep in sync with FACE_SPRITE_SCALE in src/lib/fleet/iconPacks.ts.
const SPRITE_SCALE = 3;
const SPRITE_PX = 64 * SPRITE_SCALE;

const PACK_IDS = ['classic', 'side', 'iso', 'chibi'];
const MODEL_IDS = ['t3', 't3rp', 't3rplf', 'kt8d5', '14t', '15t', '52t'];

// ── Bundle the real pack components (react-native-svg → string tags) ─────────
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
export const Text = 'text';
export const TSpan = 'tspan';
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
  PACK_IDS.map(
    (id) =>
      `import { FACES as ${id} } from '${join(
        root,
        `src/components/tram/faces/packs/${id}/index.tsx`,
      )}';`,
  ).join('\n') +
    `\nexport const PACKS = { ${PACK_IDS.join(', ')} };\n`,
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
    `--alias:@=${join(root, 'src')}`,
    `--outfile=${bundlePath}`,
  ].join(' '),
  { cwd: root, stdio: 'inherit' },
);

const { PACKS } = await import(pathToFileURL(bundlePath).href);

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
  // React fragments (and any other symbol-typed element): emit children only.
  if (typeof type === 'symbol') return serialize(props?.children);
  const { children, ...attrs } = props ?? {};
  const attrStr = Object.entries(attrs)
    .filter(([, v]) => v != null && (typeof v === 'string' || typeof v === 'number'))
    .map(([k, v]) => ` ${attrName(k)}="${v}"`)
    .join('');
  const inner = serialize(children);
  return inner ? `<${type}${attrStr}>${inner}</${type}>` : `<${type}${attrStr}/>`;
}

function faceSvg(packId, modelId, sizePx) {
  const el = PACKS[packId][modelId]({ size: sizePx });
  const markup = serialize(el);
  if (!markup.startsWith('<svg')) {
    throw new Error(`face ${packId}/${modelId}: root is not <svg>`);
  }
  return markup.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
}

// ── Rasterize sprites ────────────────────────────────────────────────────────
let count = 0;
for (const packId of PACK_IDS) {
  const dir = join(OUT_DIR, packId);
  mkdirSync(dir, { recursive: true });
  for (const id of MODEL_IDS) {
    const svg = faceSvg(packId, id, SPRITE_PX);
    const out = join(dir, `${id}.png`);
    await sharp(Buffer.from(svg)).png().toFile(out);
    count++;
    console.log(`rendered ${packId}/${id}.png (${SPRITE_PX}×${SPRITE_PX})`);
  }
}
console.log(`wrote ${count} sprites → ${OUT_DIR}`);

// ── Contact sheet: every pack over light + dark map-ish tiles ────────────────
{
  const cell = 240;
  const pad = (cell - SPRITE_PX) / 2;
  const cols = MODEL_IDS.length;
  const label = (text, x, y, color) =>
    `<text x="${x}" y="${y}" font-family="Helvetica, sans-serif" font-size="20" fill="${color}" text-anchor="middle">${text}</text>`;
  const tiles = [
    { bg: '#ECE7DC', fg: '#3A362F' },
    { bg: '#171A21', fg: '#C9CCD4' },
  ];
  const parts = [];
  let rowY = 0;
  for (const packId of PACK_IDS) {
    for (const tile of tiles) {
      parts.push(
        `<rect x="0" y="${rowY}" width="${cols * cell}" height="${cell}" fill="${tile.bg}"/>`,
      );
      MODEL_IDS.forEach((id, i) => {
        const inner = faceSvg(packId, id, SPRITE_PX).replace(
          '<svg ',
          `<svg x="${i * cell + pad}" y="${rowY + pad - 8}" `,
        );
        parts.push(inner);
        parts.push(label(`${packId}/${id}`, i * cell + cell / 2, rowY + cell - 12, tile.fg));
      });
      rowY += cell;
    }
  }
  const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cell}" height="${rowY}">${parts.join('')}</svg>`;
  await sharp(Buffer.from(sheet)).png().toFile(SHEET_PATH);
  console.log(`contact sheet → ${SHEET_PATH}`);
}
