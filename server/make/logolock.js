// Logo lock on finished videos: server/logolock.py puts the brand's exact logo (PNG) on the product, frame by frame.
// Per job: logo.png (the person's file, as uploaded), locks.json ({ n: lock }), lock-N.mp4 (the result), frame-N.jpg (the
// first frame, for placing the logo). locks.json is its own file: the video pipeline writes job.json in parallel.
// One lock runs at a time on this server (it is CPU work), the rest wait their turn.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'logolock.py');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Is this a PNG file? (logos come in as PNG: the browser turns an SVG into one at 2048 px, shared/image.js) */
export const isPng = (buf) => Buffer.isBuffer(buf) && buf.length > 64 && buf.subarray(0, 8).equals(PNG);

/** The 4 logo corners in the first frame, as fractions of the frame: [[x,y] × 4], a sane convex shape. Else null. */
export function cleanQuad(q) {
  if (!Array.isArray(q) || q.length !== 4) return null;
  const pts = q.map((p) => (Array.isArray(p) && p.length === 2 ? p.map(Number) : null));
  if (pts.some((p) => !p || !p.every((v) => Number.isFinite(v) && v > -0.5 && v < 1.5))) return null;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [a, b, c] = [pts[i], pts[(i + 1) % 4], pts[(i + 2) % 4]];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (!cross || (sign && Math.sign(cross) !== sign)) return null;
    sign = Math.sign(cross);
  }
  return pts.map((p) => p.map((v) => Math.round(v * 1e5) / 1e5));
}

function run(cmd, args, { timeoutMs = 15 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? `${cmd} not found` : e.message)); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      const last = err.trim().split('\n').filter((l) => !/Warning|^\s/.test(l)).pop() || `exit ${code}`;
      reject(new Error(/No module named/.test(err) ? 'logo lock needs opencv and numpy on the server' : last.slice(0, 200)));
    });
  });
}

export function makeLogoLock({ jobs, python = process.env.HANDCAM_PYTHON || 'python3', ffmpeg = process.env.HANDCAM_FFMPEG || 'ffmpeg', log = console }) {
  const writes = new Map();
  let turn = Promise.resolve(); // one lock at a time

  async function read(id) {
    try { return JSON.parse(await readFile(jobs.path(id, 'locks.json'), 'utf8')); } catch { return {}; }
  }
  /** Change one job's locks.json with fn(locks), one write at a time per job. */
  function update(id, fn) {
    const next = (writes.get(id) || Promise.resolve()).then(async () => {
      const locks = await read(id);
      fn(locks);
      const tmp = jobs.path(id, 'locks.json.tmp');
      await writeFile(tmp, JSON.stringify(locks, null, 2));
      await rename(tmp, jobs.path(id, 'locks.json'));
      return locks;
    });
    writes.set(id, next.catch(() => {}));
    return next;
  }

  async function saveLogo(job, buf) {
    await writeFile(jobs.path(job.id, 'logo.png'), buf);
    // a new logo makes earlier locked videos out of date: they stay, marked, until locked again
    return update(job.id, (locks) => { for (const l of Object.values(locks)) if (l.status === 'done') l.oldLogo = true; locks.logoAt = new Date().toISOString(); });
  }
  const hasLogo = (job) => existsSync(jobs.path(job.id, 'logo.png'));

  /** The first frame of version n as a JPEG (where the person places the logo). */
  async function firstFrame(job, n, file) {
    const out = jobs.path(job.id, `frame-${n}.jpg`);
    if (!existsSync(out)) await run(ffmpeg, ['-v', 'error', '-y', '-i', jobs.path(job.id, file), '-vframes', '1', '-q:v', '2', out], { timeoutMs: 60_000 });
    return out;
  }

  /** Where the logo (or the AI's version of it) is in version n's first frame, if recognisable. → { quad | null } */
  async function find(job, file) {
    try { return JSON.parse(await run(python, [SCRIPT, 'find', jobs.path(job.id, file), jobs.path(job.id, 'logo.png')], { timeoutMs: 120_000 })); }
    catch (e) { log.warn(`[logolock] find ${job.id}: ${e.message}`); return { quad: null }; }
  }

  /** Start locking the logo onto version n (file) at `quad`; returns at once, the lock finishes in the background. */
  async function start(job, n, file, quad, cover = 'auto') {
    const at = new Date().toISOString();
    const locks = await update(job.id, (l) => { l[n] = { status: 'working', quad, cover, at }; });
    turn = turn.then(async () => {
      const out = jobs.path(job.id, `lock-${n}.mp4`), report = jobs.path(job.id, `lock-${n}.json`);
      try {
        await rm(jobs.path(job.id, `lockwm-${n}.mp4`), { force: true }); // the trial copy of the last lock is out of date
        await run(python, [SCRIPT, 'lock', jobs.path(job.id, file), jobs.path(job.id, 'logo.png'), JSON.stringify(quad), out, '--cover', cover, '--report', report]);
        const r = JSON.parse(await readFile(report, 'utf8'));
        await update(job.id, (l) => {
          if (l[n]?.at !== at) return; // locked again since: that one wins
          l[n] = { status: 'done', quad, cover, at, file: `lock-${n}.mp4`, locked: r.locked, motion: r.motion, coverUsed: r.cover, frames: r.frames, faded: r.faded_frames };
        });
      } catch (e) {
        log.warn(`[logolock] ${job.id} v${n}: ${e.message}`);
        await update(job.id, (l) => { if (l[n]?.at === at) l[n] = { status: 'failed', quad, cover, at, error: 'The logo could not be locked on this version.' }; });
      }
    });
    return locks;
  }
  return { read, saveLogo, hasLogo, firstFrame, find, start };
}
