import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { brief, subjectOf, seeThrough } from './make/brief.js';

const words = JSON.parse(readFileSync(new URL('../recipes/seedance-2.5.json', import.meta.url), 'utf8')).video.brief;
// a product set: a 15 cm mug on a 60 cm rock, a tree nearby, mountains far behind
const scene = {
  prompt: 'on a rock by an alpine river', spawn: { p: [0, 0.9, 1.2], yaw: 0 },
  objects: [
    { id: 'ground', type: 'plane', size: [60, 60] },
    { id: 'rock', type: 'box', p: [0, 0.3, -0.3], size: [1.2, 0.6, 0.9], label: 'rock' },
    { id: 'mug', type: 'cylinder', p: [0, 0.675, -0.3], size: [0.045, 0.15], label: 'clay mug' },
    { id: 'handle', type: 'box', p: [0.07, 0.7, -0.3], size: [0.07, 0.09, 0.02], label: 'handle' },
    { id: 't1', type: 'cylinder', p: [-3, 1.5, -4], size: [0.2, 3], label: 'tree' },
    { id: 't2', type: 'cylinder', p: [3, 1.5, -5], size: [0.2, 3], label: 'tree' },
    { id: 'alp', type: 'box', p: [2, 16, -55], size: [30, 32, 10], label: 'alp peak' },
  ],
};
// the camera starts 25 cm from the mug, pulls straight back 3 m in 3 s, holds 2 s, then turns 90° right in 0.4 s
const yawQ = (deg) => { const r = (deg * Math.PI) / 360; return [0, Math.sin(r), 0, Math.cos(r)]; };
const samples = [];
for (let i = 0; i <= 330; i++) {
  const t = i / 60, back = Math.min(3, Math.max(0, t - 0.5) * 1.2);
  const yaw = t < 5 ? 0 : -Math.min(90, (t - 5) * 225);
  samples.push({ ts: Math.round(t * 1000), p: [0, 0.7, -0.05 + back], q: yawQ(yaw) });
}
const take = { view: { fov: 45, aspect: 16 / 9 }, samples };

test('the subject is what the take opens on, not the floor or the far mountains', () => {
  assert.equal(subjectOf(scene, take).label, 'clay mug');
  assert.equal(subjectOf({ ...scene, objects: [...scene.objects, { id: 'subject', type: 'box', p: [5, 0, 5], size: [1, 1, 1] }] }, take).id, 'subject');
});

test('the shot brief names each picture, gives real sizes, and tells the move in stages from the take', () => {
  const b = brief({ scene, take, look: 'golden hour', names: ['ref-look.jpg', 'ref-subject.jpg'], words });
  assert.match(b.pictures, /Reference image 1 is a wide view of the whole place/);
  assert.match(b.pictures, /Reference image 2 is the real product, the clay mug/);
  assert.match(b.set, /^The set: The clay mug on a rock by an alpine river\./, 'a photo set said without its subject gets it first');
  assert.match(b.set, /the clay mug \(15 cm tall\) on the rock/);
  assert.match(b.set, /2 trees/);
  assert.match(b.set, /Far in the background: the alp peak/);
  assert.doesNotMatch(b.set, /handle/, "the mug's handle is part of the product, shown by its photo");
  assert.match(b.move, /^It opens close on the clay mug, about 25 cm away; from 0\.\d s it pulls back about 3 m from the clay mug/);
  assert.match(b.move, /whips right fast/);
  assert.match(b.move, /never shorten the move/, 'it travels: Seedance walks short');
  assert.match(b.move, /out of frame: do not turn back to it/, 'the take ends away from the mug: no swing back');
});

test('a take with no first frame lists only the pictures sent; a still take has no distance line', () => {
  const still = { view: take.view, samples: samples.slice(0, 20).map((s) => ({ ...s, p: [0, 0.7, -0.05], q: [0, 0, 0, 1] })) };
  const b = brief({ scene, take: still, look: 'x', names: ['start', 'ref-look.jpg'], words });
  assert.match(b.pictures, /Reference image 1 is the opening frame.*Reference image 2 is a wide view/);
  assert.doesNotMatch(b.move, /shorten|turn back/);
});

test('see-through products get the "ignore what shows through it" line, only with a product photo', () => {
  assert.equal(seeThrough('a beer glass'), true);
  assert.equal(seeThrough('clay mug', 'on a rock'), false);
  const glass = { ...scene, objects: scene.objects.map((o) => (o.id === 'mug' ? { ...o, label: 'beer glass' } : o)) };
  assert.match(brief({ scene: glass, take, look: 'x', names: ['ref-subject.jpg'], words }).pictures, /see-through/);
  assert.doesNotMatch(brief({ scene: glass, take, look: 'x', names: ['ref-look.jpg'], words }).pictures, /see-through/);
});
