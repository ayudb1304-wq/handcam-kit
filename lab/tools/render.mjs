// Render a lab take into the same grey reference video the desk's "Export video" makes, without a laptop.
// Runs the app's own exporter (public/shared/export-video.js) in headless Chromium.
//
//   node lab/tools/render.mjs lab/takes/<take id> [--force]
//     -> reference.mp4 + first-frame.png (what the AI gets; kept if already there unless --force)
//     -> measure.mp4: the same camera path through the same set, every surface speckled, so server/score.py can
//        track walking (the flat grey reference has too little texture for that). Never sent to an AI.
//
// Needs Playwright with Chromium (preinstalled in Claude cloud sessions). three.js and mp4-muxer are fetched once
// from the npm registry into lab/tools/.cache (gitignored), because the CDN the pages use may be blocked here.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FORCE = process.argv.includes('--force');
const ROOT = resolve(HERE, '..', '..');
const CACHE = join(HERE, '.cache');
const PKGS = { 'three@0.168.0': 'three', 'mp4-muxer@5.2.2': 'mp4-muxer' };

function ensurePackages() {
  mkdirSync(CACHE, { recursive: true });
  for (const [spec, name] of Object.entries(PKGS)) {
    const dir = join(CACHE, spec);
    if (existsSync(join(dir, 'package.json'))) continue;
    const tgz = execFileSync('npm', ['pack', spec, '--silent', '--pack-destination', CACHE], { encoding: 'utf8' }).trim().split('\n').pop();
    mkdirSync(dir, { recursive: true });
    execFileSync('tar', ['-xzf', join(CACHE, tgz), '-C', dir, '--strip-components=1']);
    console.log(`fetched ${name}`);
  }
}

function cdnFile(path) { // path after https://cdn.jsdelivr.net/npm/
  if (path === 'three@0.168.0/build/three.module.js') return join(CACHE, 'three@0.168.0/build/three.module.js');
  if (path.startsWith('three@0.168.0/examples/jsm/')) return join(CACHE, 'three@0.168.0', path.slice('three@0.168.0/'.length));
  if (path === 'mp4-muxer@5.2.2/+esm') return join(CACHE, 'mp4-muxer@5.2.2/build/mp4-muxer.mjs');
  return null;
}

const PAGE = `<!doctype html><meta charset="utf-8"><script type="importmap">
{ "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.168.0/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.168.0/examples/jsm/" } }</script>`;

export async function render(takeDir) {
  ensurePackages();
  const take = JSON.parse(readFileSync(join(takeDir, 'take.json'), 'utf8'));
  const scene = JSON.parse(readFileSync(join(takeDir, 'scene.json'), 'utf8'));
  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://cdn.jsdelivr.net/npm/**', (route) => {
      const file = cdnFile(route.request().url().split('/npm/')[1]);
      return file ? route.fulfill({ path: file, contentType: 'text/javascript' }) : route.abort();
    });
    // https so the page is a secure context: WebCodecs (VideoEncoder) is unavailable on plain http
    await page.route('https://handcam.lab/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') return route.fulfill({ body: PAGE, contentType: 'text/html' });
      return route.fulfill({ path: join(ROOT, 'public', path), contentType: 'text/javascript' });
    });
    await page.goto('https://handcam.lab/');
    const save = (name, dataUrl) => writeFileSync(join(takeDir, name), Buffer.from(dataUrl.split(',')[1], 'base64'));
    const run = (twin) => page.evaluate(async ({ take, scene, twin }) => {
      const THREE = await import('three');
      const { exportTake } = await import('/shared/export-video.js');
      const decorate = twin ? (stage) => speckle(THREE, stage) : undefined;
      const r = await exportTake(take, scene, { decorate });
      const url = (blob) => new Promise((ok) => { const f = new FileReader(); f.onload = () => ok(f.result); f.readAsDataURL(blob); });
      return { mp4: await url(r.mp4), png: await url(r.png), width: r.width, height: r.height, fps: r.fps, frames: r.frames };

      function speckle(THREE, stage) { // random grey blobs at several sizes, ~1.5 m tiles, unlit and unfogged
        const c = Object.assign(document.createElement('canvas'), { width: 512, height: 512 });
        const g = c.getContext('2d');
        let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        g.fillStyle = '#777'; g.fillRect(0, 0, 512, 512);
        for (let i = 0; i < 1600; i++) {
          const v = Math.floor(rnd() * 255);
          g.fillStyle = `rgb(${v},${v},${v})`;
          g.beginPath(); g.arc(rnd() * 512, rnd() * 512, 2 + rnd() * rnd() * 30, 0, Math.PI * 2); g.fill();
        }
        stage.fog = null;
        stage.traverse((o) => {
          if (!o.isMesh) return;
          o.geometry.computeBoundingBox();
          const size = o.geometry.boundingBox.getSize(new THREE.Vector3());
          const [a, b] = [size.x, size.y, size.z].sort((p, q) => q - p);
          const map = new THREE.CanvasTexture(c);
          map.wrapS = map.wrapT = THREE.RepeatWrapping;
          map.repeat.set(Math.max(1, a / 1.5), Math.max(1, b / 1.5));
          o.material = new THREE.MeshBasicMaterial({ map });
        });
      }
    }, { take, scene, twin });
    if (FORCE || !existsSync(join(takeDir, 'reference.mp4'))) {
      const ref = await run(false);
      save('reference.mp4', ref.mp4);
      save('first-frame.png', ref.png);
    }
    const twin = await run(true);
    save('measure.mp4', twin.mp4);
    return { width: twin.width, height: twin.height, fps: twin.fps, frames: twin.frames };
  } finally { await browser.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const dir of process.argv.slice(2).filter((a) => !a.startsWith('--'))) console.log(dir, await render(resolve(dir)));
}
