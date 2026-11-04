// Accounts, sessions and the video balance (Phase 5). One JSON file under DATA_DIR, written atomically, kept in
// memory: one server, a few hundred users at most for now. No database, no new dependency (DECISIONS §34).
// Passwords: scrypt from node:crypto. Sessions: an HMAC-signed cookie, no server-side session table.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const COOKIE = 'hc_session', MAX_AGE_S = 30 * 24 * 3600;
export const normEmail = (e) => String(e || '').trim().toLowerCase();
const okEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;

export async function makeAccounts({ dir, secret, freeVideos = 1, adminEmails = [] }) {
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'accounts.json');
  const db = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : { users: {}, payments: {} };
  db.users ||= {}; db.payments ||= {};
  // the cookie key: from env, else one made once and kept next to the accounts
  let key = secret;
  if (!key) {
    const kf = join(dir, 'session.key');
    if (existsSync(kf)) key = (await readFile(kf, 'utf8')).trim();
    else { key = randomBytes(32).toString('hex'); await writeFile(kf, key, { mode: 0o600 }); }
  }
  const admins = new Set(adminEmails.map(normEmail).filter(Boolean));

  let saving = Promise.resolve();
  function save() { // serialised atomic writes: a crash never leaves half a file
    saving = saving.then(async () => {
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(db, null, 1));
      await rename(tmp, file);
    }).catch((e) => console.warn('could not save accounts:', e.message));
    return saving;
  }
  const byEmail = (email) => Object.values(db.users).find((u) => u.email === email) || null;
  const pub = (u) => u && { id: u.id, email: u.email, name: u.name || '', videos: u.videos, isAdmin: admins.has(u.email) };

  async function hash(password, salt = randomBytes(16).toString('hex')) {
    return { salt, hash: (await scrypt(String(password), salt, 32)).toString('hex') };
  }

  // ---- sessions (signed cookie: userId.expiry.hmac) ----
  const sign = (v) => createHmac('sha256', key).update(v).digest('base64url');
  function cookieFor(user, { secure }) {
    const v = `${user.id}.${Math.floor(Date.now() / 1000) + MAX_AGE_S}`;
    return `${COOKIE}=${v}.${sign(v)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${secure ? '; Secure' : ''}`;
  }
  const clearCookie = ({ secure }) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
  function userFrom(req) {
    const raw = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!raw) return null;
    const [id, exp, mac] = raw.split('.');
    if (!id || !exp || !mac) return null;
    const want = Buffer.from(sign(`${id}.${exp}`)), got = Buffer.from(mac);
    if (want.length !== got.length || !timingSafeEqual(want, got) || Number(exp) < Date.now() / 1000) return null;
    return db.users[id] || null;
  }

  return {
    pub, userFrom, cookieFor, clearCookie,
    isAdmin: (u) => !!u && admins.has(u.email),
    get: (id) => db.users[id] || null,

    async signup({ email, password, name }) {
      email = normEmail(email);
      if (!okEmail(email)) throw Object.assign(new Error('That email doesn’t look right.'), { status: 400 });
      if (String(password || '').length < 8) throw Object.assign(new Error('Use at least 8 characters for the password.'), { status: 400 });
      if (byEmail(email)) throw Object.assign(new Error('There’s already an account with that email. Sign in instead.'), { status: 409 });
      const id = randomBytes(9).toString('base64url');
      db.users[id] = { id, email, name: String(name || '').trim().slice(0, 60), ...(await hash(password)), videos: freeVideos, created: new Date().toISOString(), ledger: [{ t: new Date().toISOString(), videos: freeVideos, why: 'welcome' }] };
      await save();
      return db.users[id];
    },
    async login({ email, password }) {
      const u = byEmail(normEmail(email));
      const fail = () => Object.assign(new Error('Wrong email or password.'), { status: 401 });
      if (!u) { await hash(password); throw fail(); } // same time either way
      const { hash: h } = await hash(password, u.salt);
      const a = Buffer.from(h, 'hex'), b = Buffer.from(u.hash, 'hex');
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw fail();
      return u;
    },

    /** Change a balance (videos, + or −) with a reason. Refuses to go below zero. */
    async adjust(userId, videos, why) {
      const u = db.users[userId];
      if (!u) throw Object.assign(new Error('no such account'), { status: 404 });
      if (u.videos + videos < 0) throw Object.assign(new Error(`This needs ${-videos} video${videos === -1 ? '' : 's'} and you have ${u.videos}. Buy more to continue.`), { status: 402, code: 'balance' });
      u.videos += videos;
      (u.ledger ||= []).push({ t: new Date().toISOString(), videos, why });
      if (u.ledger.length > 500) u.ledger.splice(0, u.ledger.length - 500);
      await save();
      return u.videos;
    },

    /** Credit a paid pack once per payment id, whatever calls first (return page or webhook). → true if credited now. */
    async creditPayment(paymentId, { userId, videos, packId, amount, currency }) {
      if (!paymentId || db.payments[paymentId]?.credited) return false;
      if (!db.users[userId]) return false;
      db.payments[paymentId] = { userId, videos, packId, amount, currency, credited: new Date().toISOString() };
      await this.adjust(userId, videos, `bought ${packId} (${paymentId})`);
      return true;
    },
    payment: (id) => db.payments[id] || null,
    flush: () => saving,
  };
}
