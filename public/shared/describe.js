// A short, ready-to-paste prompt describing a take's camera move in words (Phase 4 export).
// It describes what the hand did; it never changes it. Pure: tested in server/describe.test.js.

function yawDeg([x, y, z, w]) {
  const fx = -(2 * (x * z + w * y)), fz = -(1 - 2 * (x * x + y * y));
  return (Math.atan2(-fx, -fz) * 180) / Math.PI;
}
function pitchDeg([x, y, z, w]) {
  return (Math.asin(Math.max(-1, Math.min(1, -(2 * (y * z - w * x))))) * 180) / Math.PI;
}

/** Numbers about the move: turn (deg, + = left), fastest turn (deg/s), forward/side/up (m, in the starting view), tilt, zoom. */
export function measureMove(samples) {
  const a = samples[0], b = samples.at(-1), yaw0 = yawDeg(a.q);
  let turn = 0, prev = yaw0, fastest = 0, minTurn = 0, maxTurn = 0;
  for (let i = 1; i < samples.length; i++) {
    const y = yawDeg(samples[i].q);
    let d = y - prev; d -= 360 * Math.round(d / 360);
    turn += d; prev = y;
    minTurn = Math.min(minTurn, turn); maxTurn = Math.max(maxTurn, turn);
    const dt = (samples[i].ts - samples[i - 1].ts) / 1000;
    if (dt > 0) fastest = Math.max(fastest, Math.abs(d) / dt);
  }
  const r = (yaw0 * Math.PI) / 180, dx = b.p[0] - a.p[0], dz = b.p[2] - a.p[2];
  const forward = -(Math.sin(r) * -dx + Math.cos(r) * dz) ; // along the starting view (camera looks -z at yaw 0)
  const side = Math.cos(r) * dx + Math.sin(r) * -dz;
  return {
    seconds: b.ts / 1000, turn, turnRange: maxTurn - minTurn, fastest,
    forward: forward, side, up: b.p[1] - a.p[1], tilt: pitchDeg(b.q) - pitchDeg(a.q),
    zoom: a.f && b.f ? b.f / a.f : 1, lens: a.f || null,
  };
}

const sec = (n) => `${n.toFixed(n < 10 ? 1 : 0)} s`;

/** One sentence for an AI video tool, e.g. "Handheld camera, slow push-in toward the man, then a fast whip pan left." */
export function describeMove(take, scene) {
  const m = measureMove(take.samples), parts = [];
  const subject = (scene?.objects || []).find((o) => o.type === 'stickfigure')?.label || ((scene?.objects || []).some((o) => o.type === 'stickfigure') ? 'the person' : 'the scene');
  if (m.fastest > 150 && m.turnRange > 25) parts.push(`a fast whip pan ${m.turn >= 0 ? 'left' : 'right'}`);
  else if (Math.abs(m.turn) > 20) parts.push(`a ${Math.abs(m.turn) > 70 ? 'wide ' : ''}pan ${m.turn >= 0 ? 'left' : 'right'}`);
  if (Math.abs(m.side) > 1.5 && Math.abs(m.turn) > 40) parts.push(`an arc around ${subject}`);
  else if (Math.abs(m.side) > 1) parts.push(`a sideways move to the ${m.side > 0 ? 'right' : 'left'}`);
  if (m.forward > 0.8) parts.push(`a ${m.forward / m.seconds < 0.8 ? 'slow ' : ''}push-in toward ${subject}`);
  else if (m.forward < -0.8) parts.push(`a pull-back away from ${subject}`);
  if (m.up < -0.4) parts.push('the camera lowers toward the ground');
  else if (m.up > 0.4) parts.push('the camera rises');
  if (Math.abs(m.tilt) > 15) parts.push(`a tilt ${m.tilt > 0 ? 'up' : 'down'}`);
  if (m.zoom > 1.25) parts.push('a zoom in');
  else if (m.zoom < 0.8) parts.push('a zoom out');
  const move = parts.length ? parts.join(', then ') : 'an almost still frame with natural hand sway';
  const lens = m.lens ? `, ${Math.round(m.lens)} mm lens` : '';
  const set = scene?.prompt ? `${scene.prompt.replace(/\.*\s*$/, '')}. ` : '';
  return `${set}Handheld camera${lens}: ${move}, over ${sec(m.seconds)}. Follow the camera move of the reference video exactly, including its timing and small handheld shakes.`;
}
