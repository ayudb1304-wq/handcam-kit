// Phase 4 export panel: Video (MP4 + first frame), JSON, Blender (zip), a smoothing slider and a ready-to-paste prompt.
// One click, no settings dialog: defaults are raw (smoothing 0), 24 fps, the frame the take was shot for.
// Smoothing only ever makes a COPY of the samples for the files; the take itself never changes.
import { zip } from '../shared/zip.js';
import { smoothSamples } from '../shared/smooth.js';
import { describeMove } from '../shared/describe.js';
import { planMotion, stateAt } from '../shared/motion.js';
import { POSES, BONES, HEAD_RADIUS } from '../shared/stickfigure.js';
import { takeOutput } from '../shared/frames.js';

export const EXPORT_FPS = 24;
const $ = (id) => document.getElementById(id);

/** The take as stored, without desk-only bookkeeping: what take.json contains, byte for byte, whatever the smoothing. */
export function cleanTake(take) {
  const { labSent, demo, ...rest } = take;
  return rest;
}

/** The set's own motion sampled at fps, for Blender (the same numbers the phone and desk show). */
export function bakeMotion(scene, durationMs, fps = EXPORT_FPS) {
  const plan = planMotion(scene);
  if (!plan.moving.size) return null;
  const frames = Math.floor(((Math.max(durationMs, plan.duration * 1000) / 1000) * fps)) + 1, objects = {};
  for (const id of plan.moving) {
    objects[id] = Array.from({ length: frames }, (_, k) => {
      const s = stateAt(plan, id, (k * 1000) / fps);
      return [...s.p.map((v) => +v.toFixed(4)), +s.yaw.toFixed(5), s.pose || null];
    });
  }
  return { fps, frames, objects };
}

/** Files for the Blender zip. take.json is always the raw take; a smoothed camera goes in camera.json. */
export function blenderFiles(take, scene, { smoothing = 0, script, fps = EXPORT_FPS } = {}) {
  const t = cleanTake(take), out = takeOutput(t);
  const files = [
    { name: 'take.json', data: JSON.stringify(t) },
    { name: 'scene.json', data: JSON.stringify(scene, null, 2) },
    { name: 'export.json', data: JSON.stringify({ fps, frame: t.frame || null, width: out.width, height: out.height, smoothing }, null, 2) },
    { name: 'figures.json', data: JSON.stringify({ POSES, BONES, HEAD_RADIUS }) },
  ];
  const motion = bakeMotion(scene, t.samples.at(-1).ts, fps);
  if (motion) files.push({ name: 'motion.json', data: JSON.stringify(motion) });
  if (smoothing > 0) files.push({ name: 'camera.json', data: JSON.stringify({ smoothing, samples: smoothSamples(t.samples, smoothing) }) });
  files.push({ name: 'import.py', data: script });
  files.push({ name: 'README.txt', data: [
    'HandCam → Blender',
    '',
    'You need Blender 4.x (free, blender.org). In a terminal, go into this folder and run:',
    '',
    '    blender --background --python import.py -- take.json scene.json handcam.blend',
    '',
    'Then open handcam.blend and press Play (space). The camera moves exactly like your hand did:',
    'one key per recorded sample, straight lines between them, the zoom as you performed it.',
    smoothing > 0 ? `This export was smoothed (${Math.round(smoothing * 100)}%): camera.json holds the smoothed copy; take.json is your raw take.` : 'This export is raw (no smoothing).',
    '',
  ].join('\n') });
  return files;
}

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function setupExport({ getTake, takeScene, toast }) {
  const smoothEl = $('smooth'), promptEl = $('movePrompt');
  const smoothing = () => Number(smoothEl.value) || 0;
  smoothEl.oninput = () => { $('smoothVal').textContent = smoothing() ? `${Math.round(smoothing() * 100)}%` : 'off (raw)'; };
  smoothEl.oninput();

  async function withScene(fn) {
    const take = getTake();
    if (!take) return;
    const scene = await takeScene(take);
    if (!scene) return toast('The set this take was shot in isn’t saved on this computer.');
    return fn(take, scene);
  }
  const busy = async (btn, label, fn) => {
    btn.disabled = true;
    try { await fn((text) => { btn.textContent = text; }); } catch (e) { toast(e.message, 5000); } finally { btn.disabled = false; btn.textContent = label; }
  };

  $('exportBtn').onclick = () => withScene((take, scene) => busy($('exportBtn'), 'Video', async (say) => {
    const { exportTake } = await import('../shared/export-video.js');
    const out = await exportTake(take, scene, { samples: smoothSamples(take.samples, smoothing()), onProgress: (f) => say(`Video ${Math.round(f * 100)}%`) });
    const name = `handcam-${take.id}`;
    download(`${name}.mp4`, out.mp4);
    download(`${name}-first-frame.png`, out.png);
    toast(`Saved ${out.width}×${out.height} video + first frame to Downloads`);
  }));
  $('jsonBtn').onclick = () => withScene((take, scene) => {
    download(`handcam-${take.id}.json`, new Blob([JSON.stringify({ take: cleanTake(take), scene }, null, 2)], { type: 'application/json' }));
    toast('Saved take + set as JSON');
  });
  $('blenderBtn').onclick = () => withScene((take, scene) => busy($('blenderBtn'), 'Blender', async () => {
    const sr = await fetch('/exporters/blender_import.py');
    if (!sr.ok) throw new Error((await sr.json().catch(() => ({}))).error || 'Blender export isn’t available.');
    const script = await sr.text();
    download(`handcam-${take.id}-blender.zip`, new Blob([zip(blenderFiles(take, scene, { smoothing: smoothing(), script }))], { type: 'application/zip' }));
    toast('Saved the Blender folder (zip). README inside has the one command.');
  }));
  $('copyPrompt').onclick = async () => {
    try { await navigator.clipboard.writeText(promptEl.value); toast('Prompt copied'); } catch { promptEl.select(); }
  };

  return {
    async onTake(take) {
      if (!take) return;
      const scene = await takeScene(take);
      promptEl.value = describeMove(take, scene);
    },
  };
}
