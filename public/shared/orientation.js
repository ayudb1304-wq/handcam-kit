// DeviceOrientation (alpha, beta, gamma in degrees) -> three.js camera quaternion.
// Same math as three.js' old DeviceOrientationControls, kept here because it was removed from the lib.
// Y up, camera looks down -Z. Phone held in portrait, screen facing you, top edge up = looking forward.
import { Quaternion, Euler, Vector3, MathUtils } from './three.js';

const zee = new Vector3(0, 0, 1);
const euler = new Euler();
const q0 = new Quaternion();
const q1 = new Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -PI/2 around X: camera looks out the back of the phone

export function orientationToQuaternion(out, alphaDeg, betaDeg, gammaDeg, screenAngleDeg = 0) {
  const a = MathUtils.degToRad(alphaDeg || 0);
  const b = MathUtils.degToRad(betaDeg || 0);
  const g = MathUtils.degToRad(gammaDeg || 0);
  const o = MathUtils.degToRad(screenAngleDeg || 0);
  euler.set(b, a, -g, 'YXZ');
  out.setFromEuler(euler);
  out.multiply(q1);
  out.multiply(q0.setFromAxisAngle(zee, -o));
  return out;
}

/** iOS needs a user gesture + https. Resolves true if events will flow. */
export async function requestMotionPermission() {
  if (typeof DeviceOrientationEvent === 'undefined') return false;
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    try { return (await DeviceOrientationEvent.requestPermission()) === 'granted'; } catch { return false; }
  }
  return true; // Android / desktop: no prompt
}

export function screenAngle() {
  return (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (window.orientation || 0);
}
