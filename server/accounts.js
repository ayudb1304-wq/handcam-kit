// Accounts, sessions, plans and videos (Phase 5, 5c, 5d). Kept in memory (one server); saved to Supabase Postgres when
// `store` is given (server/supa.js: the source of truth, only changed accounts are written), and always mirrored to a
// JSON file under DATA_DIR. Without Supabase (local dev) the file is the store (DECISIONS §34, §38, §40).
// Passwords: scrypt from node:crypto. Sessions: an HMAC-signed cookie, no server-side session table.
// What an account may do is worked out by plans.js from what is stored here; the rules are in docs/PRICING-PLAN.md.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { entitlements, splitSpend, splitRefund, subscriptionState } from './plans.js';

const scrypt = promisify(scryptCb);
const COOKIE = 'hc_session', MAX_AGE_S = 30 * 24 * 3600;
export const normEmail = (e) => String(e || '').trim().toLowerCase();
const okEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;
const err = (message, status, code) => Object.assign(new Error(message), { status, code });
const plural = (n, w = 'video') => `${n} ${w}${n === 1 ? '' : 's'}`;

export async function makeAccounts({ dir, secret, pricing, adminEmails = [], now = () => new Date(), store = null, log = console }) {
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'accounts.json');
  const local = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : { users: {}, payments: {} };
  let db = local, imported = false;
  if (store) {
    const remote = await store.load();
    if (Object.keys(remote.users).length || !Object.keys(local.users || {}).length) db = remote;
    else imported = true; // first start with Supabase: bring the accounts that were in the file over
  }
  db.users ||= {}; db.payments ||= {}; db.refunds ||= {};
  for (const u of Object.values(db.users)) migrate(u);
  // the cookie key: from env, else one made once and kept next to the accounts
  let key = secret;
  if (!key) {
    const kf = join(dir, 'session.key');
    if (existsSync(kf)) key = (await readFile(kf, 'utf8')).trim();
    else { key = randomBytes(32).toString('hex'); await writeFile(kf, key, { mode: 0o600 }); }
  }
  const admins = new Set(adminEmails.map(normEmail).filter(Boolean));
  const keyBox = createHmac('sha256', key).update('handcam-byok-v1').digest(); // encrypts customers' own AI keys

  // what the database last got, per row: save() writes only rows that changed since
  const sent = new Map();
  const mark = () => {
    for (const u of Object.values(db.users)) sent.set(`u:${u.id}`, JSON.stringify(u));
    for (const [id, p] of Object.entries(db.payments)) sent.set(`p:${id}`, JSON.stringify(p));
    for (const [id, r] of Object.entries(db.refunds)) sent.set(`r:${id}`, JSON.stringify(r));
  };
  if (!imported) mark();
  let saving = Promise.resolve();
  function save() { // serialised: database first (changed rows only), then the atomic file mirror
    saving = saving.then(async () => {
      if (store) {
        const users = [], pays = [];
        for (const u of Object.values(db.users)) { const j = JSON.stringify(u); if (sent.get(`u:${u.id}`) !== j) { users.push(u); sent.set(`u:${u.id}`, j); } }
        for (const [id, x] of Object.entries(db.payments)) { const j = JSON.stringify(x); if (sent.get(`p:${id}`) !== j) { pays.push([id, x]); sent.set(`p:${id}`, j); } }
        for (const [id, x] of Object.entries(db.refunds)) { const j = JSON.stringify(x); if (sent.get(`r:${id}`) !== j) { pays.push([`refund:${id}`, x]); sent.set(`r:${id}`, j); } }
        try { await store.saveUsers(users); await store.savePayments(pays); }
        catch (e) { for (const u of users) sent.delete(`u:${u.id}`); for (const [id] of pays) sent.delete(id.startsWith('refund:') ? `r:${id.slice(7)}` : `p:${id}`); throw e; } // retried on the next save
      }
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(db, null, 1));
      await rename(tmp, file);
    }).catch((e) => log.warn('could not save accounts:', e.message));
    return saving;
  }
  if (imported) { await save(); log.log(`accounts: moved ${Object.keys(db.users).length} account(s) from ${file} to Supabase`); }
  const byEmail = (email) => Object.values(db.users).find((u) => u.email === email) || null;
  const must = (id) => db.users[id] || (() => { throw err('no such account', 404); })();
  const note = (u, entry) => {
    (u.ledger ||= []).push({ t: now().toISOString(), ...entry });
    if (u.ledger.length > 500) u.ledger.splice(0, u.ledger.length - 500);
  };
  const isAdmin = (u) => !!u && admins.has(u.email);
  const ent = (u, { admin = false } = {}) => entitlements(u, pricing, { now: now(), admin: admin || isAdmin(u) });

  /** What the browser may see of an account: plan, videos, features. Never the password hash or the AI key. */
  const pub = (u) => u && { id: u.id, email: u.email, name: u.name || '', isAdmin: isAdmin(u), ...ent(u), byok: u.byok ? { set: true, last4: u.byok.last4 } : { set: false } };

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

  /** Put plan videos back into this month, or (if that month is over or the plan has ended) into top-ups. */
  function giveBackMonth(u, n, cycle) {
    if (n <= 0) return;
    const e = ent(u);
    if (e.sub && e.videos.cycle === cycle && u.allowance?.cycle === cycle) u.allowance.used = Math.max(0, u.allowance.used - n);
    else u.topup = (u.topup || 0) + n;
  }

  return {
    pub, userFrom, cookieFor, clearCookie, isAdmin,
    get: (id) => db.users[id] || null,
    ent: (u, opts) => ent(u, opts),
    byEmail: (email) => byEmail(normEmail(email)),
    bySubscription: (subId) => Object.values(db.users).find((u) => u.sub?.id === subId) || null,
    lifetimeCount: () => Object.values(db.users).filter((u) => u.lifetime).length,

    async signup({ email, password, name }) {
      email = normEmail(email);
      if (!okEmail(email)) throw err('That email doesn’t look right.', 400);
      if (String(password || '').length < 8) throw err('Use at least 8 characters for the password.', 400);
      if (byEmail(email)) throw err('There’s already an account with that email. Sign in instead.', 409);
      const id = randomBytes(9).toString('base64url');
      const trial = pricing.trial?.videos ?? 0;
      db.users[id] = { id, email, name: String(name || '').trim().slice(0, 60), ...(await hash(password)), created: now().toISOString(), trial, topup: 0, sub: null, allowance: null, lifetime: null, hold: null, ledger: [] };
      note(db.users[id], { trial, why: 'welcome' });
      await save();
      return db.users[id];
    },
    /**
     * Someone Supabase Auth vouches for (Google, or a confirmed email). Their CineHand account by Supabase id, else the
     * account with that email (now linked to them), else a new Free account with the trial videos.
     */
    async fromAuth({ authId, email, name = '' }) {
      email = normEmail(email);
      if (!authId || !okEmail(email)) throw err('Sign-in didn’t give an email. Try again.', 400);
      let u = Object.values(db.users).find((x) => x.authId === authId) || byEmail(email);
      if (u) {
        if (u.authId && u.authId !== authId) throw err('That email belongs to a different sign-in. Use the one you signed up with.', 409);
        if (!u.authId || (name && !u.name)) { u.authId = authId; if (name && !u.name) u.name = String(name).slice(0, 60); note(u, { why: 'signed in with Supabase' }); await save(); }
        return { user: u, created: false };
      }
      const id = randomBytes(9).toString('base64url');
      const trial = pricing.trial?.videos ?? 0;
      db.users[id] = { id, authId, email, name: String(name || '').trim().slice(0, 60), created: now().toISOString(), trial, topup: 0, sub: null, allowance: null, lifetime: null, hold: null, ledger: [] };
      note(db.users[id], { trial, why: 'welcome' });
      await save();
      return { user: db.users[id], created: true };
    },

    async login({ email, password }) {
      const u = byEmail(normEmail(email));
      const fail = () => err('Wrong email or password.', 401);
      if (u && !u.hash) throw err('This account signs in with Google or with the email sign-in. Use those instead.', 401);
      if (!u) { await hash(password); throw fail(); } // same time either way
      const { hash: h } = await hash(password, u.salt);
      const a = Buffer.from(h, 'hex'), b = Buffer.from(u.hash, 'hex');
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw fail();
      return u;
    },

    /**
     * Take `need` videos for a job: plan videos first, then top-ups, then trial. Trial videos only make
     * `trialQuality` (480p). → { month, topup, trial, cycle } to keep on the job for refunds.
     */
    async spend(userId, need, { resolution, why = 'make video' } = {}) {
      const u = must(userId), e = ent(u);
      if (u.hold) throw err('Real AI videos are paused on this account while a payment dispute is open. Write to us if that’s a mistake.', 402, 'hold');
      if (e.videos.unlimited || need <= 0) return { month: 0, topup: 0, trial: 0, cycle: null };
      const from = splitSpend(e.videos, need);
      if (!from) {
        const why2 = e.sub?.status === 'on_hold' ? ' Your plan’s videos are paused until the payment goes through: update your card in Manage billing.' : '';
        throw err(`This needs ${plural(need)} and you have ${e.videos.total}.${why2} ${e.features.topups ? 'Buy more or choose fewer versions.' : 'Choose a plan to make more.'}`, 402, 'balance');
      }
      if (from.trial > 0 && resolution && resolution !== e.trialQuality) {
        throw err(`Your free videos are ${e.trialQuality}. Choose ${e.trialQuality}, or pick a plan for ${resolution}.`, 402, 'quality');
      }
      if (from.month) u.allowance = { cycle: e.videos.cycle, used: (u.allowance?.cycle === e.videos.cycle ? u.allowance.used : 0) + from.month };
      u.topup -= from.topup;
      u.trial -= from.trial;
      note(u, { videos: -need, from, why });
      await save();
      return { ...from, cycle: e.videos.cycle };
    },

    /** Give back `amount` videos a job took (free or failed versions). Mutates and returns the job's `from`. */
    async refund(userId, from, amount, why = 'refund') {
      const u = db.users[userId];
      if (!u || amount <= 0) return from;
      const back = splitRefund(from, amount);
      u.trial = (u.trial || 0) + back.trial;
      u.topup = (u.topup || 0) + back.topup;
      giveBackMonth(u, back.month, from.cycle);
      from.trial -= back.trial; from.topup -= back.topup; from.month -= back.month;
      note(u, { videos: back.trial + back.topup + back.month, back, why });
      await save();
      return from;
    },

    /** Founder's manual adjustment, in top-up videos (never below zero). */
    async addTopup(userId, videos, why) {
      const u = must(userId);
      if ((u.topup || 0) + videos < 0) throw err(`They have ${plural(u.topup || 0)}.`, 400);
      u.topup = (u.topup || 0) + videos;
      note(u, { topup: videos, why });
      await save();
      return u.topup;
    },

    /**
     * Store the subscription as Dodo reports it (already normalised by payments.js and confirmed with Dodo).
     * A new subscription id starts a new month today (its start date); the same id keeps its month, so an
     * upgrade keeps this month's used videos and adds the difference.
     */
    async syncSubscription(userId, sub) {
      const u = must(userId), prev = u.sub;
      const fresh = !prev || prev.id !== sub.id;
      // a second subscription that never started (a failed checkout) must not replace a live one
      if (fresh && prev && subscriptionState(prev, now()) && !subscriptionState(sub, now())) return u;
      const anchor = fresh ? (sub.startedAt || now().toISOString()) : prev.anchor;
      u.sub = { id: sub.id, customerId: sub.customerId || prev?.customerId || null, plan: sub.plan, interval: sub.interval, status: sub.status, anchor, paidThrough: sub.paidThrough || null, cancelAtPeriodEnd: !!sub.cancelAtPeriodEnd, pending: sub.pending || null, synced: now().toISOString() };
      if (fresh || prev.plan !== sub.plan || prev.status !== sub.status || prev.interval !== sub.interval) note(u, { plan: `${sub.plan}/${sub.interval}`, status: sub.status, why: fresh ? 'subscription' : 'subscription changed' });
      await save();
      return u;
    },

    /** Record a confirmed one-time payment (top-up or Lifetime) once per payment id. → true if applied now. */
    async recordPayment(paymentId, { kind, userId, videos = 0, itemId, amount, currency }) {
      if (!paymentId || db.payments[paymentId]?.credited) return false;
      const u = db.users[userId];
      if (!u) return false;
      db.payments[paymentId] = { userId, kind, videos, itemId, amount, currency, credited: now().toISOString() };
      if (kind === 'topup') { u.topup = (u.topup || 0) + videos; note(u, { topup: videos, why: `bought ${itemId} (${paymentId})` }); }
      if (kind === 'lifetime') { u.lifetime = { at: now().toISOString(), paymentId }; note(u, { why: `bought lifetime (${paymentId})` }); }
      await save();
      return true;
    },
    payment: (id) => db.payments[id] || null,

    /** A refund or a lost chargeback: take back the unspent part of what that payment gave. Once per refund id. */
    async reversePayment(paymentId, { refundId, fraction = 1 }) {
      const p = db.payments[paymentId], u = p && db.users[p.userId];
      if (!u || !refundId || db.refunds[refundId]) return false;
      db.refunds[refundId] = { paymentId, at: now().toISOString() };
      if (p.kind === 'topup') {
        const take = Math.min(u.topup || 0, Math.floor(p.videos * Math.min(1, Math.max(0, fraction))));
        u.topup -= take;
        note(u, { topup: -take, why: `refund ${refundId} of ${paymentId}` });
      }
      if (p.kind === 'lifetime' && fraction >= 1 && u.lifetime?.paymentId === paymentId) { u.lifetime = null; note(u, { why: `lifetime refunded (${refundId})` }); }
      await save();
      return true;
    },

    /** Pause real AI on an account while a chargeback is open (or lift it). */
    async setHold(userId, reason) {
      const u = must(userId);
      u.hold = reason ? { reason, at: now().toISOString() } : null;
      note(u, { why: reason ? `hold: ${reason}` : 'hold lifted' });
      await save();
    },

    // ---- the customer's own Higgsfield key (BYOK): encrypted at rest, never sent back to the browser ----
    async setByok(userId, { keyId, keySecret }) {
      const u = must(userId);
      keyId = String(keyId || '').trim(); keySecret = String(keySecret || '').trim();
      if (!/^[\w.-]{6,200}$/.test(keyId) || !/^[\w.+/=-]{6,400}$/.test(keySecret)) throw err('That doesn’t look like a Higgsfield API key ID and secret (console.higgsfield.ai → API keys).', 400);
      const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', keyBox, iv);
      const data = Buffer.concat([c.update(JSON.stringify({ keyId, keySecret }), 'utf8'), c.final()]);
      u.byok = { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64'), last4: keySecret.slice(-4), at: now().toISOString() };
      note(u, { why: 'own AI key saved' });
      await save();
    },
    async clearByok(userId) {
      const u = must(userId);
      u.byok = null;
      note(u, { why: 'own AI key removed' });
      await save();
    },
    /** The key as env vars for the Higgsfield adapter, or null (none saved, or the server's secret changed). */
    byokEnv(userId) {
      const b = db.users[userId]?.byok;
      if (!b) return null;
      try {
        const d = createDecipheriv('aes-256-gcm', keyBox, Buffer.from(b.iv, 'base64'));
        d.setAuthTag(Buffer.from(b.tag, 'base64'));
        const { keyId, keySecret } = JSON.parse(Buffer.concat([d.update(Buffer.from(b.data, 'base64')), d.final()]).toString('utf8'));
        return { HF_API_KEY_ID: keyId, HF_API_KEY_SECRET: keySecret };
      } catch { return null; }
    },
    flush: () => saving,
  };
}

/** Accounts from before plans (Phase 5) had one `videos` balance: it becomes top-ups, which never expire, as promised. */
function migrate(u) {
  if ('videos' in u) { u.topup = (u.topup || 0) + (u.videos || 0); delete u.videos; }
  u.topup ??= 0; u.trial ??= 0; u.sub ??= null; u.allowance ??= null; u.lifetime ??= null; u.hold ??= null;
}
