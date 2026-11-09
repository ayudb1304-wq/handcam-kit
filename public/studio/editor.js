// Phase 3 "Fix the set": click an object to select it, drag to move it on the ground, hold R and drag to turn it,
// Delete removes it. Floors (planes) can't be picked: dragging on them still orbits the view.
// The camera start (scene.spawn) is picked the same way: drag it to move where every take starts, R+drag to aim it.
// The editor never owns the set: it asks main.js for the live scene and hands back a changed copy.
import * as THREE from '../shared/three.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

/** A copy of the scene with object `id` changed by fn(object), or removed when fn returns null. */
export function changeObject(scene, id, fn) {
  const next = clone(scene);
  next.objects = next.objects.flatMap((o) => (o.id === id ? [fn(o)].filter(Boolean) : [o]));
  return next;
}

export const START = '__start'; // the id the camera start answers to while selected

export function setupEditor({ canvas, camera, controls, scene3, getGroup, getScene, getStart = () => null, preview, commit, onSelect = () => {} }) {
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  ray.layers.enableAll(); // the camera start lives on its own layer (main.js)
  const hit = new THREE.Vector3();
  let selected = null, drag = null, rKey = false, lastPreview = 0;
  const box = new THREE.BoxHelper(undefined, 0xf0a07d);
  box.visible = false;
  scene3.add(box);

  const typing = (e) => /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
  function aim(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
  }
  /** The top-level mesh of the set under the pointer (its userData.obj is the scene object), skipping floors. */
  function pick(e) {
    const group = getGroup();
    if (!group || !getScene()) return null;
    aim(e);
    const start = getStart();
    if (start?.visible && ray.intersectObject(start, true).length) return start; // the start sits in front of the set
    for (const h of ray.intersectObjects(group.children, true)) {
      let m = h.object;
      while (m.parent && m.parent !== group) m = m.parent;
      const o = m.userData.obj;
      if (o && o.type !== 'plane') return m;
    }
    return null;
  }
  function meshOf(id) { return id === START ? getStart() : getGroup()?.children.find((m) => m.name === id) || null; }
  function select(id) {
    selected = id && meshOf(id) && getScene() ? id : null;
    box.visible = !!selected;
    if (selected) box.setFromObject(meshOf(selected));
    onSelect(!selected ? null : selected === START ? { id: START, label: 'Camera start' } : getScene().objects.find((o) => o.id === selected));
  }
  /** The scene as the dragged mesh shows it right now. */
  function draft() {
    const m = meshOf(drag.id);
    if (drag.id === START) {
      const next = clone(getScene()), y = next.spawn?.p?.[1] ?? 1.6;
      next.spawn = { ...next.spawn, p: [round(m.position.x), y, round(m.position.z)], yaw: round(m.rotation.y, 3) };
      return next;
    }
    return changeObject(getScene(), drag.id, (o) => {
      o.p = [round(m.position.x), o.p?.[1] ?? 0, round(m.position.z)];
      if (drag.turned) o.rot = [o.rot?.[0] || 0, round(m.rotation.y, 3), o.rot?.[2] || 0];
      return o;
    });
  }
  const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const m = pick(e);
    if (!m) { if (!e.shiftKey) select(null); return; } // empty space or floor: let the view orbit
    e.stopImmediatePropagation(); // capture phase: OrbitControls never sees this press
    select(m.name);
    aim(e);
    ray.ray.intersectPlane(ground, hit);
    drag = { id: m.name, from: hit.clone(), start: m.position.clone(), yaw: m.rotation.y, x: e.clientX, moved: false, turned: false };
    controls.enabled = false;
    canvas.setPointerCapture(e.pointerId);
  }, { capture: true });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag) {
      canvas.style.cursor = pick(e) ? (rKey ? 'ew-resize' : 'grab') : '';
      return;
    }
    const m = meshOf(drag.id);
    if (!m) return;
    if (rKey) {
      m.rotation.y = drag.yaw + (e.clientX - drag.x) * 0.01;
      drag.turned = true;
    } else {
      aim(e);
      if (!ray.ray.intersectPlane(ground, hit)) return;
      m.position.x = drag.start.x + hit.x - drag.from.x;
      m.position.z = drag.start.z + hit.z - drag.from.z;
    }
    drag.moved = true;
    canvas.style.cursor = 'grabbing';
    box.setFromObject(m);
    const now = performance.now();
    if (now - lastPreview > 100) { lastPreview = now; preview(draft()); } // the phone follows the drag live
  });

  function end() {
    if (!drag) return;
    const done = drag.moved ? draft() : null;
    drag = null;
    controls.enabled = true;
    canvas.style.cursor = '';
    if (done) commit(done);
  }
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  addEventListener('keydown', (e) => {
    if (typing(e)) return;
    if (e.key === 'r' || e.key === 'R') rKey = true;
    if (e.key === 'Escape') select(null);
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected && selected !== START) {
      e.preventDefault();
      const id = selected;
      select(null);
      commit(changeObject(getScene(), id, () => null));
    }
  });
  addEventListener('keyup', (e) => { if (e.key === 'r' || e.key === 'R') rKey = false; });
  addEventListener('blur', () => { rKey = false; });

  return {
    /** After the set is rebuilt: keep the same object selected if it still exists. */
    refresh() { select(selected); },
    clear() { select(null); },
    busy: () => !!drag,
    update() { if (selected && box.visible) { const m = meshOf(selected); if (m) box.setFromObject(m); } },
  };
}
