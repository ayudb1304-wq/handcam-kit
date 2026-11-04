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

// ---- Phase 4: frame and lens --------------------------------------------------------------------
/** Output frames you shoot for, chosen on the phone before shooting. */
export const FRAMES = Object.freeze({ '16:9': 16 / 9, '9:16': 9 / 16, '2.39:1': 2.39 });
export const DEFAULT_FRAME = '16:9';
export const LENS_RANGE = Object.freeze([16, 135]); // full-frame lens sizes, mm
export const DEFAULT_LENS = 24;
const SENSOR_LONG_MM = 36; // the frame's long side is 36 mm, like a full-frame camera

/** Vertical field of view (degrees) of a full-frame lens of `mm` for a frame of this aspect (w/h). */
export function fovFromLens(mm, aspect) {
  const heightMm = aspect >= 1 ? SENSOR_LONG_MM / aspect : SENSOR_LONG_MM;
  return (2 * Math.atan(heightMm / (2 * mm)) * 180) / Math.PI;
}
/** The lens (mm) that gives this vertical fov for this aspect: for takes shot before the zoom existed. */
export function lensFromFov(fovDeg, aspect) {
  const heightMm = aspect >= 1 ? SENSOR_LONG_MM / aspect : SENSOR_LONG_MM;
  return heightMm / (2 * Math.tan((fovDeg * Math.PI) / 360));
}
export function frameSize(frame) {
  if (frame === '9:16') return { width: 1080, height: 1920 };
  if (frame === '2.39:1') return { width: 1920, height: 804 };
  return { width: 1920, height: 1080 };
}

/**
 * How to render a take: output size and the vertical fov for each sample.
 * A take shot with a chosen frame (Phase 4) is rendered exactly as framed, lens per sample (`s.f`, mm).
 * Older takes keep the Phase 4a rule: nearest standard frame, never cropping what the phone showed.
 */
export function takeOutput(take) {
  const aspect = take.view?.aspect || 9 / 16, fov = take.view?.fov || 60;
  if (take.frame && FRAMES[take.frame]) {
    const a = FRAMES[take.frame];
    return { ...frameSize(take.frame), aspect: a, fovAt: (s) => (s?.f ? fovFromLens(s.f, a) : fov) };
  }
  const { width, height } = exportSize(aspect), f = exportFov(fov, aspect, width / height);
  return { width, height, aspect: width / height, fovAt: () => f };
}
