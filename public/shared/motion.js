// Phase 3b: the set's own motion. People walk, cars drive, a driver rides in a car. The CAMERA is never here:
// it is always recorded from the hand (DECISIONS §17). Motion is a pure function of (scene, t), so a take stays
// camera-only and the desk, the exporter and Blender recompute the set from the same numbers.
// No three.js: tested in server/motion.test.js.
//
// object.moves: actions done one after another, starting when ● is pressed (t = 0):
//   { do: 'go', to: [x, z], speed: 1.4 }  walk/drive in a straight line (m/s), facing the way it travels
//   { do: 'turn', yaw: 1.57 }             turn on the spot to face yaw (radians, 0 = facing +z)
//   { do: 'pose', pose: 'sitting' }       stick figures only, instant
//   { do: 'wait', s: 2 }
// object.on: 'car': carried by that object, keeping its offset at rest (one level deep).

export const MOVE_ACTIONS = ['go', 'turn', 'pose', 'wait'];
export const TURN_RATE = Math.PI; // rad/s: a half turn takes one second
export const DEFAULT_SPEED = 1.4; // m/s, walking

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Per object: the timeline of its own moves, from its rest state. Objects without moves are left out. */
function timeline(o) {
  let x = o.p?.[0] ?? 0, z = o.p?.[2] ?? 0, yaw = o.rot?.[1] ?? 0, pose = o.pose, t = 0;
  const segs = [];
  for (const m of o.moves || []) {
    if (m.do === 'go' && Array.isArray(m.to)) {
      const [tx, tz] = m.to, d = Math.hypot(tx - x, tz - z), v = Math.max(0.05, m.speed || DEFAULT_SPEED);
      if (d < 1e-6) continue;
      const face = Math.atan2(tx - x, tz - z);
      segs.push({ kind: 'go', t0: t, t1: t + d / v, x0: x, z0: z, x1: tx, z1: tz, yaw: face, pose, v });
      t += d / v; x = tx; z = tz; yaw = face;
    } else if (m.do === 'turn' && Number.isFinite(m.yaw)) {
      const dy = wrap(m.yaw - yaw), dur = Math.abs(dy) / TURN_RATE;
      segs.push({ kind: 'turn', t0: t, t1: t + dur, x, z, yaw0: yaw, yaw1: yaw + dy, pose });
      t += dur; yaw = yaw + dy;
    } else if (m.do === 'pose' && typeof m.pose === 'string') {
      pose = m.pose;
      segs.push({ kind: 'pose', t0: t, t1: t, x, z, yaw, pose });
    } else if (m.do === 'wait' && Number.isFinite(m.s)) {
      segs.push({ kind: 'wait', t0: t, t1: t + Math.max(0, m.s), x, z, yaw, pose });
      t += Math.max(0, m.s);
    }
  }
  return { rest: { x: o.p?.[0] ?? 0, y: o.p?.[1] ?? 0, z: o.p?.[2] ?? 0, yaw: o.rot?.[1] ?? 0, pose: o.pose }, segs, end: t, final: { x, z, yaw, pose } };
}

/** Everything needed to ask "where is it at t?" quickly. Build once per scene. */
export function planMotion(scene) {
  const byId = new Map((scene.objects || []).map((o) => [o.id, o]));
  const own = new Map();
  for (const o of scene.objects || []) if (o.moves?.length) own.set(o.id, timeline(o));
  const riders = new Map(); // id -> parent id, only when the parent exists and is not itself riding
  for (const o of scene.objects || []) {
    const parent = o.on && byId.get(o.on);
    if (parent && parent.id !== o.id && !parent.on) riders.set(o.id, parent.id);
  }
  let duration = 0;
  for (const tl of own.values()) duration = Math.max(duration, tl.end);
  return { byId, own, riders, duration, moving: new Set([...own.keys(), ...riders.keys()]) };
}

/** Own motion only (no riding), seconds. → { x, y, z, yaw, pose, walked } where walked = metres covered (for leg swing). */
function ownState(plan, o, ts) {
  const tl = plan.own.get(o.id);
  const rest = { x: o.p?.[0] ?? 0, y: o.p?.[1] ?? 0, z: o.p?.[2] ?? 0, yaw: o.rot?.[1] ?? 0, pose: o.pose, walked: 0, moving: false };
  if (!tl) return rest;
  let walked = 0, s = { ...rest };
  for (const seg of tl.segs) {
    if (ts < seg.t0) break;
    const done = ts >= seg.t1;
    const f = seg.t1 > seg.t0 ? Math.min(1, (ts - seg.t0) / (seg.t1 - seg.t0)) : 1;
    if (seg.kind === 'go') {
      const len = Math.hypot(seg.x1 - seg.x0, seg.z1 - seg.z0);
      s = { ...s, x: seg.x0 + (seg.x1 - seg.x0) * f, z: seg.z0 + (seg.z1 - seg.z0) * f, yaw: seg.yaw, pose: seg.pose, moving: !done };
      walked += len * f;
    } else if (seg.kind === 'turn') {
      s = { ...s, x: seg.x, z: seg.z, yaw: seg.yaw0 + (seg.yaw1 - seg.yaw0) * f, pose: seg.pose, moving: !done };
    } else {
      s = { ...s, x: seg.x, z: seg.z, yaw: seg.yaw, pose: seg.pose, moving: false };
    }
    if (!done) break;
  }
  return { ...s, walked };
}

/**
 * Where object `id` is at time `ms` after ● (ms ≤ 0 = at rest). → { p:[x,y,z], yaw, pose, walked, moving } or null.
 * A rider keeps its rest offset in its parent's frame and turns with it; its own moves are ignored except pose.
 */
export function stateAt(plan, id, ms) {
  const o = plan.byId.get(id);
  if (!o) return null;
  const ts = Math.max(0, ms / 1000);
  const parentId = plan.riders.get(id);
  if (!parentId) {
    const s = ownState(plan, o, ts);
    return { p: [s.x, s.y, s.z], yaw: s.yaw, pose: s.pose, walked: s.walked, moving: s.moving };
  }
  const parent = plan.byId.get(parentId);
  // the parent as it stands in the set (rot/p), not at t = 0: a car snaps to face its first `go` when ● is pressed
  const p0 = { x: parent.p?.[0] ?? 0, y: parent.p?.[1] ?? 0, z: parent.p?.[2] ?? 0, yaw: parent.rot?.[1] ?? 0 };
  const p1 = ownState(plan, parent, ts), me = ownState(plan, o, ts);
  // offset at rest, in the parent's own frame (undo the parent's rest yaw)
  const dx = (o.p?.[0] ?? 0) - p0.x, dz = (o.p?.[2] ?? 0) - p0.z, c0 = Math.cos(-p0.yaw), s0 = Math.sin(-p0.yaw);
  const lx = c0 * dx + s0 * dz, lz = -s0 * dx + c0 * dz;
  const c1 = Math.cos(p1.yaw), s1 = Math.sin(p1.yaw);
  return {
    p: [p1.x + c1 * lx + s1 * lz, (o.p?.[1] ?? 0) + (p1.y - p0.y), p1.z - s1 * lx + c1 * lz],
    yaw: (o.rot?.[1] ?? 0) + (p1.yaw - p0.yaw),
    pose: me.pose,
    walked: 0,
    moving: p1.moving,
  };
}

/** The 4×4 world transform (column-major array, like THREE.Matrix4.elements) of a moving object at ms: for riding along. */
export function frameAt(plan, id, ms) {
  const s = stateAt(plan, id, ms);
  if (!s) return null;
  const c = Math.cos(s.yaw), n = Math.sin(s.yaw);
  return { yaw: s.yaw, p: s.p, elements: [c, 0, -n, 0, 0, 1, 0, 0, n, 0, c, 0, s.p[0], s.p[1], s.p[2], 1] };
}
