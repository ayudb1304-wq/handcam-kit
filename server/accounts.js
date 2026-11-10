// Accounts, sessions, plans and videos (Phase 5, 5c, 5d). Kept in memory (one server); saved to Supabase Postgres when
// `store` is given (server/supa.js: the source of truth, only changed accounts are written), and always mirrored to a
// JSON file under DATA_DIR. Without Supabase (local dev) the file is the store (DECISIONS §34, §38, §40).
// Sign-in is Google only, through Supabase Auth (DECISIONS §49): no passwords here. Sessions: an HMAC-signed cookie,
// no server-side session table. The free trial is given once per device and per network (trialTaken below).
// What an account may do is worked out by plans.js from what is stored here; the rules are in docs/PRICING-PLAN.md.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';
import { entitlements, splitSpend, splitRefund, subscriptionState } from './plans.js';

const COOKIE = 'hc_session', MAX_AGE_S = 30 * 24 * 3600;
const DEVICE = 'hc_dev', DEVICE_AGE_S = 2 * 365 * 24 * 3600;
export const normEmail = (e) => String(e || '').trim().toLowerCase();
const okEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;
const err = (message, status, code) => Object.assign(new Error(message), { status, code });
const plural = (n, w = 'video') => `${n} ${w}${n === 1 ? '' : 's'}`;

export async function makeAccounts({ dir, secret, pricing, adminEmails = [], now = () => new Date(), store = null, log = console, trialPerNetwork = 1, trialNetworkDays = 30 }) {
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'accounts.json');
  const local = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : { users: {}, payments: {} };
  let db = local, imported = false;
  if (store) {
    const remote = await store.load();
    if (Object.keys(remote.users).length || !Object.keys(local.users || {}).length) db = remote;
    else imported = true; // first start with Supabase: bring the accounts that were in the file over
  }
  db.users ||= {}; db.payments ||= {}; db.refunds ||= {}; db.gone ||= {};
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
    for (const [id, g] of Object.entries(db.gone)) sent.set(`g:${id}`, JSON.stringify(g));
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
        for (const [id, x] of Object.entries(db.gone)) { const j = JSON.stringify(x); if (sent.get(`g:${id}`) !== j) { pays.push([`gone:${id}`, x]); sent.set(`g:${id}`, j); } }
        try { await store.saveUsers(users); await store.savePayments(pays); }
        catch (e) { for (const u of users) sent.delete(`u:${u.id}`); for (const [id] of pays) sent.delete(id.startsWith('refund:') ? `r:${id.slice(7)}` : id.startsWith('gone:') ? `g:${id.slice(5)}` : `p:${id}`); throw e; } // retried on the next save
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

  /** What the browser may see of an account: plan, videos, features. Never the AI key. */
  const pub = (u) => u && { id: u.id, email: u.email, name: u.name || '', isAdmin: isAdmin(u), ...ent(u), byok: u.byok ? { set: true, last4: u.byok.last4 } : { set: false } };

  // ---- sessions (signed cookie: userId.expiry.hmac) ----
  const sign = (v) => createHmac('sha256', key).update(v).digest('base64url');
  function cookieFor(user, { secure }) {
    const v = `${user.id}.${Math.floor(Date.now() / 1000) + MAX_AGE_S}`;
    return `${COOKIE}=${v}.${sign(v)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${secure ? '; Secure' : ''}`;
  }
  const clearCookie = ({ secure }) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
  const cookie = (req, name) => (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
  const signed = (v, mac) => { const want = Buffer.from(sign(v)), got = Buffer.from(String(mac || '')); return want.length === got.length && timingSafeEqual(want, got); };
  function userFrom(req) {
    const [id, exp, mac] = (cookie(req, COOKIE) || '').split('.');
    if (!id || !exp || !mac || !signed(`${id}.${exp}`, mac) || Number(exp) < Date.now() / 1000) return null;
    return db.users[id] || null;
  }

  // ---- one free trial per device and per network (DECISIONS §49) ----
  // The device is a signed, long-lived cookie given at the first sign-in on a browser. The network is the visitor's
  // address (limits.js networkOf), kept only as a keyed hash. Both are stored on the account as `origin`.
  /** The browser's device id from its cookie, or null (none yet, or tampered with). */
  function deviceFrom(req) {
    const [id, mac] = (cookie(req, DEVICE) || '').split('.');
    return id && signed(`dev.${id}`, mac) ? id : null;
  }
  const newDevice = () => randomBytes(12).toString('base64url');
  const deviceCookie = (id, { secure }) => `${DEVICE}=${id}.${sign(`dev.${id}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DEVICE_AGE_S}${secure ? '; Secure' : ''}`;
  const netKey = (network) => (network ? createHmac('sha256', key).update(`net:${network}`).digest('base64url').slice(0, 22) : null);
  const mailKey = (email) => createHmac('sha256', key).update(`mail:${email}`).digest('base64url').slice(0, 22);
  /**
   * Did another account already get the free videos on this device (ever) or this network (lately)? Accounts that were
   * deleted still count (db.gone keeps their device, network and a keyed hash of the email, nothing else), or deleting
   * an account and signing up again would be a way to get the trial for ever.
   */
  function trialTaken(device, net, email = '') {
    const since = now().getTime() - trialNetworkDays * 86400_000;
    const got = [...Object.values(db.users).filter((u) => u.origin?.trial).map((u) => u.origin), ...Object.values(db.gone)];
    if (device && got.some((o) => o.device === device)) return true;
    if (email && Object.values(db.gone).some((g) => g.mail === mailKey(email))) return true;
    return !!net && got.filter((o) => o.net === net && new Date(o.at).getTime() > since).length >= trialPerNetwork;
  }

  /** Put plan videos back into this month, or (if that month is over or the plan has ended) into top-ups. */
  function giveBackMonth(u, n, cycle) {
    if (n <= 0) return;
    const e = ent(u);
    if (e.sub && e.videos.cycle === cycle && u.allowance?.cycle === cycle) u.allowance.used = Math.max(0, u.allowance.used - n);
    else u.topup = (u.topup || 0) + n;
  }

  return {
    pub, userFrom, cookieFor, clearCookie, isAdmin, deviceFrom, newDevice, deviceCookie,
    get: (id) => db.users[id] || null,
    ent: (u, opts) => ent(u, opts),
    byEmail: (email) => byEmail(normEmail(email)),
    bySubscription: (subId) => Object.values(db.users).find((u) => u.sub?.id === subId) || null,
    lifetimeCount: () => Object.values(db.users).filter((u) => u.lifetime).length,

    /**
     * Someone Supabase Auth vouches for (Google). Their CineHand account by Supabase id, else the account with that
     * email (now linked to them), else a new Free account. A new account gets the trial videos unless this device or
     * network already had them on another account. → { user, created, trial } (trial: false when they were withheld)
     */
    async fromAuth({ authId, email, name = '', device = null, network = null }) {
      email = normEmail(email);
      if (!authId || !okEmail(email)) throw err('Sign-in didn’t give an email. Try again.', 400);
      const net = netKey(network);
      let u = Object.values(db.users).find((x) => x.authId === authId) || byEmail(email);
      if (u) {
        if (u.authId && u.authId !== authId) throw err('That email belongs to a different sign-in. Use the one you signed up with.', 409);
        const link = !u.authId || (name && !u.name), seen = !u.origin && (device || net);
        if (link) { u.authId = authId; if (name && !u.name) u.name = String(name).slice(0, 60); note(u, { why: 'signed in with Google' }); }
        // an account from before origins were kept: it had its trial, so its device and network count from now on
        if (seen) u.origin = { device, net, at: now().toISOString(), trial: true };
        if (link || seen) await save();
        return { user: u, created: false, trial: true };
      }
      const id = randomBytes(9).toString('base64url');
      const give = admins.has(email) || !trialTaken(device, net, email);
      const trial = give ? pricing.trial?.videos ?? 0 : 0;
      db.users[id] = { id, authId, email, name: String(name || '').trim().slice(0, 60), created: now().toISOString(), trial, topup: 0, sub: null, allowance: null, lifetime: null, hold: null, ledger: [], origin: { device, net, at: now().toISOString(), trial: give } };
      note(db.users[id], { trial, why: give ? 'welcome' : 'welcome (free videos already used on this device or network)' });
      await save();
      return { user: db.users[id], created: true, trial: give };
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
    /** What this account bought, for its data export: [{ id, kind, itemId, amount, currency, at }]. */
    paymentsOf: (userId) => Object.entries(db.payments).filter(([, p]) => p.userId === userId).map(([id, p]) => ({ id, kind: p.kind, item: p.itemId, amount: p.amount, currency: p.currency, at: p.credited })),
    /**
     * Delete an account: its row here and in the database. Payment records stay (tax and accounting rules need them);
     * they hold no more than the account's id, what was bought and when.
     */
    async remove(userId) {
      const u = db.users[userId];
      if (!u) return false;
      db.gone[userId] = { device: u.origin?.device || null, net: u.origin?.net || null, mail: mailKey(u.email), at: now().toISOString() }; // so the trial isn't given twice
      delete db.users[userId];
      sent.delete(`u:${userId}`);
      if (store) await store.removeUser(userId);
      await save();
      return true;
    },

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
  delete u.hash; delete u.salt; // passwords are gone: sign-in is Google only
  u.topup ??= 0; u.trial ??= 0; u.sub ??= null; u.allowance ??= null; u.lifetime ??= null; u.hold ??= null;
}
