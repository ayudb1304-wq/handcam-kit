// Pure take/frame math, no three.js, so the server tests can check it. Used by the desk player and the video export.

/** The last sample at or before ms. Takes are shown exactly as recorded: no blending between samples. */
export function sampleAt(samples, ms) {
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (samples[mid].ts <= ms) lo = mid; else hi = mid - 1; }
  return samples[lo];
}

/** Frame times (ms) for a take of durationMs at fps: frame 0 at 0, then every 1/fps, never past the end. */
export function frameTimes(durationMs, fps) {
  const n = Math.floor((Math.max(0, durationMs) * fps) / 1000 + 1e-9) + 1;
  return Array.from({ length: n }, (_, i) => (i * 1000) / fps);
}

/** Output size in pixels: the standard frame closest to how the phone was held. */
export function exportSize(takeAspect) {
  return takeAspect < 1 ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
}

/**
 * Vertical fov (degrees) for the export frame, so the video shows everything the phone showed.
 * If the export frame is wider than the phone view, keep the vertical fov (a little extra at the sides).
 * If it is narrower, keep the horizontal fov (a little extra at top and bottom). Never crops what was framed.
 */
export function exportFov(fov, takeAspect, outAspect) {
  if (outAspect >= takeAspect) return fov;
  const halfW = Math.tan((fov * Math.PI) / 360) * takeAspect;
  return (Math.atan(halfW / outAspect) * 360) / Math.PI;
}
