// Practice mode: the whole Make video flow with no AI and no credits. "Generations" finish after a short wait.
// The start image is the grey first frame; a video is the grey reference itself (so it scores as a perfect match),
// or, for the built-in demo take, the real example result shipped in public/demo/.
import { copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DELAY = { start: 2500, video: 6000 };

export function makeMock({ delay = DELAY, demoDir } = {}) {
  const requests = new Map();
  let n = 0;
  const local = (url) => (url.startsWith('mock:') ? url.slice(5) : fileURLToPath(url));
  return {
    name: 'mock',
    async upload(file) { return `mock:${file}`; },
    async submit(endpoint, input, idempotencyKey) {
      for (const [id, r] of requests) if (r.key === idempotencyKey) return { requestId: id };
      const id = `mock-${++n}`;
      const isVideo = endpoint.includes('video');
      let out;
      if (isVideo) {
        const demo = demoDir && input.demo ? `${demoDir}/result.mp4` : null;
        out = { video: { url: demo && existsSync(demo) ? `mock:${demo}` : input.video_urls?.[0] } };
      } else {
        const demo = demoDir && input.demo ? `${demoDir}/start.jpg` : null;
        out = { images: [{ url: demo && existsSync(demo) ? `mock:${demo}` : input.image_urls?.[0] }] };
      }
      requests.set(id, { key: idempotencyKey, doneAt: Date.now() + (isVideo ? delay.video : delay.start), out });
      return { requestId: id };
    },
    async status(id) {
      const r = requests.get(id);
      if (!r) return { status: 'failed', error: 'practice request lost (server restarted)' };
      if (Date.now() < r.doneAt) return { status: 'in_progress', result: {} };
      return { status: 'completed', result: { status: 'completed', ...r.out } };
    },
    async download(url, file) { await copyFile(local(url), file); },
  };
}
