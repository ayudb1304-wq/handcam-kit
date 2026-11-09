// Free trial videos are watermarked (docs/PRICING-PLAN.md). ffmpeg burns a label into a copy (wm-N.mp4); the clean
// file stays on the server for the founder and for scoring. Made on first request, like the free-version previews.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FONTS = [
  process.env.HANDCAM_FONT,
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', // Debian/Ubuntu: fonts-dejavu-core (Dockerfile)
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/Library/Fonts/Arial Bold.ttf', // macOS
].filter(Boolean);

/** The ffmpeg filter: a small label in the bottom-right corner, on a soft dark box. */
export function watermarkFilter(text = 'CineHand · free trial', font = FONTS.find((f) => existsSync(f))) {
  const t = text.replace(/[\\':%]/g, ''); // drawtext's special characters: keep the label plain
  return `drawtext=${font ? `fontfile='${font}':` : ''}text='${t}':fontcolor=white@0.85:fontsize=(w+h)/56:x=w-tw-(w+h)/80:y=h-th-(w+h)/80:box=1:boxcolor=black@0.4:boxborderw=8`;
}

// The label as an image (server/assets/watermark.png), laid over the video: works with every ffmpeg build. drawtext
// needs ffmpeg built with freetype, which Homebrew's ffmpeg on a Mac isn't (it failed with "No such filter: 'drawtext'").
const LABEL = fileURLToPath(new URL('./assets/watermark.png', import.meta.url));
/** Label 34% of the video's width, bottom-right corner, a small margin. */
export const OVERLAY = "[1:v][0:v]scale2ref=w='rw*0.3':h='ow*ih/iw'[wm][base];[base][wm]overlay=x='W-w-W*0.025':y='H-h-H*0.035':format=auto";

export function watermark(src, out, { ffmpeg = process.env.HANDCAM_FFMPEG || 'ffmpeg' } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-v', 'error', '-y', '-i', src, '-i', LABEL, '-filter_complex', OVERLAY, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', out], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errText = '';
    p.stderr.on('data', (d) => { errText += d; });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`watermark: ffmpeg exit ${c}: ${errText.slice(0, 200)}`))));
  });
}
