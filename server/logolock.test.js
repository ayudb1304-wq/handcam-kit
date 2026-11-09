import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanQuad, isPng } from './make/logolock.js';
import { publicLocks } from './make/routes.js';

const here = dirname(fileURLToPath(import.meta.url));

test('logo corners: four, convex, in the frame; anything else is refused', () => {
  const q = [[0.4, 0.3], [0.6, 0.3], [0.6, 0.5], [0.4, 0.5]];
  assert.deepEqual(cleanQuad(q), q);
  assert.equal(cleanQuad([[0, 0], [1, 0], [1, 1]]), null, 'three corners');
  assert.equal(cleanQuad([[0.4, 0.3], [0.6, 0.5], [0.6, 0.3], [0.4, 0.5]]), null, 'crossed (a bow tie)');
  assert.equal(cleanQuad([[0.4, 0.3], [0.6, 0.3], [0.6, 0.5], ['x', 0.5]]), null);
  assert.equal(cleanQuad([[0.4, 0.3], [9, 0.3], [0.6, 0.5], [0.4, 0.5]]), null, 'far outside');
  assert.equal(cleanQuad('nope'), null);
});

test('only PNG files are taken as a logo', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
  assert.equal(isPng(png), true);
  assert.equal(isPng(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'.repeat(3))), false);
  assert.equal(isPng(Buffer.alloc(10)), false);
});

test('a trial customer gets the watermarked copy of a locked video; the founder the clean one', () => {
  const locks = { 1: { status: 'done', file: 'lock-1.mp4', locked: 0.98, at: 'x' }, logoAt: 'y' };
  const job = { watermark: true };
  assert.equal(publicLocks(locks, job, { full: false })['1'].file, 'lockwm-1.mp4');
  assert.equal(publicLocks(locks, job, { full: true })['1'].file, 'lock-1.mp4');
  assert.equal(publicLocks(locks, { watermark: false }, { full: false })['1'].file, 'lock-1.mp4');
  assert.equal(publicLocks(locks, job).logoAt, undefined, 'only versions');
});

// The real check: a synthetic product shot with known geometry (perspective turns, zoom, shake, parallax, a morphing fake
// logo underneath, light dimming, H.264). Corners must stay within a pixel, the drawn logo must be the supplied pixels.
const py = process.env.HANDCAM_PYTHON || 'python3';
const hasCv = spawnSync(py, ['-c', 'import cv2, numpy'], { stdio: 'ignore' }).status === 0 && spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
test('logo lock holds the exact logo on a moving, morphing product to under a pixel', { skip: !hasCv && 'needs python3 + opencv + ffmpeg', timeout: 300_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logolock-'));
  const r = spawnSync(py, [join(here, 'logolock_check.py'), dir], { encoding: 'utf8', timeout: 280_000 });
  const res = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.ok(res.corner_err_px.mean < 0.5, `corner error mean ${res.corner_err_px.mean} px`);
  assert.ok(res.corner_err_px.max < 2, `corner error max ${res.corner_err_px.max} px`);
  assert.ok(res.logo_pixel_err.mean < 12, `logo pixels off by ${res.logo_pixel_err.mean}`);
  assert.ok(res.cover_err.mean < 12, 'the AI logo underneath is covered');
  assert.equal(res.pass, true);
});
