// Phase 5b: shots and sequences. A set holds an ordered list of shots; each shot is a take (or an empty slot) with a
// name and in/out points. Trimming chooses which part of a take is used; it never edits the move itself.
// Plays back to back as an animatic, exports as one video, one JSON, or a Blender folder with one camera per shot.
import { putSequence, getSequence, getScene } from '../shared/store.js';
import { zip } from '../shared/zip.js';
import { planMotion, stateAt } from '../shared/motion.js';
import { POSES, BONES, HEAD_RADIUS } from '../shared/stickfigure.js';
import { takeOutput } from '../shared/frames.js';
import { cleanTake, EXPORT_FPS } from './export.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dur = (take) => take?.samples.at(-1)?.ts ?? 0;
const secs = (ms) => (ms / 1000).toFixed(1);
const DEFAULT_NAMES = ['Wide', 'Push-in', 'Over the shoulder', 'Close-up', 'Reverse', 'Insert'];

/** The playable cut: shots that have a take, with their trimmed range and where they start in the sequence (ms). */
export function cutList(seq, takes) {
  let start = 0;
  const out = [];
  for (const s of seq?.shots || []) {
    const take = takes.get(s.takeId);
    if (!take) continue;
    const from = Math.max(0, Math.min(s.in ?? 0, dur(take))), to = Math.max(from, Math.min(s.out ?? dur(take), dur(take)));
    if (to - from < 50) continue;
    out.push({ shot: s, take, from, to, start });
    start += to - from;
  }
  return { cuts: out, length: start };
}

/** Blender folder for a sequence: one take file per shot, the set's motion baked along the whole cut. */
export function sequenceBlenderFiles(cuts, scenes, { script, fps = EXPORT_FPS } = {}) {
  const first = takeOutput(cuts[0].take), files = [], shots = [];
  let frame = 1;
  const motion = { fps, frames: 0, objects: {} };
  cuts.forEach((c, i) => {
    const name = `take-${i + 1}.json`, frames = Math.floor(((c.to - c.from) / 1000) * fps) + 1;
    files.push({ name, data: JSON.stringify(cleanTake(c.take)) });
    shots.push({ name: c.shot.name || `Shot ${i + 1}`, take: name, in: c.from, out: c.to, start_frame: frame });
    // the set restarts with each take's own clock: bake what it showed during that shot
    const plan = planMotion(scenes[i]);
    for (const id of plan.moving) {
      const track = (motion.objects[id] ||= []);
      while (track.length < motion.frames) track.push(track.at(-1) || null);
      for (let k = 0; k < frames; k++) {
        const s = stateAt(plan, id, c.from + (k * 1000) / fps);
        track.push([...s.p.map((v) => +v.toFixed(4)), +s.yaw.toFixed(5), s.pose || null]);
      }
    }
    motion.frames += frames;
    frame += frames;
  });
  for (const track of Object.values(motion.objects)) {
    const firstFull = track.find(Boolean);
    for (let k = 0; k < track.length; k++) track[k] ||= firstFull;
    while (track.length < motion.frames) track.push(track.at(-1));
  }
  files.push(
    { name: 'sequence.json', data: JSON.stringify({ fps, shots }, null, 2) },
    { name: 'scene.json', data: JSON.stringify(scenes[0], null, 2) },
    { name: 'export.json', data: JSON.stringify({ fps, frame: cuts[0].take.frame || null, width: first.width, height: first.height, smoothing: 0 }, null, 2) },
    { name: 'figures.json', data: JSON.stringify({ POSES, BONES, HEAD_RADIUS }) },
  );
  if (Object.keys(motion.objects).length) files.push({ name: 'motion.json', data: JSON.stringify(motion) });
  files.push({ name: 'import.py', data: script }, { name: 'README.txt', data: [
    'CineHand sequence → Blender',
    '',
    'You need Blender 4.x (free, blender.org). In a terminal, go into this folder and run:',
    '',
    '    blender --background --python import.py -- sequence.json scene.json cinehand.blend',
    '',
    `Open cinehand.blend and press Play: ${cuts.length} shots, one camera each, cut with timeline markers`,
    'bound to each camera. Every camera moves exactly like your hand did in that take.',
    '',
  ].join('\n') });
  return files;
}

export function setupSequence({ takes, getLiveScene, takeScene, toast, nice, onChange = () => {} }) {
  let seq = null, setId = null, inSet = [];
  const list = $('shots');

  async function load(scene) {
    setId = scene?.setId || scene?.id || null;
    seq = (setId && (await getSequence(setId).catch(() => null))) || { setId, shots: [] };
    await refreshTakes();
  }
  /** Takes shot in any version of this set. */
  async function refreshTakes() {
    const out = [];
    for (const t of takes.values()) {
      if (t.demo || !t.sceneId) continue;
      const sc = await getScene(t.sceneId).catch(() => null);
      if (sc && (sc.setId || sc.id) === setId) out.push(t);
    }
    inSet = out.sort((a, b) => (b.star ? 1 : 0) - (a.star ? 1 : 0) || b.id.localeCompare(a.id));
    render();
  }
  const save = () => { if (seq?.setId) putSequence(seq).catch(() => {}); onChange(); };

  function render() {
    if (!seq) return;
    const { length } = cutList(seq, takes);
    $('seqLen').textContent = seq.shots.length ? `${seq.shots.length} shot${seq.shots.length > 1 ? 's' : ''} · ${secs(length)} s` : 'empty';
    $('seqEmpty').hidden = seq.shots.length > 0;
    list.innerHTML = '';
    seq.shots.forEach((s, i) => {
      const take = takes.get(s.takeId), d = dur(take);
      const li = document.createElement('li');
      li.className = 'shot';
      li.innerHTML = `
        <div class="row"><span class="shot-n">${i + 1}</span><input class="field grow" data-k="name" value="${esc(s.name)}" aria-label="Shot name" maxlength="40">
          <button class="btn quiet icon sm" data-a="up" title="Earlier" ${i ? '' : 'disabled'}>↑</button><button class="btn quiet icon sm" data-a="down" title="Later" ${i < seq.shots.length - 1 ? '' : 'disabled'}>↓</button><button class="btn quiet icon sm" data-a="del" title="Remove shot">✕</button></div>
        <select data-k="take" aria-label="Take for this shot"><option value="">Empty slot: pick a take…</option>${inSet.map((t) => `<option value="${t.id}" ${t.id === s.takeId ? 'selected' : ''}>${t.star ? '★ ' : ''}${esc(nice(t))} · ${secs(dur(t))} s</option>`).join('')}</select>
        ${take ? `<div class="trim"><label>In <input type="range" data-k="in" min="0" max="${d}" step="50" value="${s.in ?? 0}"><span>${secs(s.in ?? 0)} s</span></label>
          <label>Out <input type="range" data-k="out" min="0" max="${d}" step="50" value="${s.out ?? d}"><span>${secs(s.out ?? d)} s</span></label></div>` : ''}`;
      li.querySelector('[data-k=name]').onchange = (e) => { s.name = e.target.value.trim().slice(0, 40); save(); };
      li.querySelector('[data-k=take]').onchange = (e) => { s.takeId = e.target.value || null; const t = takes.get(s.takeId); s.in = 0; s.out = dur(t); save(); render(); };
      for (const k of ['in', 'out']) {
        const r = li.querySelector(`[data-k=${k}]`);
        if (!r) continue;
        r.oninput = () => {
          let v = Number(r.value);
          if (k === 'in') v = Math.min(v, (s.out ?? d) - 100); else v = Math.max(v, (s.in ?? 0) + 100);
          s[k] = Math.max(0, Math.min(d, v)); r.value = s[k];
          r.nextElementSibling.textContent = `${secs(s[k])} s`;
        };
        r.onchange = () => { save(); render(); };
      }
      li.querySelector('[data-a=up]').onclick = () => { [seq.shots[i - 1], seq.shots[i]] = [seq.shots[i], seq.shots[i - 1]]; save(); render(); };
      li.querySelector('[data-a=down]').onclick = () => { [seq.shots[i + 1], seq.shots[i]] = [seq.shots[i], seq.shots[i + 1]]; save(); render(); };
      li.querySelector('[data-a=del]').onclick = () => { seq.shots.splice(i, 1); save(); render(); };
      list.append(li);
    });
  }

  $('addShot').onclick = () => {
    if (!seq?.setId) return toast('Build a set first.');
    const used = new Set(seq.shots.map((s) => s.takeId));
    const take = inSet.find((t) => !used.has(t.id)) || null; // the next take not used yet, if any
    seq.shots.push({ id: Math.random().toString(36).slice(2, 8), name: DEFAULT_NAMES[seq.shots.length % DEFAULT_NAMES.length], takeId: take?.id || null, in: 0, out: dur(take) });
    save(); render();
  };

  // ---- play: main.js asks for "which take, at what time" every frame ----
  let playing = null; // { elapsed }
  $('playSeq').onclick = () => {
    const { cuts } = cutList(seq, takes);
    if (!cuts.length) return toast('Put at least one take in a shot first.');
    playing = playing ? null : { elapsed: 0 };
    $('playSeq').textContent = playing ? 'Stop' : 'Play sequence';
  };
  function tick(dt) {
    if (!playing) return null;
    const { cuts, length } = cutList(seq, takes);
    playing.elapsed += dt;
    if (playing.elapsed >= length || !cuts.length) { playing = null; $('playSeq').textContent = 'Play sequence'; return null; }
    const c = cuts.findLast((x) => x.start <= playing.elapsed);
    return { take: c.take, ms: c.from + (playing.elapsed - c.start), label: `${c.shot.name || 'Shot'} · ${cuts.indexOf(c) + 1}/${cuts.length}` };
  }

  // ---- export ----
  async function cutsWithScenes() {
    const { cuts } = cutList(seq, takes);
    if (!cuts.length) { toast('Put at least one take in a shot first.'); return null; }
    const scenes = await Promise.all(cuts.map((c) => takeScene(c.take)));
    if (scenes.some((x) => !x)) { toast('A set one of these takes was shot in isn’t saved on this computer.'); return null; }
    return { cuts, scenes };
  }
  const download = (name, blob) => { const url = URL.createObjectURL(blob); Object.assign(document.createElement('a'), { href: url, download: name }).click(); setTimeout(() => URL.revokeObjectURL(url), 60_000); };
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  $('seqVideo').onclick = async () => {
    const got = await cutsWithScenes(); if (!got) return;
    const btn = $('seqVideo'); btn.disabled = true;
    try {
      const { exportSegments } = await import('../shared/export-video.js');
      const out = await exportSegments(got.cuts.map((c, i) => ({ take: c.take, scene: got.scenes[i], from: c.from, to: c.to })), { onProgress: (f) => { btn.textContent = `${Math.round(f * 100)}%`; } });
      download(`cinehand-sequence-${stamp()}.mp4`, out.mp4);
      toast(`Saved the sequence: ${got.cuts.length} shots, ${secs((out.frames / out.fps) * 1000)} s`);
    } catch (e) { toast(e.message, 5000); } finally { btn.disabled = false; btn.textContent = 'Video'; }
  };
  $('seqJson').onclick = async () => {
    const got = await cutsWithScenes(); if (!got) return;
    const data = { sequence: got.cuts.map((c) => ({ name: c.shot.name, takeId: c.take.id, in: c.from, out: c.to })), takes: got.cuts.map((c) => cleanTake(c.take)), scenes: got.scenes };
    download(`cinehand-sequence-${stamp()}.json`, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  };
  $('seqBlender').onclick = async () => {
    const got = await cutsWithScenes(); if (!got) return;
    const sr = await fetch('/exporters/blender_import.py');
    if (!sr.ok) return toast((await sr.json().catch(() => ({}))).error || 'Blender export isn’t available.', 5000);
    const script = await sr.text();
    download(`cinehand-sequence-${stamp()}-blender.zip`, new Blob([zip(sequenceBlenderFiles(got.cuts, got.scenes, { script }))], { type: 'application/zip' }));
    toast('Saved the Blender folder for the sequence (zip).');
  };

  return { load, refreshTakes, tick, isPlaying: () => !!playing, current: () => seq };
}
