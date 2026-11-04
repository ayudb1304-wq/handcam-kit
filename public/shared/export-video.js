// Take(s) -> grey reference video (MP4) + first-frame PNG, for AI video tools.
// Rendered frame by frame, not screen-recorded: frame i shows exactly the sample recorded at or before i/fps,
// whatever the speed of the computer. The look matches the phone's view (povStage).
// A sequence (Phase 5b) is the same thing with several segments cut one after another: each segment is a take
// trimmed to [from, to] ms, shown with its own set and the set's own motion at the take's time.
import * as THREE from './three.js';
import { renderScene, povStage, animateScene } from './scene-render.js';
import { sampleAt, frameTimes, takeOutput } from './frames.js';

export const EXPORT_FPS = 24;
const MUXER_URL = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/+esm'; // MP4 container only; loaded on first export

// Hand control back to the browser between frames so the page stays responsive.
// MessageChannel, not setTimeout: background tabs throttle timers to one per second.
const yieldToPage = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = r; c.port2.postMessage(0); });

/**
 * One take, whole. samples: the take's own (raw) or a smoothed COPY from the export panel; the take never changes.
 * @returns {Promise<{ mp4: Blob, png: Blob, width: number, height: number, fps: number, frames: number }>}
 */
export function exportTake(take, scene, { samples = take.samples, ...opts } = {}) {
  return exportSegments([{ take, scene, samples, from: 0, to: samples.at(-1).ts }], opts);
}

/**
 * Several takes cut together (Phase 5b). The output frame is the first segment's; later segments are shown at
 * their own lens in that frame. Throws an Error with a message fit to show the user.
 */
export async function exportSegments(segments, { fps = EXPORT_FPS, onProgress = () => {}, decorate } = {}) {
  if (!segments.length) throw new Error('Nothing to export.');
  const first = takeOutput(segments[0].take), { width, height } = first;
  // H.264 High, level 4.0: covers 1920×1080 and 1080×1920 at 24 fps. What AI video tools and every player accept.
  const config = { codec: 'avc1.640028', width, height, bitrate: 8_000_000, framerate: fps };
  if (typeof VideoEncoder === 'undefined' || !(await VideoEncoder.isConfigSupported(config)).supported) {
    throw new Error('This browser can’t make MP4 videos. Use Chrome, Edge or Safari.');
  }
  const { Muxer, ArrayBufferTarget } = await import(MUXER_URL);

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(width, height, false);
  const camera = new THREE.PerspectiveCamera(60, width / height, 0.05, 200);

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: 'avc', width, height, frameRate: fps }, fastStart: 'in-memory' });
  let failure = null;
  const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failure = e; } });
  encoder.configure(config);

  // all frames of all segments, in order: [segment index, time within its take]
  const plan = segments.flatMap((seg, k) => frameTimes(Math.max(0, seg.to - seg.from), fps).map((t) => [k, seg.from + t]));
  const stages = segments.map((seg) => {
    const stage = povStage(), set = renderScene(seg.scene);
    stage.add(set);
    decorate?.(stage); // lab hook (lab/tools/render.mjs): e.g. a textured twin for measuring motion
    return { stage, set, out: takeOutput(seg.take), samples: seg.samples || seg.take.samples };
  });
  let png = null;
  try {
    for (let i = 0; i < plan.length; i++) {
      const [k, ms] = plan[i], st = stages[k];
      const s = sampleAt(st.samples, ms);
      animateScene(st.set, ms); // the set's own motion at the same moment of that take (Phase 3b)
      const fov = st.out.fovAt(s);
      if (fov !== camera.fov) { camera.fov = fov; camera.updateProjectionMatrix(); } // the zoom, as performed
      camera.quaternion.fromArray(s.q);
      camera.position.fromArray(s.p);
      renderer.render(st.stage, camera);
      if (i === 0) png = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: i % fps === 0 || (i > 0 && plan[i - 1][0] !== k) }); // a keyframe at every cut
      frame.close();
      while (encoder.encodeQueueSize > 4 && !failure) await yieldToPage();
      if (failure) throw failure;
      onProgress((i + 1) / plan.length);
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
  return { mp4: new Blob([target.buffer], { type: 'video/mp4' }), png, width, height, fps, frames: plan.length };
}
