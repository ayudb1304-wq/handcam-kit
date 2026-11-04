// Smoothing ON EXPORT ONLY (Phase 4, CLAUDE.md): a 1€ filter over a COPY of a take's samples.
// The take itself is never changed; amount 0 returns the raw samples untouched. No three.js: tested in node.
import { OneEuro } from './one-euro.js';

/** Slider 0–1 → 1€ mincutoff from 1 Hz down to 0.05 Hz (log scale, so the slider feels even). */
export const cutoffFor = (amount) => 1.0 * Math.pow(0.05, Math.min(1, Math.max(0, amount)));

function slerp(a, b, t) {
  let [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  let dot = ax * bx + ay * by + az * bz + aw * bw;
  if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot; } // the short way round
  if (dot > 0.9995) {
    const r = [ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t, aw + (bw - aw) * t], n = Math.hypot(...r);
    return r.map((v) => v / n);
  }
  const th = Math.acos(dot), s = Math.sin(th), wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return [ax * wa + bx * wb, ay * wa + by * wb, az * wa + bz * wb, aw * wa + bw * wb];
}
const angleDeg = (a, b) => (2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180) / Math.PI;
const alpha = (hz, dt) => 1 / (1 + 1 / (2 * Math.PI * hz * dt));

/** → new samples array (same ts, f kept), p and q filtered. amount ≤ 0 → the very same raw samples. */
export function smoothSamples(samples, amount) {
  if (!(amount > 0) || !samples?.length) return samples;
  const mincutoff = cutoffFor(amount), beta = 0.01;
  const px = [0, 1, 2].map(() => new OneEuro({ mincutoff, beta }));
  let q = samples[0].q.slice(), speed = 0, t = null;
  return samples.map((s) => {
    const p = s.p.map((v, i) => px[i].filter(v, s.ts));
    if (t !== null) {
      const dt = Math.max((s.ts - t) / 1000, 1e-3);
      speed += alpha(1.0, dt) * (angleDeg(q, s.q) / dt - speed);
      q = slerp(q, s.q, alpha(mincutoff + beta * speed, dt));
    }
    t = s.ts;
    return { ...s, p, q };
  });
}
