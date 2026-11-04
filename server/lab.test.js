import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLabTake, isLocal, saveLabTake } from './lab.js';
import { loadTemplate } from './scene.js';

const take = (over = {}) => ({ id: '2026-11-04T19-00-00Z-ab12', label: '4 whip', view: { fov: 60, aspect: 0.46 },
  samples: [{ ts: 0, q: [0, 0, 0, 1], p: [0, 1.6, 7] }, { ts: 16.7, q: [0, 0.1, 0, 0.99], p: [0, 1.6, 6.9] }], ...over });

test('a real take and template set can be saved', async () => {
  const scene = await loadTemplate('parking-lot');
  assert.deepEqual(checkLabTake({ take: take(), scene }), []);
  const root = await mkdtemp(join(tmpdir(), 'lab-'));
  try {
    const rel = await saveLabTake(root, { take: take(), scene });
    assert.equal(rel, join('lab', 'takes', '2026-11-04T19-00-00Z-ab12'));
    assert.equal(JSON.parse(await readFile(join(root, rel, 'take.json'), 'utf8')).label, '4 whip');
    assert.ok(JSON.parse(await readFile(join(root, rel, 'scene.json'), 'utf8')).objects.length);
  } finally { await rm(root, { recursive: true }); }
});

test('bad takes are refused, including ids that would escape the folder', async () => {
  const scene = await loadTemplate('parking-lot');
  assert.ok(checkLabTake({ take: take({ id: '../../etc' }), scene }).length);
  assert.ok(checkLabTake({ take: take({ id: 'a/b' }), scene }).length);
  assert.ok(checkLabTake({ take: take({ samples: [] }), scene }).length);
  assert.ok(checkLabTake({ take: take({ samples: [{ ts: 0, q: [0, 0, 1], p: [0, 0, 0] }] }), scene }).length);
  assert.ok(checkLabTake({ take: take({ label: 'my shot' }), scene }).length);
  assert.ok(checkLabTake({ take: take(), scene: { objects: 'x' } }).length);
  assert.deepEqual(checkLabTake({}), ['take missing']);
});

test('only requests made on this computer may write to the lab, never via the tunnel or LAN', () => {
  const req = (ip, headers = {}) => ({ socket: { remoteAddress: ip }, headers });
  assert.equal(isLocal(req('127.0.0.1')), true);
  assert.equal(isLocal(req('::1')), true);
  assert.equal(isLocal(req('::ffff:127.0.0.1')), true);
  assert.equal(isLocal(req('127.0.0.1', { 'cf-connecting-ip': '1.2.3.4' })), false, 'cloudflared tunnel');
  assert.equal(isLocal(req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' })), false);
  assert.equal(isLocal(req('192.168.1.20')), false, 'phone on the LAN');
});
