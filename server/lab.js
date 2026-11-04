// "Send to lab": the desk saves a take and its set into lab/takes/<take id>/ on this computer,
// so `npm run lab:push` can put them on GitHub for recipe tests. Only from the laptop itself (see isLocal).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateScene } from './validate-scene.js';
import { SHOTS } from '../public/shared/protocol.js';

const ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$/;

/** Problems with a { take, scene } body, as short strings. Empty means it can be saved. */
export function checkLabTake(body) {
  const { take, scene } = body || {};
  const errors = [];
  if (!take || typeof take !== 'object') return ['take missing'];
  if (typeof take.id !== 'string' || !ID.test(take.id)) errors.push('take.id must be a plain id');
  if (!Array.isArray(take.samples) || !take.samples.length) errors.push('take has no samples');
  else if (!take.samples.every((s) => Number.isFinite(s?.ts) && s.q?.length === 4 && s.p?.length === 3)) errors.push('take has a bad sample');
  if (take.label != null && !SHOTS.includes(take.label)) errors.push('unknown shot name');
  errors.push(...validateScene(scene).map((e) => `scene: ${e}`));
  return errors;
}

/**
 * True only for a request made on this computer, not through the HTTPS tunnel or the LAN.
 * cloudflared connects from localhost too, so its forwarding headers are what give it away.
 */
export function isLocal(req) {
  if (/^(1|on|true)$/i.test(process.env.LOCAL_IS_CUSTOMER || '')) return false; // testing: see the app as a customer does
  const ip = req.socket?.remoteAddress || '';
  const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const forwarded = ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-forwarded-host'].some((h) => req.headers?.[h]);
  return loopback && !forwarded;
}

/** Write take.json and scene.json; returns the folder, relative to the repo. */
export async function saveLabTake(root, { take, scene }) {
  const rel = join('lab', 'takes', take.id);
  await mkdir(join(root, rel), { recursive: true });
  await writeFile(join(root, rel, 'take.json'), JSON.stringify(take));
  await writeFile(join(root, rel, 'scene.json'), JSON.stringify(scene, null, 2));
  return rel;
}
