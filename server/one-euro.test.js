import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OneEuro } from '../public/shared/one-euro.js';

// Deterministic "sensor noise": ±0.1 alternating, like gyro jitter at rest.
const noise = (i) => (i % 2 ? 0.1 : -0.1);

test('constant input passes through unchanged', () => {
  const f = new OneEuro();
  for (let i = 0; i < 100; i++) assert.equal(f.filter(5, i * 16.7), 5);
});

test('calms jitter at rest', () => {
  const f = new OneEuro();
  let maxOut = 0;
  for (let i = 0; i < 300; i++) { const y = f.filter(noise(i), i * 16.7); if (i > 60) maxOut = Math.max(maxOut, Math.abs(y)); }
  assert.ok(maxOut < 0.03, `rest jitter ${maxOut.toFixed(3)} should be well under the raw 0.1`);
});

test('a fast move is followed closely (speed raises the cutoff)', () => {
  // 300 units/s ramp for 0.5 s (think degrees: a quick flick). Lag behind the ramp stays small.
  const f = new OneEuro();
  let lagAtEnd = 0;
  for (let i = 0; i <= 30; i++) { const t = i * 16.7, x = 0.3 * t; lagAtEnd = x - f.filter(x, t); }
  const slow = new OneEuro({ beta: 0 }); // plain 1 Hz low-pass for comparison
  let slowLag = 0;
  for (let i = 0; i <= 30; i++) { const t = i * 16.7, x = 0.3 * t; slowLag = x - slow.filter(x, t); }
  assert.ok(lagAtEnd < slowLag / 3, `1€ lag ${lagAtEnd.toFixed(1)} should be far below fixed-cutoff lag ${slowLag.toFixed(1)}`);
});

test('reset forgets history', () => {
  const f = new OneEuro();
  f.filter(0, 0); f.filter(10, 16.7);
  f.reset();
  assert.equal(f.filter(42, 100), 42);
});
