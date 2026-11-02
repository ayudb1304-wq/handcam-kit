// Scene JSON -> THREE.Group. Phase 0: plane/box/cylinder/sphere + a placeholder stick figure.
// Phase 1 moves the stick figure to shared/stickfigure.js with real poses.
import * as THREE from './three.js';

export function renderScene(scene) {
  const g = new THREE.Group();
  g.name = scene.id || 'scene';
  for (const o of scene.objects || []) {
    const m = buildObject(o);
    if (m) { m.name = o.id; m.userData.obj = o; g.add(m); }
  }
  return g;
}

function mat(color = '#8a8f99') {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0 });
}

function withEdges(mesh) {
  const e = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: 0x111111 }));
  mesh.add(e);
  return mesh;
}

function place(mesh, o) {
  const [x = 0, y = 0, z = 0] = o.p || [];
  mesh.position.set(x, y, z);
  const [rx = 0, ry = 0, rz = 0] = o.rot || [];
  mesh.rotation.set(rx, ry, rz);
  return mesh;
}

function buildObject(o) {
  switch (o.type) {
    case 'plane': {
      const [w = 20, d = 20] = o.size || [];
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat(o.color || '#2b2b2b'));
      m.rotation.x = -Math.PI / 2;
      m.position.set(...(o.p || [0, 0, 0]));
      m.receiveShadow = true;
      return m;
    }
    case 'box': {
      const [w = 1, h = 1, d = 1] = o.size || [];
      const m = withEdges(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(o.color)));
      return place(m, o);
    }
    case 'cylinder': {
      const [r = 0.5, h = 1] = o.size || [];
      return place(withEdges(new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 16), mat(o.color))), o);
    }
    case 'sphere': {
      const [r = 0.5] = o.size || [];
      return place(new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), mat(o.color)), o);
    }
    case 'stickfigure':
      return place(placeholderFigure(o.height || 1.75, o.color || '#e0a040'), o);
    default:
      console.warn('unknown object type', o.type);
      return null;
  }
}

// Phase 0 placeholder: a capsule-ish person. Replaced by shared/stickfigure.js in Phase 1.
function placeholderFigure(h, color) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, h * 0.6, 12), mat(color));
  body.position.y = h * 0.6 / 2 + h * 0.25;
  const head = new THREE.Mesh(new THREE.SphereGeometry(h * 0.08, 12, 10), mat(color));
  head.position.y = h * 0.92;
  const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, h * 0.25, 8), mat(color));
  legs.position.y = h * 0.125;
  g.add(body, head, legs);
  return g;
}

export function addDefaultLights(scene3) {
  scene3.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.0));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(5, 10, 4);
  scene3.add(sun);
}
