// 1€ filter (Casiez, Roussel, Vogel 2012): a low-pass whose cutoff rises with speed, so it calms jitter
// at rest without lagging fast moves. CineHand uses it for DISPLAY ONLY (the desk's live gizmo) and, in
// Phase 4, on a COPY of samples at export. Recorded takes never pass through it. See DECISIONS §1–2.
// No three.js import: OneEuroQuat only calls methods on the quaternions it is given.

const alpha = (cutoffHz, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoffHz * dt));
const DEFAULTS = { mincutoff: 1.0, beta: 0.01, dcutoff: 1.0 };

/** Scalar 1€ filter. filter(value, timeMs) → filtered value. */
export class OneEuro {
  constructor(opts = {}) { Object.assign(this, DEFAULTS, opts); this.reset(); }
  reset() { this.x = null; this.dx = 0; this.t = null; }
  filter(x, tMs) {
    if (this.t === null) { this.x = x; this.t = tMs; return x; }
    const dt = Math.max((tMs - this.t) / 1000, 1e-3);
    this.t = tMs;
    this.dx += alpha(this.dcutoff, dt) * ((x - this.x) / dt - this.dx);
    this.x += alpha(this.mincutoff + this.beta * Math.abs(this.dx), dt) * (x - this.x);
    return this.x;
  }
}

/**
 * Quaternion 1€ filter: slerp the previous output toward each new sample by the 1€ alpha, with angular
 * speed in degrees/s as the derivative.
 * Why slerp rather than filtering x,y,z,w separately: per-component filtering leaves the unit sphere and
 * goes wrong at the q / −q sign flip; slerp stays a rotation and takes the short way round.
 * Why degrees: so beta = 0.01 is meaningful. At rest (~5°/s of sensor jitter) the cutoff stays ≈1 Hz;
 * a 300°/s flick lifts it to 4 Hz, which tracks within a couple of frames.
 */
export class OneEuroQuat {
  constructor(opts = {}) { Object.assign(this, DEFAULTS, opts); this.reset(); }
  reset() { this.q = null; this.speed = 0; this.t = null; }
  /** q: THREE.Quaternion sample, tMs: sample time in ms, out: THREE.Quaternion to write into. */
  filter(q, tMs, out) {
    if (this.t === null) { this.q = q.clone(); this.t = tMs; return out.copy(q); }
    const dt = Math.max((tMs - this.t) / 1000, 1e-3);
    this.t = tMs;
    const degPerSec = (this.q.angleTo(q) * 180 / Math.PI) / dt;
    this.speed += alpha(this.dcutoff, dt) * (degPerSec - this.speed);
    this.q.slerp(q, alpha(this.mincutoff + this.beta * this.speed, dt));
    return out.copy(this.q);
  }
}
