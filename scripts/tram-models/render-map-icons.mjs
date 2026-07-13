// Map sprite generator: SymbolLayer icons for the far/mid tram zoom bands.
// Produces assets/images/map-icons/*.png (all @4x raw pixels — the app
// registers them with scale=MAP_ICON_SCALE and sizes them via iconSize):
//
//   dot-day / dot-night / dot-day-fav / dot-night-fav
//       Direction teardrops (Flightradar-style) for the far-zoom band and the
//       mid-zoom heading pointer. PID red / night navy fill, white outline
//       (gold outline = favorite) — readable on light AND dark basemaps.
//   cap-<modelId>-day / cap-<modelId>-night   (7 models × 2)
//       Mid-zoom capsule badges: line-number seat on the left (number itself
//       is a live SymbolLayer text), a two-tone SIDE silhouette of the model
//       on the right — rendered orthographically from the real GLBs (cream
//       body, dark glass; the tail fades at the capsule edge like the tram is
//       sliding out of frame). Silhouette scale is shared across models, so a
//       14 m T3 visibly differs from a 31 m 15T.
//   fav-star
//       Small gold star pinned to the capsule corner of favorite trams.
//
// Usage: node scripts/tram-models/render-map-icons.mjs
//        (writes sprites + a human-checkable contact sheet /tmp/map-icons-sheet.png)
//
// Tooling (puppeteer + esbuild) is installed AD HOC — `npm i -D --no-save
// puppeteer esbuild` — and must NOT be added to package.json (three is already
// a runtime dep). Rendering happens inside headless Chrome (three.js WebGL +
// 2D canvas compositing), same approach as scripts/render-model.mjs.

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = join(root, 'assets/images/map-icons');

// Theme (src/constants/theme.ts Tram.*) — keep in sync by hand.
const PID_RED = '#7A0603';
const NIGHT_NAVY = '#20315C';
const CREAM = '#F5EBD8';
const GOLD = '#E0A526';

// modelId → ordered section GLBs (mirrors MODEL_SPECS in modelSpecs.ts).
const MODEL_GLBS = {
  t3: ['t3'],
  t3rp: ['t3rp'],
  t3rplf: ['t3rplf'],
  kt8d5: ['kt8d5-a', 'kt8d5-b', 'kt8d5-c'],
  '14t': ['14t-a', '14t-b', '14t-c', '14t-d', '14t-e'],
  '15t': ['15t-a', '15t-b', '15t-c'],
  '52t': ['52t-a', '52t-b', '52t-c', '52t-d', '52t-e'],
};

// Bundle three + GLTFLoader once (cached until the entry version changes).
const bundlePath = join(root, 'node_modules/.cache/map-icons-bundle-v1.js');
if (!existsSync(bundlePath)) {
  mkdirSync(dirname(bundlePath), { recursive: true });
  const entry = join(dirname(bundlePath), 'map-icons-entry.mjs');
  writeFileSync(
    entry,
    `
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Orthographic SIDE view (nose LEFT) of a consist, flat two-tone: body in
// bodyColor, glass in glassColor (detected: near-black + low roughness),
// transparent background. Returns { dataUrl, pxPerM, widthPx, heightPx }.
window.renderSideSilhouette = async function (base64List, bodyColor, glassColor) {
  const PX_PER_M = 40;
  const loader = new GLTFLoader();
  const group = new THREE.Group();
  let zCursor = 0;
  for (const b64 of base64List) {
    const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
    const gltf = await loader.parseAsync(buf, '');
    const obj = gltf.scene;
    const box = new THREE.Box3().setFromObject(obj);
    obj.position.z = zCursor - box.min.z;
    zCursor += box.max.z - box.min.z + 0.3;
    group.add(obj);
  }
  // Two-tone material swap. Glass in our GLBs: very dark color + roughness
  // ≤0.3 (MATERIALS.glass rough=0.16; trim/black are rough ≥0.6 → body).
  const toFlat = (m) => {
    const c = m.color ?? new THREE.Color(1, 1, 1);
    const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const isGlass = lum < 0.08 && (m.roughness ?? 1) <= 0.3;
    return new THREE.MeshBasicMaterial({ color: isGlass ? glassColor : bodyColor });
  };
  group.traverse((node) => {
    if (!node.isMesh) return;
    node.material = Array.isArray(node.material)
      ? node.material.map(toFlat)
      : toFlat(node.material);
  });
  const scene = new THREE.Scene();
  scene.background = null;
  scene.add(group);
  const total = new THREE.Box3().setFromObject(group);
  const size = total.getSize(new THREE.Vector3());
  const c = total.getCenter(new THREE.Vector3());
  const W = Math.ceil(size.z * PX_PER_M);
  const H = Math.ceil(size.y * PX_PER_M);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(W, H);
  renderer.setClearColor(0x000000, 0);
  // Camera on -X looking +X: screen-right = +Z → nose (−Z) on the LEFT.
  const cam = new THREE.OrthographicCamera(-size.z / 2, size.z / 2, size.y / 2, -size.y / 2, 0.1, 100);
  cam.position.set(c.x - 30, c.y, c.z);
  cam.lookAt(c.x, c.y, c.z);
  renderer.render(scene, cam);
  const dataUrl = renderer.domElement.toDataURL('image/png');
  renderer.dispose();
  return { dataUrl, pxPerM: PX_PER_M, widthPx: W, heightPx: H };
};
window.__ready = true;
`,
  );
  execSync(`npx esbuild ${entry} --bundle --format=iife --outfile=${bundlePath}`, {
    cwd: root,
    stdio: 'inherit',
  });
}
const bundle = readFileSync(bundlePath, 'utf8');

// ── 2D compositing (runs in the page; plain source injected as a script) ─────
const composeSrc = `
const CAP_W = 280, CAP_H = 80, CAP_R = 40;       // capsule sprite, @4x px
const BORDER = 6;                                 // cream outline
const SEAT = { x: 8, y: 8, w: 80, h: 64, r: 32 }; // line-number seat (darkened)
const SIL = { x: 100, y: 8, h: 64, fadeW: 36, right: CAP_W - 14 };
const SIL_TRAM_H = 50;                            // body height inside SIL box

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function loadImg(dataUrl) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = dataUrl;
  });
}

// Capsule badge: bg capsule + cream border + darkened number seat + side
// silhouette (nose left, tail alpha-fades at the right edge when cut).
window.makeCapsule = async function (silDataUrl, silPxPerM, bg) {
  const cv = document.createElement('canvas');
  cv.width = CAP_W; cv.height = CAP_H;
  const ctx = cv.getContext('2d');
  // border (drawn as outer capsule), then bg inset
  rr(ctx, 0, 0, CAP_W, CAP_H, CAP_R);
  ctx.fillStyle = '${CREAM}';
  ctx.fill();
  rr(ctx, BORDER, BORDER, CAP_W - 2 * BORDER, CAP_H - 2 * BORDER, CAP_R - BORDER);
  ctx.fillStyle = bg;
  ctx.fill();
  // number seat
  rr(ctx, SEAT.x, SEAT.y, SEAT.w, SEAT.h, SEAT.r);
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fill();
  // silhouette, clipped to the inner capsule
  const img = await loadImg(silDataUrl);
  const scale = SIL_TRAM_H / (3.45 * silPxPerM); // shared px/m across models
  const w = img.width * scale, h = img.height * scale;
  const sil = document.createElement('canvas');
  sil.width = CAP_W; sil.height = CAP_H;
  const sctx = sil.getContext('2d');
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(img, SIL.x, SIL.y + (SIL.h - h) / 2 + (SIL.h - SIL_TRAM_H) * 0, w, h);
  if (SIL.x + w > SIL.right) {
    // tail is cut → fade it out toward the capsule edge
    const g = sctx.createLinearGradient(SIL.right - SIL.fadeW, 0, SIL.right, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,1)');
    sctx.globalCompositeOperation = 'destination-out';
    sctx.fillStyle = g;
    sctx.fillRect(SIL.right - SIL.fadeW, 0, CAP_W - (SIL.right - SIL.fadeW), CAP_H);
    sctx.globalCompositeOperation = 'source-over';
  }
  ctx.save();
  rr(ctx, BORDER + 1, BORDER + 1, CAP_W - 2 * BORDER - 2, CAP_H - 2 * BORDER - 2, CAP_R - BORDER);
  ctx.clip();
  ctx.drawImage(sil, 0, 0);
  ctx.restore();
  return cv.toDataURL('image/png');
};

// Direction teardrop, pointing UP (rotated by iconRotate=bearing at runtime).
window.makeDot = function (fill, outline) {
  const S = 96;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const ctx = cv.getContext('2d');
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(48, 8);                    // tip (north)
    ctx.quadraticCurveTo(69, 36, 71, 58);
    ctx.arc(48, 58, 23, 0, Math.PI);      // rounded stern
    ctx.quadraticCurveTo(27, 36, 48, 8);
    ctx.closePath();
  };
  path();
  ctx.lineWidth = 9;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = outline;
  ctx.stroke();
  path();
  ctx.fillStyle = fill;
  ctx.fill();
  // small heading notch for extra direction salience
  ctx.beginPath();
  ctx.moveTo(48, 22);
  ctx.lineTo(58, 46);
  ctx.quadraticCurveTo(48, 40, 38, 46);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fill();
  return cv.toDataURL('image/png');
};

window.makeStar = function () {
  const S = 72;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const ctx = cv.getContext('2d');
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 30 : 13;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = 36 + r * Math.cos(a), y = 36 + r * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.lineWidth = 7;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#FFFFFF';
  ctx.stroke();
  ctx.fillStyle = '${GOLD}';
  ctx.fill();
  return cv.toDataURL('image/png');
};

// Contact sheet for human review: all sprites over light + dark map-ish tiles.
window.makeSheet = async function (entries) {
  const cell = 320, cols = 4;
  const rows = Math.ceil(entries.length / cols);
  const cv = document.createElement('canvas');
  cv.width = cell * cols; cv.height = cell * rows * 2;
  const ctx = cv.getContext('2d');
  for (const [half, bg] of [[0, '#e9e5dc'], [1, '#171a21']]) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, half * cell * rows, cv.width, cell * rows);
    for (let i = 0; i < entries.length; i++) {
      const [name, dataUrl] = entries[i];
      const img = await loadImg(dataUrl);
      const x = (i % cols) * cell, y = half * cell * rows + Math.floor(i / cols) * cell;
      ctx.drawImage(img, x + (cell - img.width) / 2, y + (cell - img.height) / 2);
      ctx.fillStyle = half ? '#ccc' : '#333';
      ctx.font = '20px sans-serif';
      ctx.fillText(name, x + 16, y + cell - 16);
    }
  }
  return cv.toDataURL('image/png');
};
`;

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--enable-webgl', '--disable-gpu-sandbox'],
});
try {
  const page = await browser.newPage();
  page.on('console', (m) => console.log('[page]', m.text()));
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({ content: composeSrc });
  await page.waitForFunction('window.__ready === true', { timeout: 15000 });

  mkdirSync(OUT_DIR, { recursive: true });
  const written = [];
  const save = (name, dataUrl) => {
    writeFileSync(join(OUT_DIR, `${name}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
    written.push([name, dataUrl]);
  };

  // Dots: day/night × normal/favorite-outline.
  save('dot-day', await page.evaluate((f, o) => window.makeDot(f, o), PID_RED, '#FFFFFF'));
  save('dot-night', await page.evaluate((f, o) => window.makeDot(f, o), NIGHT_NAVY, '#FFFFFF'));
  save('dot-day-fav', await page.evaluate((f, o) => window.makeDot(f, o), PID_RED, GOLD));
  save('dot-night-fav', await page.evaluate((f, o) => window.makeDot(f, o), NIGHT_NAVY, GOLD));
  save('fav-star', await page.evaluate(() => window.makeStar()));

  // Capsules: per model, day + night backgrounds (shared silhouette render).
  for (const [modelId, sections] of Object.entries(MODEL_GLBS)) {
    const glbs = sections.map((k) =>
      readFileSync(join(root, 'assets/models', `${k}.glb`)).toString('base64'),
    );
    const sil = await page.evaluate(
      (list, body, glass) => window.renderSideSilhouette(list, body, glass),
      glbs,
      CREAM,
      '#191521',
    );
    save(
      `cap-${modelId}-day`,
      await page.evaluate((s, p, bg) => window.makeCapsule(s, p, bg), sil.dataUrl, sil.pxPerM, PID_RED),
    );
    save(
      `cap-${modelId}-night`,
      await page.evaluate((s, p, bg) => window.makeCapsule(s, p, bg), sil.dataUrl, sil.pxPerM, NIGHT_NAVY),
    );
    console.log(`rendered cap-${modelId} (${sil.widthPx}×${sil.heightPx} silhouette)`);
  }

  const sheet = await page.evaluate((e) => window.makeSheet(e), written);
  writeFileSync('/tmp/map-icons-sheet.png', Buffer.from(sheet.split(',')[1], 'base64'));
  console.log(`wrote ${written.length} sprites → ${OUT_DIR}`);
  console.log('contact sheet → /tmp/map-icons-sheet.png');
} finally {
  await browser.close();
}
