import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zip, crc32 } from '../public/shared/zip.js';
import { smoothSamples, cutoffFor } from '../public/shared/smooth.js';
import { describeMove, measureMove } from '../public/shared/describe.js';

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('zip: a real unzip reads every file back byte for byte', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zip-'));
  try {
    const files = [{ name: 'take.json', data: '{"a":1}' }, { name: 'README.txt', data: 'héllo ✓\n' }, { name: 'bin.dat', data: Uint8Array.from([0, 255, 7]) }];
    writeFileSync(join(dir, 'x.zip'), zip(files));
    execFileSync('unzip', ['-q', join(dir, 'x.zip'), '-d', join(dir, 'out')]);
    assert.equal(readFileSync(join(dir, 'out', 'take.json'), 'utf8'), '{"a":1}');
    assert.equal(readFileSync(join(dir, 'out', 'README.txt'), 'utf8'), 'héllo ✓\n');
    assert.deepEqual([...readFileSync(join(dir, 'out', 'bin.dat'))], [0, 255, 7]);
  } finally { rmSync(dir, { recursive: true }); }
});

const shaky = Array.from({ length: 120 }, (_, i) => {
  const a = 0.02 * Math.sin(i * 1.7); // jitter
  return { ts: i * 16.7, p: [Math.sin(i * 2.3) * 0.01, 1.6, 6 - i * 0.02], q: [0, Math.sin(a / 2), 0, Math.cos(a / 2)], f: 24 };
});

test('smoothing: 0 is the raw samples themselves; more smoothing removes more jitter; never touches the input', () => {
  const copy = JSON.stringify(shaky);
  assert.equal(smoothSamples(shaky, 0), shaky);
  const jitter = (s) => s.slice(1).reduce((n, x, i) => n + Math.abs(x.q[1] - s[i].q[1]), 0);
  const j0 = jitter(shaky), j3 = jitter(smoothSamples(shaky, 0.3)), j8 = jitter(smoothSamples(shaky, 0.8));
  assert.ok(j3 < j0 && j8 < j3, `${j0} > ${j3} > ${j8}`);
  assert.equal(JSON.stringify(shaky), copy);
  assert.equal(smoothSamples(shaky, 0.8)[5].f, 24);
  assert.ok(Math.abs(cutoffFor(0) - 1) < 1e-9 && Math.abs(cutoffFor(1) - 0.05) < 1e-9);
});

test('describe: a push-in and a whip read as words', () => {
  const pushIn = Array.from({ length: 100 }, (_, i) => ({ ts: i * 50, p: [0, 1.6, 6 - i * 0.03], q: [0, 0, 0, 1] }));
  const m = measureMove(pushIn);
  assert.ok(m.forward > 2.9 && Math.abs(m.side) < 1e-9, JSON.stringify(m));
  const scene = { prompt: 'parking lot at night', objects: [{ id: 'guy', type: 'stickfigure', label: 'the man' }] };
  assert.match(describeMove({ samples: pushIn }, scene), /^parking lot at night\. Handheld camera: a slow push-in toward the man, over 5\.0 s\./);
  const whip = Array.from({ length: 60 }, (_, i) => { const a = i < 30 ? 0 : Math.min(1.4, (i - 30) * 0.35); return { ts: i * 33, p: [0, 1.6, 6], q: [0, Math.sin(a / 2), 0, Math.cos(a / 2)] }; });
  assert.match(describeMove({ samples: whip }, scene), /fast whip pan left/);
});
