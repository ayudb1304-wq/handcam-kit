import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleAt, frameTimes, exportSize, exportFov } from '../public/shared/frames.js';

const samples = [{ ts: 0 }, { ts: 16.7 }, { ts: 33.4 }, { ts: 50 }];

test('sampleAt picks the last sample at or before the time, never blends', () => {
  assert.equal(sampleAt(samples, 0), samples[0]);
  assert.equal(sampleAt(samples, 16.6), samples[0]);
  assert.equal(sampleAt(samples, 16.7), samples[1]);
  assert.equal(sampleAt(samples, 41.67), samples[2]);
  assert.equal(sampleAt(samples, 999), samples[3]);
});

test('frameTimes: frame 0 at 0, one per 1/fps, none past the end', () => {
  assert.deepEqual(frameTimes(0, 24), [0]);
  assert.equal(frameTimes(1000, 24).length, 25);
  assert.equal(frameTimes(1000, 24).at(-1), 1000);
  const t = frameTimes(8333, 24);
  assert.equal(t.length, 200);
  assert.ok(t.at(-1) <= 8333);
  assert.ok(Math.abs(t[1] - 1000 / 24) < 1e-9);
});

test('exportSize follows how the phone was held', () => {
  assert.deepEqual(exportSize(390 / 844), { width: 1080, height: 1920 });
  assert.deepEqual(exportSize(844 / 390), { width: 1920, height: 1080 });
});

test('exportFov never crops what the phone showed', () => {
  const halfW = (fov, a) => Math.tan((fov * Math.PI) / 360) * a;
  const halfH = (fov) => Math.tan((fov * Math.PI) / 360);
  // portrait phone (0.46) into 9:16 (0.5625): wider, so keep vertical fov
  assert.equal(exportFov(60, 0.462, 9 / 16), 60);
  // landscape phone (2.16) into 16:9 (1.78): narrower, keep horizontal fov, so vertical grows
  const v = exportFov(60, 2.16, 16 / 9);
  assert.ok(v > 60);
  assert.ok(Math.abs(halfW(v, 16 / 9) - halfW(60, 2.16)) < 1e-9);
  assert.ok(halfH(v) >= halfH(60));
});
