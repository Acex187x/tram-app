// Dev tool: render a GLB tram model to a PNG contact sheet (4 views) so humans
// and agents can SEE the model without launching the app.
// Usage: node scripts/render-model.mjs assets/models/15t-a.glb [out.png]
//        node scripts/render-model.mjs assets/models/15t-*.glb        (composes a whole tram)
//        node scripts/render-model.mjs assets/models/15t-*.glb --thumb out.png
// Multiple GLBs are laid end-to-end along Z (head first) like a real consist.
//
// --thumb  → a single beautiful 3/4-front view on a TRANSPARENT background
//            (no grid/cone), az≈-32° el≈14°, tight crop, ~700×450 — the UI
//            thumbnail used by MODEL_IMAGES in modelSpecs.ts.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const thumb = args.includes('--thumb');
const rest = args.filter((a) => a !== '--thumb');
if (rest.length === 0) {
  console.error('usage: node scripts/render-model.mjs <model.glb> [more.glb ...] [--thumb] [out.png]');
  process.exit(1);
}
const out = rest[rest.length - 1].endsWith('.png') ? rest.pop() : 'model-render.png';
const glbs = rest.map((p) => readFileSync(resolve(p)).toString('base64'));

// Bundle three + loader once (cached). Cache key bumped when the entry changes.
const bundlePath = join(root, 'node_modules/.cache/render-model-bundle-v3.js');
if (!existsSync(bundlePath)) {
  mkdirSync(dirname(bundlePath), { recursive: true });
  const entry = join(dirname(bundlePath), 'render-model-entry.mjs');
  writeFileSync(entry, `
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
window.renderGLBs = async function (base64List) {
  const W = 900, H = 700;
  const views = [
    { name: 'front 3/4', az: -35, el: 18, closeup: false },
    { name: 'side', az: -90, el: 8, closeup: false },
    { name: 'rear 3/4', az: 145, el: 18, closeup: false },
    { name: 'front detail', az: -25, el: 10, closeup: true },
  ];
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(W, H);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe8e8ee);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x777788, 1.15));
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.0);
  sun.position.set(30, 50, 25);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xdde8ff, 0.7);
  fill.position.set(-30, 20, -25);
  scene.add(fill);
  const loader = new GLTFLoader();
  let zCursor = 0; // place sections end-to-end, front (−Z) first
  const group = new THREE.Group();
  for (const b64 of base64List) {
    const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;
    const gltf = await loader.parseAsync(buf, '');
    const obj = gltf.scene;
    const box = new THREE.Box3().setFromObject(obj);
    const len = box.max.z - box.min.z;
    obj.position.z = zCursor - box.min.z; // section origin at center; align nose-to-tail
    zCursor += len + 0.35;
    group.add(obj);
  }
  scene.add(group);
  const total = new THREE.Box3().setFromObject(group);
  const c = total.getCenter(new THREE.Vector3());
  const size = total.getSize(new THREE.Vector3());
  const grid = new THREE.GridHelper(Math.ceil(size.z + 10), Math.ceil(size.z + 10), 0xbbbbcc, 0xd5d5e0);
  grid.position.set(c.x, total.min.y, c.z);
  scene.add(grid);
  // red cone marks the FRONT (−Z end)
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.9), new THREE.MeshBasicMaterial({ color: 0xcc2222 }));
  cone.rotation.x = -Math.PI / 2;
  cone.position.set(c.x, total.min.y + 0.4, total.min.z - 1.2);
  scene.add(cone);
  const cam = new THREE.PerspectiveCamera(40, W / H, 0.1, 500);
  const sheet = document.createElement('canvas');
  sheet.width = W * 2; sheet.height = H * 2;
  const ctx = sheet.getContext('2d');
  views.forEach((v, i) => {
    const r = v.closeup ? Math.max(size.y, 4) * 2.1 : Math.max(size.z, size.y, 6) * 1.05 + 4;
    const az = v.az * Math.PI / 180, el = v.el * Math.PI / 180;
    const target = v.closeup ? new THREE.Vector3(c.x, c.y, total.min.z + 1.5) : c;
    cam.position.set(
      target.x + r * Math.cos(el) * Math.sin(az),
      target.y + r * Math.sin(el),
      target.z + r * Math.cos(el) * Math.cos(az) * -1
    );
    cam.lookAt(target);
    renderer.render(scene, cam);
    ctx.drawImage(renderer.domElement, (i % 2) * W, Math.floor(i / 2) * H, W, H);
    ctx.fillStyle = '#333'; ctx.font = '24px sans-serif';
    ctx.fillText(v.name, (i % 2) * W + 16, Math.floor(i / 2) * H + 32);
  });
  document.body.appendChild(sheet);
  return sheet.toDataURL('image/png');
};
window.renderThumb = async function (base64List) {
  const W = 700, H = 450;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(W, H);
  renderer.setClearColor(0x000000, 0); // transparent
  const scene = new THREE.Scene();
  scene.background = null;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8088a0, 1.15));
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.1);
  sun.position.set(28, 46, 30);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xdde8ff, 0.75);
  fill.position.set(-26, 18, -22);
  scene.add(fill);
  const loader = new GLTFLoader();
  let zCursor = 0;
  const group = new THREE.Group();
  for (const b64 of base64List) {
    const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;
    const gltf = await loader.parseAsync(buf, '');
    const obj = gltf.scene;
    const box = new THREE.Box3().setFromObject(obj);
    obj.position.z = zCursor - box.min.z;
    zCursor += (box.max.z - box.min.z) + 0.35;
    group.add(obj);
  }
  scene.add(group);
  const total = new THREE.Box3().setFromObject(group);
  const c = total.getCenter(new THREE.Vector3());
  const size = total.getSize(new THREE.Vector3());
  const cam = new THREE.PerspectiveCamera(34, W / H, 0.1, 500);
  const vFov = cam.fov * Math.PI / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * cam.aspect);
  const az = -32 * Math.PI / 180, el = 14 * Math.PI / 180;
  // unit vector center→camera
  const dir = new THREE.Vector3(
    Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az) * -1,
  ).normalize();
  // camera-space basis (forward = camera→center)
  const forward = dir.clone().negate();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  // project the 8 bbox corners onto the camera axes → tight screen-space fit so
  // even a 32 m consist fills the frame width (no clipping)
  let halfW = 0, halfH = 0, halfD = 0;
  for (const sx of [total.min.x, total.max.x]) {
    for (const sy of [total.min.y, total.max.y]) {
      for (const sz of [total.min.z, total.max.z]) {
        const v = new THREE.Vector3(sx, sy, sz).sub(c);
        halfW = Math.max(halfW, Math.abs(v.dot(right)));
        halfH = Math.max(halfH, Math.abs(v.dot(up)));
        halfD = Math.max(halfD, Math.abs(v.dot(forward)));
      }
    }
  }
  const m = 1.06; // small margin so nothing touches the edge
  const dist = Math.max(halfW * m / Math.tan(hFov / 2), halfH * m / Math.tan(vFov / 2)) + halfD;
  cam.position.copy(dir).multiplyScalar(dist).add(c);
  cam.lookAt(c);
  renderer.render(scene, cam);
  return renderer.domElement.toDataURL('image/png');
};
window.__ready = true;
`);
  execSync(`npx esbuild ${entry} --bundle --format=iife --outfile=${bundlePath}`, { cwd: root, stdio: 'inherit' });
}
const bundle = readFileSync(bundlePath, 'utf8');

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
  await page.waitForFunction('window.__ready === true', { timeout: 15000 });
  const dataUrl = await page.evaluate(
    (list, isThumb) => (isThumb ? window.renderThumb(list) : window.renderGLBs(list)),
    glbs, thumb
  );
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('wrote', resolve(out));
} finally {
  await browser.close();
}
