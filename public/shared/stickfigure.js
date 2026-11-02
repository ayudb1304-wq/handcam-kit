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

export function buildStickFigure({ height = 1.75, pose = 'standing', color = '#e0a040' } = {}) {
  const joints = POSES[pose] || POSES.standing;
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
  const g = new THREE.Group();
  const v = (name) => new THREE.Vector3(...joints[name]).multiplyScalar(height);

  const head = new THREE.Mesh(new THREE.SphereGeometry(HEAD_RADIUS * height, 14, 10), mat);
  head.position.copy(v('head'));
  g.add(head);

  for (const [a, b, r] of BONES) {
    const from = v(a), to = v(b);
    const dir = to.clone().sub(from);
    const len = dir.length();
    const limb = new THREE.Mesh(new THREE.CylinderGeometry(r * height, r * height, len, 8), mat);
    limb.position.copy(from).addScaledVector(dir, 0.5);
    limb.quaternion.setFromUnitVectors(UP, dir.normalize());
    g.add(limb);
  }
  return g;
}
