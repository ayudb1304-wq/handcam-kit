import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMotion, stateAt, frameAt } from '../public/shared/motion.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const scene = (objects) => ({ units: 'm', spawn: { p: [0, 1.6, 6] }, objects });

test('go: straight line at speed, facing the way it travels; waits at the start until ● (t ≤ 0)', () => {
  const plan = planMotion(scene([{ id: 'guy', type: 'stickfigure', p: [0, 0, 0], moves: [{ do: 'go', to: [0, 10], speed: 2 }] }]));
  assert.equal(plan.duration, 5);
  assert.deepEqual(stateAt(plan, 'guy', -100).p, [0, 0, 0]);
  const mid = stateAt(plan, 'guy', 2500);
  assert.deepEqual(mid.p, [0, 0, 5]);
  near(mid.yaw, 0); // +z
  assert.equal(mid.walked, 5);
  assert.equal(mid.moving, true);
  const end = stateAt(plan, 'guy', 99000);
  assert.deepEqual(end.p, [0, 0, 10]);
  assert.equal(end.moving, false);
  near(stateAt(planMotion(scene([{ id: 'c', type: 'box', moves: [{ do: 'go', to: [5, 0] }] }])), 'c', 1000).yaw, Math.PI / 2);
});

test('actions run one after another: go, wait, turn, pose', () => {
  const plan = planMotion(scene([{ id: 'g', type: 'stickfigure', p: [0, 0, 0], pose: 'standing',
    moves: [{ do: 'go', to: [0, 1.4] }, { do: 'wait', s: 1 }, { do: 'turn', yaw: Math.PI }, { do: 'pose', pose: 'crouching' }] }]));
  // go 1 s, wait 1 s, turn π at π rad/s = 1 s
  near(plan.duration, 3);
  assert.equal(stateAt(plan, 'g', 1500).pose, 'standing');
  near(stateAt(plan, 'g', 2500).yaw, Math.PI / 2);
  const end = stateAt(plan, 'g', 5000);
  near(end.yaw, Math.PI);
  assert.equal(end.pose, 'crouching');
  assert.deepEqual(end.p.map((v) => +v.toFixed(6)), [0, 0, 1.4]);
});

test('riding: a driver keeps its seat in the car and turns with it; objects without moves never move', () => {
  const plan = planMotion(scene([
    { id: 'car', type: 'box', p: [0, 0.7, 0], moves: [{ do: 'go', to: [10, 0], speed: 10 }] },
    { id: 'driver', type: 'stickfigure', p: [0.4, 0.3, 0.5], on: 'car', pose: 'sitting' },
    { id: 'tree', type: 'cylinder', p: [3, 1, 3] },
  ]));
  assert.ok(plan.moving.has('driver') && plan.moving.has('car') && !plan.moving.has('tree'));
  const car = stateAt(plan, 'car', 1000), d = stateAt(plan, 'driver', 1000);
  near(car.yaw, Math.PI / 2);
  // at rest the driver sat 0.4 to the side and 0.5 ahead of the car's centre (car faced +z, yaw 0)... but the car
  // turns to face +x as it starts, so the offset turns with it: (0.4, 0.5) local -> world (0.5, -0.4) from the car
  near(d.p[0], car.p[0] + 0.5); near(d.p[2], car.p[2] - 0.4); near(d.p[1], 0.3);
  near(d.yaw, Math.PI / 2);
  assert.equal(d.pose, 'sitting');
  assert.deepEqual(stateAt(plan, 'tree', 5000).p, [3, 1, 3]);
  const f = frameAt(plan, 'car', 1000);
  near(f.elements[12], 10); near(f.elements[0], Math.cos(Math.PI / 2));
});

test('bad or missing parents are ignored, and riders of riders are not allowed', () => {
  const plan = planMotion(scene([
    { id: 'a', type: 'box', on: 'nobody' },
    { id: 'b', type: 'box', on: 'b' },
    { id: 'car', type: 'box', moves: [{ do: 'go', to: [1, 0] }] },
    { id: 'c', type: 'box', on: 'car' },
    { id: 'd', type: 'box', on: 'c' },
  ]));
  assert.ok(!plan.riders.has('a') && !plan.riders.has('b') && plan.riders.has('c') && !plan.riders.has('d'));
});
