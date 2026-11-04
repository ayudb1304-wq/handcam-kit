// HandCam Studio (desk). Set → Shoot → Takes → Make video. See docs/ARCHITECTURE.md.
import * as THREE from '../shared/three.js';
import { OrbitControls } from '../shared/three.js';
import { MSG, SHOTS, connectRelay } from '../shared/protocol.js';
import { renderScene, addDefaultLights, animateScene } from '../shared/scene-render.js';
import { OneEuroQuat } from '../shared/one-euro.js';
import { putTake, allTakes, deleteTake, putScene, getScene } from '../shared/store.js';
import { sampleAt, takeOutput } from '../shared/frames.js';
import { setupMake } from './make.js';
import { setupTour } from './tour.js';
import { setupEditor } from './editor.js';
import { setupExport } from './export.js';

const $ = (id) => document.getElementById(id);
export function toast(text, ms = 3200) {
  const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: text });
  $('toasts').append(t);
  setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, ms);
}

let make = { onTake() {}, hasVideo: () => false }; // replaced by setupMake() below; takes can arrive before it runs

// --- progress steps (top bar) ------------------------------------------------
const progress = { set: false, shoot: false, takes: false, make: false };
function markStep(name, done = true) {
  progress[name] = done;
  const order = ['set', 'shoot', 'takes', 'make'];
  const now = order.find((s) => !progress[s]) || 'make';
  for (const el of document.querySelectorAll('.step')) {
    el.classList.toggle('done', progress[el.dataset.step]);
    el.classList.toggle('now', el.dataset.step === now && !progress[now]);
  }
}

// --- info + QR -----------------------------------------------------------------
const info = await (await fetch(`/api/info${location.search}`)).json(); // /desk?room=XXXX picks the room
const base = info.publicUrl || info.lanUrl;
const camUrl = `${base.replace(/\/$/, '')}/cam?room=${info.room}`;
$('room').textContent = `ROOM ${info.room}`;
$('link').innerHTML = `<a href="${camUrl}">${camUrl.replace(/^https?:\/\//, '')}</a>`;
$('httpsWarn').hidden = camUrl.startsWith('https');
import('https://cdn.jsdelivr.net/npm/qrcode@1.5.3/+esm').then(async ({ default: QRCode }) => {
  const c = document.createElement('canvas');
  await QRCode.toCanvas(c, camUrl, { width: 224, margin: 0, color: { dark: '#141210', light: '#ffffff' } });
  $('qr').append(c);
}).catch(() => { $('qr').textContent = 'QR unavailable: open the link below on your phone'; });

// --- three.js overview --------------------------------------------------------------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene3 = new THREE.Scene();
scene3.fog = new THREE.Fog(0x0b0b0e, 40, 90);
addDefaultLights(scene3);
const grid = new THREE.GridHelper(60, 60, 0x3a2a22, 0x1d1d22);
grid.position.y = 0.002;
scene3.add(grid);
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
camera.position.set(11, 9, 15);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 1, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.49;

/** A frustum outline for a phone camera. view() reshapes it to the phone's real fov/aspect. */
function makeGizmo(color) {
  const cam = new THREE.PerspectiveCamera(60, 9 / 16, 0.2, 1.5);
  const helper = new THREE.CameraHelper(cam);
  helper.setColors(...Array(5).fill(new THREE.Color(color)));
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.12, 20, 14), new THREE.MeshBasicMaterial({ color }));
  const group = new THREE.Group();
  group.add(helper, dot);
  scene3.add(group);
  return { group, dot, view(fov, aspect) {
    if (!(fov > 0 && aspect > 0) || (fov === cam.fov && aspect === cam.aspect)) return;
    cam.fov = fov; cam.aspect = aspect; cam.updateProjectionMatrix(); helper.update();
  } };
}
const live = makeGizmo(0xf4ede4);   // follows the phone right now
const replay = makeGizmo(0xe07a52); // follows the selected take
replay.group.visible = false;
live.group.position.set(0, 1.6, 6);
const replayCam = new THREE.PerspectiveCamera(60, 9 / 16, 0.05, 200); // renders the inset: what the take saw

let sceneGroup = null, liveScene = null, shownSceneId = null;
function showScene(scene) {
  if (sceneGroup) scene3.remove(sceneGroup);
  sceneGroup = renderScene(scene);
  scene3.add(sceneGroup);
  shownSceneId = scene.id;
}
function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas.parentElement);
resize();

// --- live pose: 1€ filter on the DISPLAY only ------------------------------------------
// Takes are recorded raw on the phone; this only calms what the outline shows (DECISIONS §2).
const filterOn = $('filter');
const liveFilter = new OneEuroQuat({ mincutoff: 1.0, beta: 0.01 });
filterOn.onchange = () => liveFilter.reset();
const poseQ = new THREE.Quaternion();
let recSince = null, liveSetMs = 0; // the phone's set clock (Phase 3b): the desk shows the set moving with it
function onPose(m) {
  liveSetMs = m.st ?? 0;
  poseQ.fromArray(m.q);
  if (filterOn.checked) liveFilter.filter(poseQ, m.ts, live.group.quaternion);
  else live.group.quaternion.copy(poseQ);
  live.group.position.fromArray(m.p);
  live.view(m.fov, m.aspect);
  live.dot.material.color.set(m.rec ? 0xff4d4d : 0xf4ede4);
  if (m.rec && recSince === null) recSince = performance.now();
  if (!m.rec) recSince = null;
  $('recChip').hidden = !m.rec;
}

// --- relay -----------------------------------------------------------------------
function setPhone(state, text) {
  $('status').textContent = text;
  $('phoneDot').className = `dot ${state}`;
  if (state === 'ok') markStep('shoot');
}
const relay = connectRelay({
  role: 'desk', room: info.room,
  onStatus: (s) => { if (s === 'disconnected') setPhone('warn', 'Server disconnected'); },
  onMessage: (m) => {
    if (m.t === MSG.PEER) {
      setPhone(m.joined ? 'ok' : 'warn', m.joined ? 'Phone connected' : 'Phone left');
      if (m.joined) { toast('Phone connected. Tap Re-anchor, then ● to shoot.'); if (liveScene) relay.send({ t: MSG.SCENE, scene: liveScene }); }
    }
    if (m.t === MSG.POSE) onPose(m);
    if (m.t === MSG.TAKE) receiveTake(m.take);
  },
});

// --- build scene from prompt --------------------------------------------------------
const buildBtn = $('build'), srcEl = $('src');
async function build(prompt) {
  buildBtn.disabled = true;
  $('veil').hidden = false; $('veilText').textContent = 'Building the set…';
  try {
    const { scene, source, note } = await (await fetch('/api/scene', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }) })).json();
    useScene(scene);
    srcEl.hidden = false;
    srcEl.textContent = source === 'llm' ? 'AI blockout' : 'Template';
    srcEl.className = `badge ${source === 'llm' ? 'accent' : ''}`;
    srcEl.title = note || '';
  } catch {
    toast('Could not build the set. Try again.');
  } finally { buildBtn.disabled = false; $('veil').hidden = true; }
}
function useScene(scene) {
  scene.setId ||= scene.id;
  liveScene = scene;
  undoStack.length = 0; undoBtn.disabled = true;
  selectTake(null);
  showScene(scene);
  relay.send({ t: MSG.SCENE, scene });
  keepScene(scene);
  if (scene.prompt && !$('prompt').value) $('prompt').value = scene.prompt;
  $('editWords').hidden = false;
  markStep('set');
}
/** Save a set version on this computer (takes replay in the exact version they were shot in) and remember it. */
function keepScene(scene) {
  putScene(scene).catch(() => {});
  try { localStorage.setItem('handcam.lastSceneId', scene.id); } catch {}
}

// --- Phase 3: fix the set (drag, turn, delete, words, undo) -------------------------------------
const undoStack = [], undoBtn = $('undoBtn');
/** A changed set becomes a new version (new id, same setId): older takes keep replaying in what they saw. */
function commitEdit(next) {
  undoStack.push(liveScene);
  if (undoStack.length > 10) undoStack.shift();
  undoBtn.disabled = false;
  setLive({ ...next, id: `scene-${Date.now()}`, setId: liveScene.setId || liveScene.id });
}
function setLive(scene) {
  liveScene = scene;
  showScene(scene);
  relay.send({ t: MSG.SCENE, scene });
  keepScene(scene);
  editor.refresh();
}
function undo() {
  const prev = undoStack.pop();
  if (!prev) return;
  undoBtn.disabled = !undoStack.length;
  setLive(prev);
  toast('Undone');
}
undoBtn.onclick = undo;
addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !/INPUT|TEXTAREA/.test(e.target.tagName)) { e.preventDefault(); undo(); }
});
const editor = setupEditor({
  canvas, camera, controls, scene3,
  getGroup: () => sceneGroup,
  getScene: () => (!current && liveScene && shownSceneId === liveScene.id ? liveScene : null), // only the live set, not a take's
  preview: (draft) => relay.send({ t: MSG.SCENE, scene: draft }),
  commit: commitEdit,
  onSelect: (o) => {
    $('selPill').hidden = !o;
    if (o) $('selName').textContent = o.label || o.id;
  },
});
async function editWithWords() {
  const words = $('editPrompt').value.trim();
  if (!words || !liveScene) return;
  if (current) selectTake(null);
  const btn = $('editBtn');
  btn.disabled = true; btn.textContent = 'Changing…';
  try {
    const r = await fetch('/api/scene', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: words, current: liveScene }) });
    const out = await r.json();
    if (out.unchanged) return toast(out.note || 'Nothing changed.', 5000);
    commitEdit(out.scene);
    $('editPrompt').value = '';
    toast('Set changed. Undo if it isn’t right.');
  } catch { toast('Could not change the set. Try again.'); }
  finally { btn.disabled = false; btn.textContent = 'Change'; }
}
$('editBtn').onclick = editWithWords;
$('editPrompt').addEventListener('keydown', (e) => { if (e.key === 'Enter') editWithWords(); });
buildBtn.onclick = () => build($('prompt').value.trim() || 'parking lot');
for (const chip of document.querySelectorAll('#examples .chip')) chip.onclick = () => { $('prompt').value = chip.textContent; build(chip.textContent); };
$('prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) buildBtn.click(); });

// --- the move as a curve (take cards + timeline) ---------------------------------------
/** Turn (yaw, degrees) per sample, relative to the start: what the hand did, left/right. */
export function turnCurve(take) {
  const out = []; let prev = null, acc = 0;
  for (const s of take.samples) {
    const [x, y, z, w] = s.q;
    const fx = -(2 * (x * z + w * y)), fz = -(1 - 2 * (x * x + y * y));
    const yaw = Math.atan2(-fx, -fz) * 180 / Math.PI;
    if (prev !== null) { let d = yaw - prev; d -= 360 * Math.round(d / 360); acc += d; }
    prev = yaw; out.push([s.ts, acc]);
  }
  return out;
}
function curvePath(take, w, h, pad = 3) {
  const c = turnCurve(take), T = take.samples.at(-1).ts || 1;
  const ys = c.map((p) => p[1]); const lo = Math.min(...ys, -5), hi = Math.max(...ys, 5);
  return c.filter((_, i) => i % 2 === 0 || i === c.length - 1)
    .map(([t, y], i) => `${i ? 'L' : 'M'}${(t / T * w).toFixed(1)},${(pad + (1 - (y - lo) / (hi - lo)) * (h - 2 * pad)).toFixed(1)}`).join('');
}

// --- takes: list, select, scrub, play ------------------------------------------------------
const takesEl = $('takes'), player = $('player'), scrub = $('scrub');
const takes = new Map(); // id -> take
let current = null, playhead = 0, playing = false;
const duration = (take) => take.samples.at(-1)?.ts ?? 0;
const secs = (ms) => (ms / 1000).toFixed(1);
const nice = (take) => (take.label ? take.label.replace(/^\d /, (m) => `Shot ${m}· `) : take.demo ? 'Demo take' : 'Take');

function takeTime(take) {
  const shotAt = new Date(take.id.slice(0, 19).replace(/T(\d\d)-(\d\d)-(\d\d)/, 'T$1:$2:$3') + 'Z');
  return isNaN(shotAt) ? 'example' : shotAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function renderList() {
  takesEl.innerHTML = '';
  const list = [...takes.values()].sort((a, b) => (b.demo ? -1 : 0) - (a.demo ? -1 : 0) || b.id.localeCompare(a.id));
  $('noTakes').hidden = list.length > 0;
  $('takeCount').textContent = list.length;
  for (const take of list) {
    const li = document.createElement('li');
    li.className = `take${take === current ? ' sel' : ''}`;
    li.innerHTML = `<span class="t-name"></span><svg viewBox="0 0 92 34" preserveAspectRatio="none"><path d="${curvePath(take, 92, 34)}" fill="none" stroke="${take === current ? '#f0a07d' : '#8b8780'}" stroke-width="1.6" stroke-linejoin="round"/></svg><span class="t-meta"></span>`;
    li.querySelector('.t-name').textContent = nice(take);
    if (take.labSent) li.querySelector('.t-name').insertAdjacentHTML('beforeend', ' <span class="badge ok">lab</span>');
    if (make.hasVideo(take.id)) li.querySelector('.t-name').insertAdjacentHTML('beforeend', ' <span class="badge accent">video</span>');
    li.querySelector('.t-meta').textContent = `${takeTime(take)} · ${secs(duration(take))} s`;
    li.onclick = () => selectTake(take);
    takesEl.append(li);
    if (take === current) requestAnimationFrame(() => li.scrollIntoView({ block: 'nearest' }));
  }
  if (list.length) markStep('takes');
}
function receiveTake(take) {
  if (!take?.id || !Array.isArray(take.samples) || !take.samples.length) return;
  takes.set(take.id, take);
  putTake(take).catch((e) => console.warn('could not save take', e));
  toast(`New take · ${secs(duration(take))} s`);
  selectTake(take);
}
/** The set a take was shot in: the live one, or one saved on this computer. */
export async function takeScene(take) {
  if (take.demo) return (await fetch('/demo/scene.json')).json();
  if (!take.sceneId || take.sceneId === liveScene?.id) return liveScene;
  return getScene(take.sceneId).catch(() => null);
}
async function selectTake(take) {
  if (armed) disarmDelete();
  current = take; playing = false; playhead = 0;
  player.hidden = !take;
  $('takePanel').hidden = !take;
  replay.group.visible = !!take;
  renderList();
  make.onTake(take);
  exporter?.onTake(take);
  if (!take) { if (liveScene && shownSceneId !== liveScene.id) showScene(liveScene); return; }
  replay.view(take.view?.fov, take.view?.aspect);
  replayCam.fov = take.view?.fov || 60; replayCam.aspect = take.view?.aspect || 9 / 16; replayCam.updateProjectionMatrix();
  scrub.max = Math.max(1, Math.round(duration(take)));
  $('playerName').textContent = nice(take);
  $('takeLen').textContent = `${secs(duration(take))} s`;
  $('curve').setAttribute('viewBox', '0 0 600 34');
  $('curve').innerHTML = `<path d="${curvePath(take, 600, 34)}" fill="none" stroke="#e07a52" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`;
  $('shot').value = take.label || '';
  const s = duration(take) / 1000;
  $('takeNote').textContent = take.labSent ? 'Sent to the lab.' : s < 3 ? `${secs(s * 1000)} s is short: AI video tools want at least 3 s.` : s > 15 ? 'Longer than most AI video tools accept (about 15 s).' : '';
  if (take.sceneId && take.sceneId !== shownSceneId) {
    const scene = await takeScene(take);
    if (scene && current === take) showScene(scene);
  }
}
function togglePlay() {
  if (!current) return;
  if (!playing && playhead >= duration(current)) playhead = 0;
  playing = !playing;
}
$('play').onclick = togglePlay;
scrub.oninput = () => { playing = false; playhead = Number(scrub.value); };
$('live').onclick = () => selectTake(null);
addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || /TEXTAREA|INPUT|SELECT|BUTTON/.test(e.target.tagName)) return;
  e.preventDefault(); togglePlay();
});

// --- selected take: name, export, send to lab ------------------------------------------------
const shotSel = $('shot');
for (const s of SHOTS) shotSel.append(new Option(s.replace(/^(\d) /, 'Shot $1 · '), s));
shotSel.onchange = () => {
  if (!current) return;
  if (shotSel.value) current.label = shotSel.value; else delete current.label;
  if (!current.demo) putTake(current).catch(() => {});
  renderList(); $('playerName').textContent = nice(current);
};
$('toLab').onclick = async () => {
  const take = current, btn = $('toLab');
  if (!take) return;
  if (take.demo) return toast('The demo take is already in the lab.');
  const scene = await takeScene(take);
  if (!scene) return toast('The set this take was shot in isn’t saved on this computer.');
  btn.disabled = true;
  try {
    const { labSent, ...clean } = take;
    const r = await fetch('/api/lab/take', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ take: clean, scene }) });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || r.statusText);
    take.labSent = true; putTake(take).catch(() => {});
    renderList();
    $('takeNote').innerHTML = `Saved in <code>${out.saved}</code>. Run <code>npm run lab:push</code> to upload.`;
  } catch (e) { toast(e.message, 5000); }
  finally { btn.disabled = false; }
};

// Delete asks twice: the first press arms it for a few seconds, the second deletes. No browser dialog.
let armed = null;
function disarmDelete() { clearTimeout(armed); armed = null; $('deleteTake').textContent = 'Delete take'; $('deleteTake').classList.remove('danger'); }
$('deleteTake').onclick = async () => {
  const take = current;
  if (!take) return;
  if (take.demo) return toast('The demo take can’t be deleted.');
  if (!armed) {
    $('deleteTake').textContent = 'Press again to delete';
    $('deleteTake').classList.add('danger');
    armed = setTimeout(disarmDelete, 3000);
    return;
  }
  disarmDelete();
  try { await deleteTake(take.id); } catch (e) { return toast(`Could not delete: ${e.message}`, 5000); }
  takes.delete(take.id);
  await selectTake(null);
  toast(take.labSent ? 'Take deleted. The copy already sent to the lab stays there.' : 'Take deleted.');
};

// --- demo take: try everything without a phone ---------------------------------------------
async function loadDemo() {
  const take = await (await fetch('/demo/take.json')).json();
  takes.set(take.id, take);
  await selectTake(take);
  toast('Demo take loaded: press play, then Make video.');
  return take;
}
$('demoBtn').onclick = $('demoBtn2').onclick = loadDemo;

// --- Phase 4 export panel -----------------------------------------------------------------
var exporter = setupExport({ getTake: () => current, takeScene, toast });

// --- Make video + tour ---------------------------------------------------------------
make = setupMake({ getTake: () => current, takeScene, toast, onDone: () => markStep('make'), onJobs: () => renderList() });
const tour = setupTour({ loadDemo });
$('helpBtn').onclick = () => tour.start();
$('replayTour').onclick = () => { $('settings').hidden = true; tour.start(); };
$('settingsBtn').onclick = (e) => { e.stopPropagation(); $('settings').hidden = !$('settings').hidden; };
document.addEventListener('click', (e) => { if (!e.target.closest('#settings')) $('settings').hidden = true; });

// --- start ---------------------------------------------------------------------------
for (const take of await allTakes().catch(() => [])) takes.set(take.id, take);
renderList();
const params = new URLSearchParams(location.search);
if (params.has('demo')) { await build('parking lot at night'); await loadDemo(); }
else {
  let last = null;
  try { const id = localStorage.getItem('handcam.lastSceneId'); if (id) last = await getScene(id); } catch {}
  if (last) useScene(last); // the set you were working on, as you left it
  else build($('prompt').value.trim() || 'parking lot');
}
tour.maybeAutoStart(params.has('tour') || params.has('demo'));

// --- loop -----------------------------------------------------------------------------
const insetEl = $('inset'), size = new THREE.Vector2();
let lastT = performance.now();
function frame(t) {
  const dt = t - lastT; lastT = t;
  if (current) {
    if (playing) { playhead += dt; if (playhead >= duration(current)) { playhead = duration(current); playing = false; } }
    const s = sampleAt(current.samples, playhead);
    if (s.f) { // Phase 4: the zoom as performed, sample by sample
      const fov = takeOutput(current).fovAt(s);
      replay.view(fov, current.view?.aspect);
      if (replayCam.fov !== fov) { replayCam.fov = fov; replayCam.updateProjectionMatrix(); }
    }
    replay.group.quaternion.fromArray(s.q); replay.group.position.fromArray(s.p);
    replayCam.quaternion.fromArray(s.q); replayCam.position.fromArray(s.p);
    scrub.value = playhead;
    $('head').style.left = `${(playhead / Math.max(1, duration(current))) * 100}%`;
    $('play').innerHTML = playing ? '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 3h3v10H4zM9 3h3v10H9z"/></svg>' : '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l9-5.5z"/></svg>';
    $('time').textContent = `${secs(playhead)} / ${secs(duration(current))} s`;
  }
  if (recSince !== null) { const s = Math.floor((performance.now() - recSince) / 1000); $('recTime').textContent = `REC ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
  controls.update();
  editor.update();
  if (!editor.busy()) animateScene(sceneGroup, current ? playhead : liveSetMs); // a take replays the set's motion too
  renderer.setScissorTest(false);
  renderer.getSize(size);
  renderer.setViewport(0, 0, size.x, size.y);
  renderer.render(scene3, camera);
  insetEl.hidden = !current;
  if (current) { // inset: what the take's camera saw, without the outlines
    const h = Math.round(size.y * 0.46), w = Math.round(h * replayCam.aspect), x = size.x - w - 18, y = 86;
    live.group.visible = replay.group.visible = false;
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, w, h); renderer.setViewport(x, y, w, h);
    renderer.setClearColor(0x161a22, 1); renderer.clear();
    renderer.render(scene3, replayCam);
    renderer.setClearColor(0x000000, 0);
    live.group.visible = replay.group.visible = true;
    Object.assign(insetEl.style, { left: `${x}px`, top: `${size.y - y - h}px`, width: `${w}px`, height: `${h}px` });
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
