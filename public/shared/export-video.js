// Take -> grey reference video (MP4) + first-frame PNG, for AI video tools.
// Rendered frame by frame, not screen-recorded: frame i shows exactly the sample recorded at or before i/fps,
// whatever the speed of the computer. The look matches the phone's view (povStage).
import * as THREE from './three.js';
import { renderScene, povStage } from './scene-render.js';
import { sampleAt, frameTimes, exportSize, exportFov } from './frames.js';

export const EXPORT_FPS = 24;
const MUXER_URL = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/+esm'; // MP4 container only; loaded on first export

// Hand control back to the browser between frames so the page stays responsive.
// MessageChannel, not setTimeout: background tabs throttle timers to one per second.
const yieldToPage = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = r; c.port2.postMessage(0); });

/**
 * @returns {Promise<{ mp4: Blob, png: Blob, width: number, height: number, fps: number, frames: number }>}
 * Throws an Error with a message fit to show the user.
 */
export async function exportTake(take, scene, { fps = EXPORT_FPS, onProgress = () => {}, decorate } = {}) {
  const aspect = take.view?.aspect || 9 / 16;
  const { width, height } = exportSize(aspect);
  // H.264 High, level 4.0: covers 1920×1080 and 1080×1920 at 24 fps. What AI video tools and every player accept.
  const config = { codec: 'avc1.640028', width, height, bitrate: 8_000_000, framerate: fps };
  if (typeof VideoEncoder === 'undefined' || !(await VideoEncoder.isConfigSupported(config)).supported) {
    throw new Error('This browser can’t make MP4 videos. Use Chrome, Edge or Safari on the laptop.');
  }
  const { Muxer, ArrayBufferTarget } = await import(MUXER_URL);

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(width, height, false);
  const stage = povStage();
  stage.add(renderScene(scene));
  decorate?.(stage); // lab hook (lab/tools/render.mjs): e.g. a textured twin for measuring motion
  const camera = new THREE.PerspectiveCamera(exportFov(take.view?.fov || 60, aspect, width / height), width / height, 0.05, 200);

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: 'avc', width, height, frameRate: fps }, fastStart: 'in-memory' });
  let failure = null;
  const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failure = e; } });
  encoder.configure(config);

  const times = frameTimes(take.samples.at(-1).ts, fps);
  let png = null;
  try {
    for (let i = 0; i < times.length; i++) {
      const s = sampleAt(take.samples, times[i]);
      camera.quaternion.fromArray(s.q);
      camera.position.fromArray(s.p);
      renderer.render(stage, camera);
      if (i === 0) png = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: i % fps === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 4 && !failure) await yieldToPage();
      if (failure) throw failure;
      onProgress((i + 1) / times.length);
      await yieldToPage();
    }
    await encoder.flush();
    if (failure) throw failure;
    muxer.finalize();
  } catch (e) {
    throw new Error(`Video export failed: ${e?.message || e}`);
  } finally {
    if (encoder.state !== 'closed') encoder.close();
    renderer.dispose();
    renderer.forceContextLoss();
  }
  return { mp4: new Blob([target.buffer], { type: 'video/mp4' }), png, width, height, fps, frames: times.length };
}
