// Runs server/score.py (the "move match" scorer, Python + OpenCV) on finished videos.
// If Python or OpenCV is missing, videos are still delivered, marked "not checked", with the reason.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCORER = join(dirname(fileURLToPath(import.meta.url)), '..', 'score.py');
const PYTHON = process.env.HANDCAM_PYTHON || 'python3';

/** Score videos against take.json (and measure.mp4 next to it, for walking). Returns { scores: [..] } or { error }. */
export function runScore(takeJson, videos, { timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '';
    const p = spawn(PYTHON, [SCORER, takeJson, ...videos], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); resolve({ error: `scorer could not start (${e.code === 'ENOENT' ? `${PYTHON} not found` : e.message})` }); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const missing = /No module named '(cv2|numpy)'/.exec(err);
        return resolve({ error: missing ? `scorer needs ${missing[1] === 'cv2' ? 'opencv' : 'numpy'}: pip install opencv-python-headless numpy` : `scorer failed: ${err.trim().split('\n').pop()?.slice(0, 200)}` });
      }
      try { resolve({ scores: out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) }); }
      catch { resolve({ error: 'scorer output unreadable' }); }
    });
  });
}
