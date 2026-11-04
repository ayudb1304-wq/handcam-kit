// Stick figure for blockouts: a sphere head and cylinder limbs between joints.
// Origin = between the feet on the ground (pelvis for "lying"). Faces +Z at rotation 0.
// POSES is plain data on purpose: exporters/blender_import.py mirrors these exact numbers (Phase 4).
import * as THREE from './three.js';

// Joint positions for a figure 1 unit tall: [x, y, z]. Left side is +x. Scaled by height at build time.
const P = (x, y, z) => [x, y, z];
const mirror = (j) => ({ ...j, ...Object.fromEntries(Object.entries(j).filter(([k]) => k.endsWith('L')).map(([k, [x, y, z]]) => [k.slice(0, -1) + 'R', [-x, y, z]])) });

export const POSES = {
  standing: mirror({
    head: P(0, 0.93, 0), neck: P(0, 0.86, 0), pelvis: P(0, 0.53, 0),
    shoulderL: P(0.12, 0.82, 0), elbowL: P(0.14, 0.64, 0), handL: P(0.15, 0.45, 0.02),
    hipL: P(0.06, 0.52, 0), kneeL: P(0.07, 0.28, 0.01), footL: P(0.07, 0.02, 0),
  }),
  sitting: mirror({ // on a seat 0.26 tall, hands on lap
    head: P(0, 0.67, 0), neck: P(0, 0.60, 0), pelvis: P(0, 0.27, 0),
    shoulderL: P(0.12, 0.57, 0), elbowL: P(0.15, 0.42, 0.08), handL: P(0.11, 0.32, 0.2),
    hipL: P(0.06, 0.27, 0), kneeL: P(0.07, 0.27, 0.24), footL: P(0.07, 0.02, 0.26),
  }),
  lying: mirror({ // on its back, head toward -Z
    head: P(0, 0.07, -0.40), neck: P(0, 0.06, -0.33), pelvis: P(0, 0.06, 0),
    shoulderL: P(0.12, 0.06, -0.30), elbowL: P(0.16, 0.05, -0.12), handL: P(0.17, 0.05, 0.06),
    hipL: P(0.06, 0.06, 0), kneeL: P(0.07, 0.06, 0.24), footL: P(0.07, 0.06, 0.5),
  }),
  crouching: mirror({ // squatting, leaning forward, hands on knees
    head: P(0, 0.65, 0.10), neck: P(0, 0.58, 0.06), pelvis: P(0, 0.30, -0.08),
    shoulderL: P(0.12, 0.55, 0.05), elbowL: P(0.13, 0.40, 0.15), handL: P(0.11, 0.24, 0.22),
    hipL: P(0.07, 0.30, -0.08), kneeL: P(0.09, 0.27, 0.14), footL: P(0.08, 0.02, 0.08),
  }),
};

// [from, to, radius] — radius is a fraction of height, like the joints.
export const BONES = [
  ['neck', 'pelvis', 0.05],
  ['shoulderL', 'shoulderR', 0.03], ['hipL', 'hipR', 0.035],
  ['shoulderL', 'elbowL', 0.025], ['elbowL', 'handL', 0.022],
  ['shoulderR', 'elbowR', 0.025], ['elbowR', 'handR', 0.022],
  ['hipL', 'kneeL', 0.032], ['kneeL', 'footL', 0.028],
  ['hipR', 'kneeR', 0.032], ['kneeR', 'footR', 0.028],
];
export const HEAD_RADIUS = 0.065;

const UP = new THREE.Vector3(0, 1, 0);

/** Rotate point j about pivot in the y-z plane (a leg or arm swinging forward/back). */
function swing([x, y, z], [, py, pz], a) {
  const dy = y - py, dz = z - pz, c = Math.cos(a), s = Math.sin(a);
  return [x, py + dy * c - dz * s, pz + dy * s + dz * c];
}

/**
 * Joints for a pose; `walk` (0..1 of a stride cycle) swings legs and arms of a standing figure.
 * Pure data, like POSES, so the Blender exporter can bake the same thing.
 */
export function jointsFor(pose = 'standing', walk = null) {
  const j = POSES[pose] || POSES.standing;
  if (walk == null || pose !== 'standing') return j;
  const k = Math.sin(walk * 2 * Math.PI), legA = 0.42 * k, armA = 0.32 * k;
  const out = { ...j };
  for (const [side, sign] of [['L', 1], ['R', -1]]) {
    const hip = j[`hip${side}`], sh = j[`shoulder${side}`];
    const knee = swing(j[`knee${side}`], hip, -legA * sign);
    // the back leg's foot lifts a little (knee bends) as it comes through
    const bend = Math.max(0, legA * sign) * 0.9;
    out[`knee${side}`] = knee;
    out[`foot${side}`] = swing(swing(j[`foot${side}`], hip, -legA * sign), knee, bend);
    out[`elbow${side}`] = swing(j[`elbow${side}`], sh, armA * sign);
    out[`hand${side}`] = swing(j[`hand${side}`], sh, armA * sign * 1.2);
  }
  return out;
}

export function buildStickFigure({ height = 1.75, pose = 'standing', color = '#e0a040' } = {}) {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
  const g = new THREE.Group();
  const head = new THREE.Mesh(new THREE.SphereGeometry(HEAD_RADIUS * height, 14, 10), mat);
  g.add(head);
  // unit-length limbs, scaled along their axis: posing a figure is then just moving meshes, no new geometry
  const limbs = BONES.map(([a, b, r]) => {
    const limb = new THREE.Mesh(new THREE.CylinderGeometry(r * height, r * height, 1, 8), mat);
    g.add(limb);
    return { mesh: limb, a, b };
  });
  g.userData.figure = { height, head, limbs, pose: null, walk: null };
  poseStickFigure(g, pose);
  return g;
}

const va = new THREE.Vector3(), vb = new THREE.Vector3();
/** Re-pose a figure made by buildStickFigure (Phase 3b: pose changes and walking). Cheap: no allocation. */
export function poseStickFigure(g, pose = 'standing', walk = null) {
  const f = g.userData.figure;
  if (!f || (f.pose === pose && f.walk === walk)) return;
  f.pose = pose; f.walk = walk;
  const j = jointsFor(pose, walk), h = f.height;
  f.head.position.set(...j.head).multiplyScalar(h);
  for (const { mesh, a, b } of f.limbs) {
    va.set(...j[a]).multiplyScalar(h); vb.set(...j[b]).multiplyScalar(h);
    vb.sub(va);
    const len = vb.length();
    mesh.position.copy(va).addScaledVector(vb, 0.5);
    mesh.scale.set(1, len, 1);
    mesh.quaternion.setFromUnitVectors(UP, vb.normalize());
  }
}
