// HTTP routes for Make video. Who may use them (Phase 5, 5c):
//  - the founder on the laptop running CineHand (isLocal) or an ADMIN_EMAILS account: everything, real AI, sees real
//    AI cost in dollars;
//  - a signed-in account: their own jobs only; pays in videos from its plan, top-ups or trial (docs/PRICING-PLAN.md);
//    never sees our AI cost; real AI only when the server allows it for customers (REAL_AI=on), else Practice;
//    or, on a paid plan, on their own Higgsfield key (byok), which uses no videos and spends none of our money.
// Trial videos are watermarked; a free (under the move-match line) version plays as a watermarked copy, with no clean
// file and no download. Everyone else signs in. What one account may ask of our AI key in a day is capped (MAKE_LIMITS).
import express from 'express';
import { existsSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { checkLabTake, isLocal } from '../lab.js';
import { UPLOADS, REF_UPLOADS } from './jobs.js';
import { FREE_BELOW_MATCH, MAX_VERSIONS } from './recipe.js';
import { unitsPerVersion } from '../billing.js';
import { isPng, cleanQuad } from './logolock.js';
import { rateLimit } from '../limits.js';

const MEDIA = /^(ref-look\.jpg|ref-subject\.jpg|ref-logo\.png|start-\d+\.(png|jpg)|video-\d+\.mp4|wm-\d+\.mp4|reference\.mp4|first-frame\.png|lock-\d+\.mp4|lockwm-\d+\.mp4|frame-\d+\.jpg|logo\.png)$/;

/**
 * What the browser may see of a job: no provider URLs, no internal request ids; our AI cost only for the founder.
 * Customers get the watermarked copy of free versions (to watch, not to keep) and of trial videos; own-key jobs are
 * theirs in full.
 */
export function publicJob(job, recipe, { admin = true } = {}) {
  const { urls, log, charge, kept, ...rest } = job;
  const full = admin || job.byok;
  const out = {
    ...rest,
    startImages: job.startImages.map(({ n, status, file }) => ({ n, status, file })),
    candidates: job.candidates.map(({ n, status, file, verdict, match, error, score, free }) => ({
      n, status, verdict, match, error, free,
      // customers watch a free (under the line) version and a trial video as the watermarked copy, never the clean file
      file: !file ? file : (free || job.watermark) && !full ? `wm-${n}.mp4` : file,
      preview: !!(file && free && !full),
      score: score && { timing_offset_s: score.timing_offset_s, turn_corr: score.turn_corr, walk_ratio: score.walk_ratio ?? null },
    })),
    log: log.slice(-12),
    recipe: recipe && { id: recipe.id, label: recipe.label, status: recipe.status, ...(admin && { cost: recipe.cost }) },
    charge: charge && { unit: charge.unit, reserved: charge.reserved, refunded: charge.refunded },
  };
  if (!admin && out.billing) { const { apiUsd, ...b } = out.billing; out.billing = b; }
  return out;
}

/**
 * What one account may ask of OUR AI key (DECISIONS §49). Videos are already paid for in videos; these caps stop the
 * parts that cost us money and the customer nothing: first frames (never charged) and versions that come back free
 * (under the move-match line) or fail. `free` is an account with no plan; `paid` has a plan or Lifetime.
 */
export const MAKE_LIMITS = Object.freeze({ jobsPerHour: 30, startsPerJob: 4, startsPerDay: { free: 6, paid: 60 }, versionsPerDay: { free: 6, paid: 60 } });

/** Logo locks as the browser may see them: a customer on a trial gets the watermarked copy. */
export function publicLocks(locks, job, { full = true } = {}) {
  const out = {};
  for (const [n, l] of Object.entries(locks || {})) {
    if (!/^\d+$/.test(n)) continue;
    const { status, quad, cover, locked, motion, coverUsed, oldLogo, error } = l;
    out[n] = { status, quad, cover, locked, motion, coverUsed, oldLogo, error, file: l.file && (job.watermark && !full ? `lockwm-${n}.mp4` : l.file) };
  }
  return out;
}

export function makeRoutes({ jobs, recipes, ready, accounts, pricing, realAiForCustomers = false, chargePractice = false, watermark, logolock = null, refsForCustomers = false, limits = MAKE_LIMITS, keep = null }) {
  const r = express.Router();
  const DAY = 24 * 3600_000;
  const jobLimit = rateLimit({ perHour: limits.jobsPerHour });
  const dayLimit = (per) => ({ free: rateLimit({ max: per.free, windowMs: DAY }), paid: rateLimit({ max: per.paid, windowMs: DAY }) });
  const startLimit = dayLimit(limits.startsPerDay), versionLimit = dayLimit(limits.versionsPerDay);
  /** Is this step on our AI key for a customer? (not Practice, not their own key, not the founder) */
  const onOurKey = (w, job) => !w.admin && !job.byok && job.provider !== 'mock';
  /** Count `n` more against the account's day; answers 429 and → false when that's over the cap. */
  function within(limit, w, job, n, res, what) {
    if (!onOurKey(w, job) || limit[w.ent?.features.topups ? 'paid' : 'free'](job.userId, n)) return true;
    res.status(429).json({ error: `That’s the most ${what} one account can make in a day. Try again tomorrow.`, code: 'limit' });
    return false;
  }
  const who = (req) => {
    const local = isLocal(req), user = accounts?.userFrom(req) || null;
    const admin = local || accounts?.isAdmin(user) || false;
    return { local, user, admin, ent: accounts?.ent(user, { admin }) || null };
  };
  /** Can this person run this recipe on our key? (Practice always; real AI for the founder, or customers when REAL_AI is on.) */
  const allowed = (w, recipe) => !!recipe && ready(recipe.provider) && (recipe.provider === 'mock' || w.admin || realAiForCustomers);
  /** …or on their own Higgsfield key? (a paid plan, a saved key, a Higgsfield recipe) */
  const ownKey = (w, recipe) => !!recipe && recipe.provider === 'higgsfield' && !w.admin && !!w.ent?.features.byok && !!w.user?.byok;
  // Whose videos this person may see: their own account's, and on the laptop running CineHand the ones made there with
  // no account. Nobody, the founder included, gets another account's videos through the app (DECISIONS §55).
  const mine = (w) => [...(w.local ? [null] : []), ...(w.user ? [w.user.id] : [])];
  const owns = (w, job) => mine(w).includes(job.userId ?? null);
  const unitFor = (w, byok) => (job) => (w.user && !w.admin && !byok ? unitsPerVersion(pricing, job, { chargePractice }) : 0);
  const whyNot = (w, x) => !ready(x.provider) && !ownKey(w, x) ? 'not set up on this server' : 'real AI video is switched off for this test: try Practice';

  r.use((req, res, next) => {
    const w = who(req);
    if (!w.local && !w.user && req.path !== '/config') return res.status(401).json({ error: 'Sign in to make videos.', code: 'signin' });
    req.who = w;
    next();
  });

  /** Recipes this person can use, prices in videos, their balance. The prompts stay on the server. */
  r.get('/config', (req, res) => {
    const w = req.who;
    res.json({
      freeBelowMatch: FREE_BELOW_MATCH, maxVersions: MAX_VERSIONS, maxStarts: limits.startsPerJob, admin: w.admin, signedIn: !!(w.user || w.local), refs: w.admin || refsForCustomers,
      account: accounts?.pub(w.user) || null,
      ent: w.ent,
      pricing: pricing && { qualityUnits: pricing.qualityUnits, longTakeSeconds: pricing.longTakeSeconds, currency: pricing.currency, trial: pricing.trial || null },
      chargePractice: !!chargePractice,
      recipes: Object.values(recipes).map((x) => ({
        id: x.id, label: x.label, status: x.status, provider: x.provider, candidates: x.candidates, extraTries: x.extraTries ?? 0,
        minDurationS: x.minDurationS ?? 4, maxDurationS: x.maxDurationS ?? 15,
        qualities: x.qualities ? (w.admin ? x.qualities : Object.fromEntries(Object.keys(x.qualities).map((k) => [k, null]))) : null,
        ...(w.admin && { cost: x.cost || null }),
        ready: allowed(w, x) || ownKey(w, x),
        ourKey: allowed(w, x), ownKey: ownKey(w, x),
        why: allowed(w, x) || ownKey(w, x) ? null : whyNot(w, x),
      })),
    });
  });

  /**
   * The look of a set (DECISIONS §50): a grey wide view of the blockout + words → one photoreal picture of the whole
   * place, sent straight back. The browser keeps it with the set and sends it along with every video made there.
   * Costs us one picture and the customer nothing, so it counts as a first frame in the day's cap.
   */
  const pictureOf = (x, magic) => { // { data: base64 } of a PNG or JPEG, at most ~3 MB → Buffer | null
    if (!x || typeof x.data !== 'string' || x.data.length > 4_200_000) return null;
    const buf = Buffer.from(x.data, 'base64');
    return magic.some((m) => buf.subarray(0, m.length).equals(m)) ? buf : null;
  };
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]), JPG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
  r.post('/look', async (req, res) => {
    const w = req.who, recipe = recipes[req.body?.recipeId];
    if (!(w.admin || refsForCustomers)) return res.status(403).json({ error: 'The look of a set isn’t open yet.' });
    if (!recipe) return res.status(400).json({ error: 'Choose a video model first.' });
    const byok = ownKey(w, recipe) && (req.body?.byok === true || !allowed(w, recipe));
    if (!byok && !allowed(w, recipe)) return res.status(400).json({ error: `${recipe.label}: ${whyNot(w, recipe)}.` });
    const wide = pictureOf(req.body?.wide, [PNG_MAGIC]), subject = req.body?.subject ? pictureOf(req.body.subject, [JPG_MAGIC]) : null;
    if (!wide || (req.body?.subject && !subject)) return res.status(400).json({ error: 'That picture can’t be used.' });
    if (!within(startLimit, w, { provider: recipe.provider, byok, userId: w.user?.id }, 1, res, 'first frames')) return;
    try {
      const { file, done } = await jobs.look({ recipeId: recipe.id, words: req.body?.look, aspect: req.body?.aspect === '9:16' ? '9:16' : '16:9', wide, subject, byok, userId: w.user?.id || null });
      res.sendFile(file, () => done());
    } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
  });

  r.get('/', async (req, res) => {
    const list = (await jobs.list({ owners: mine(req.who) })).filter((j) => owns(req.who, j) && j.status !== 'canceled');
    res.json({ jobs: await Promise.all(list.map((j) => withLocks(j, req.who))) });
  });

  r.post('/', async (req, res) => {
    const { take, scene, look, recipeId, demo, quality, versions } = req.body || {};
    const refs = req.body?.refs === true && (req.who.admin || refsForCustomers); // product photo + logo to the AI: founder only until tested
    const errors = checkLabTake({ take: { ...take, label: undefined }, scene });
    if (errors.length) return res.status(400).json({ error: errors.slice(0, 2).join('; ') });
    const w = req.who, recipe = recipes[recipeId];
    if (!w.admin && !jobLimit(w.user.id)) return res.status(429).json({ error: 'That’s a lot of videos for one hour. Try again a bit later.', code: 'limit' });
    // own key: when asked for, or when it's the only way this person can run this recipe
    const byok = !!recipe && ownKey(w, recipe) && (req.body?.byok === true || (req.body?.byok == null && !allowed(w, recipe)));
    if (req.body?.byok === true && recipe && !byok) return res.status(403).json(!w.ent?.features.byok ? { error: 'Using your own AI key comes with a paid plan.', code: 'plan' } : { error: 'Save your Higgsfield key in your account first.', code: 'byok' });
    if (recipe && !byok && !allowed(w, recipe)) return res.status(400).json({ error: `${recipe.label}: ${whyNot(w, recipe) === 'not set up on this server' ? 'isn’t set up on this server yet' : 'real AI video is switched off for this test. Try Practice.'}` });
    try {
      const job = await jobs.create({
        take, scene, look, recipeId, demo, quality, versions, userId: w.user?.id || null, unitFor: unitFor(w, byok), priority: w.ent?.features.priority ?? 0, byok, refs,
        check: (j) => { const no = canAfford(w, j, j.versions ?? 1); if (no) throw Object.assign(new Error(no.error), { status: 402, code: no.code }); }, // before anything is rendered or uploaded
      });
      res.json({ job: publicJob(job, recipe, req.who), uploads: Object.keys(UPLOADS), ...(refs && { refUploads: Object.keys(REF_UPLOADS) }) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message, code: e.code }); }
  });

  // ---- steps on one job: only its owner (or the founder) ----
  r.param('id', async (req, res, next, id) => {
    const job = await jobs.load(id);
    if (!job || !owns(req.who, job)) return res.status(404).json({ error: 'no such job' });
    await keep?.restore(job); // a video whose folder was cleared comes back from the archive when it is opened
    req.job = job;
    next();
  });

  r.put('/:id/files/:name', express.raw({ type: '*/*', limit: '200mb' }), async (req, res) => {
    const job = req.job;
    if (job.status !== 'uploading') return res.status(404).json({ error: 'no such job waiting for files' });
    if (!(req.params.name in UPLOADS || (job.refs && req.params.name in REF_UPLOADS)) || !req.body?.length) return res.status(400).json({ error: 'unexpected file' });
    await writeFile(jobs.path(job.id, req.params.name), req.body);
    res.json({ ok: true });
  });

  /** Would this account have enough videos, and the right ones, for n versions? → null, or the 402 answer to send. */
  function canAfford(w, job, n) {
    if (!job.charge || !w.ent) return null;
    const need = n * job.charge.unit, v = w.ent.videos;
    if (w.ent.hold) return { error: 'Real AI videos are paused on this account while a payment dispute is open.', code: 'hold' };
    if (v.total < need) return { error: `This needs ${need} video${need === 1 ? '' : 's'} and you have ${v.total}.`, code: 'balance', need, have: v.total };
    if (v.left + v.topup < need && job.resolution && job.resolution !== w.ent.trialQuality) return { error: `Your free videos are ${w.ent.trialQuality}. Choose ${w.ent.trialQuality}, or pick a plan for ${job.resolution}.`, code: 'quality' };
    return null;
  }

  /** Take the videos this step will make out of the balance first; what isn't owed comes back when it's checked. */
  const reserving = new Set();
  async function reserve(job, versions, res) {
    if (!job.charge) return true;
    if (reserving.has(job.id)) { res.status(409).json({ error: 'Already starting.' }); return false; }
    reserving.add(job.id);
    try {
      const need = versions * job.charge.unit;
      const from = await accounts.spend(job.userId, need, { resolution: job.resolution, why: `make video ${job.id} (${versions} × ${job.charge.unit})` });
      const had = job.charge.from || { month: 0, topup: 0, trial: 0, cycle: null };
      job.charge.from = { month: had.month + from.month, topup: had.topup + from.topup, trial: had.trial + from.trial, cycle: from.cycle || had.cycle };
      job.charge.reserved += need;
      if (from.trial > 0) job.watermark = true; // paid partly with free trial videos: the whole job is watermarked
      await jobs.save(job);
      return true;
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, code: e.code });
      return false;
    } finally { reserving.delete(job.id); }
  }

  /** The job for the browser, with its logo locks (kept in their own file, see logolock.js). */
  async function withLocks(job, w) {
    const out = publicJob(job, recipes[job.recipeId], w);
    if (keep) { out.expiresAt = keep.expiry(job); out.working = keep.working(job); } // when it is deleted by itself; can another version still be made
    if (logolock) { out.locks = publicLocks(await logolock.read(job.id), job, { full: w.admin || job.byok }); out.hasLogo = logolock.hasLogo(job); }
    return out;
  }
  const step = (fn) => async (req, res) => {
    try {
      const job = await fn(req, res);
      if (res.headersSent) return;
      if (!job) return res.status(404).json({ error: 'no such job' });
      res.json({ job: await withLocks(job, req.who), account: accounts?.pub(req.who.user && accounts.get(req.who.user.id)) || null });
    } catch (e) { if (!res.headersSent) res.status(e.status || 500).json({ error: e.message }); }
  };
  // a first frame costs us money and the customer nothing: capped per job and per account per day
  r.post('/:id/start', step((req, res) => {
    if (req.job.status === 'uploading' && !within(startLimit, req.who, req.job, 1, res, 'first frames')) return null;
    return jobs.start(req.job.id);
  }));
  r.post('/:id/redo-start', step((req, res) => {
    if (req.job.status === 'needs_approval' && onOurKey(req.who, req.job)) {
      if (req.job.startImages.length >= limits.startsPerJob) { res.status(429).json({ error: `That’s ${limits.startsPerJob} first frames for this video. Make the video from one of them, or start a new video.`, code: 'limit' }); return null; }
      if (!within(startLimit, req.who, req.job, 1, res, 'first frames')) return null;
    }
    return jobs.redoStart(req.job.id, req.body?.look);
  }));
  /** Delete a video for good: its files, its record, everything. Only when nothing is being made. */
  r.delete('/:id', async (req, res) => {
    if (['preparing', 'start_image', 'making', 'checking'].includes(req.job.status)) return res.status(409).json({ error: 'This video is still being made. Delete it when it’s finished.' });
    if (keep) await keep.remove(req.job); else return res.status(503).json({ error: 'Deleting isn’t set up on this server.' });
    jobs.forget(req.job.id);
    res.json({ ok: true });
  });
  r.post('/:id/cancel', step((req) => jobs.cancel(req.job.id))); // only while the first frame waits for an OK
  r.post('/:id/approve', step(async (req, res) => {
    if (req.job.status !== 'needs_approval') return req.job;
    const ask = Number(req.body?.versions);
    if (Number.isInteger(ask) && ask >= 1 && ask <= MAX_VERSIONS && ask !== req.job.versions) { req.job.versions = ask; await jobs.save(req.job); } // changed on the approval card
    const count = req.job.versions ?? recipes[req.job.recipeId]?.candidates ?? 1;
    const no = canAfford(req.who, req.job, count); // before the day's cap counts anything
    if (no) { res.status(402).json(no); return null; }
    if (!within(versionLimit, req.who, req.job, count, res, 'videos')) return null;
    if (!(await reserve(req.job, count, res))) return null;
    return jobs.approve(req.job.id, Number(req.body?.n));
  }));
  r.post('/:id/more', step(async (req, res) => {
    if (req.job.status !== 'done') return req.job;
    const no = canAfford(req.who, req.job, 1);
    if (no) { res.status(402).json(no); return null; }
    if (!within(versionLimit, req.who, req.job, 1, res, 'videos')) return null;
    if (!(await reserve(req.job, 1, res))) return null;
    return jobs.more(req.job.id);
  }));
  r.get('/:id', step((req) => req.job));

  // ---- logo lock: the brand's exact logo on the product, in every frame (server/logolock.py) ----
  /** The version to lock: it must have a video this person may keep (not a free, watch-only version). */
  const lockable = (req, res) => {
    const n = Number(req.body?.n), c = req.job.candidates.find((x) => x.n === n);
    if (!c?.file) { res.status(404).json({ error: 'That version isn’t ready.' }); return null; }
    if (c.free && !(req.who.admin || req.job.byok)) { res.status(403).json({ error: 'This version was free (under the move-match line): it’s to watch, not to keep.' }); return null; }
    return c;
  };
  r.put('/:id/logo', express.raw({ type: '*/*', limit: '12mb' }), async (req, res) => {
    if (!logolock) return res.status(503).json({ error: 'Logo lock isn’t set up on this server.' });
    if (!isPng(req.body)) return res.status(400).json({ error: 'The logo must be a PNG or SVG file.' });
    await logolock.saveLogo(req.job, req.body);
    res.json({ job: await withLocks(req.job, req.who) });
  });
  r.post('/:id/lock-find', async (req, res) => {
    if (!logolock?.hasLogo(req.job)) return res.status(400).json({ error: 'Add your logo first.' });
    const c = lockable(req, res);
    if (c) res.json(await logolock.find(req.job, c.file));
  });
  r.post('/:id/lock', step(async (req, res) => {
    if (!logolock?.hasLogo(req.job)) { res.status(400).json({ error: 'Add your logo first.' }); return null; }
    const c = lockable(req, res);
    if (!c) return null;
    const quad = cleanQuad(req.body?.quad);
    if (!quad) { res.status(400).json({ error: 'Place the logo on the product first (four corners).' }); return null; }
    const cover = ['auto', 'on', 'off'].includes(req.body?.cover) ? req.body.cover : 'auto';
    await logolock.start(req.job, c.n, c.file, quad, cover);
    return req.job;
  }));

  /** The watermarked copy of a video, made once: two requests for it at the same time share one ffmpeg run. */
  const marking = new Map();
  function marked(src, out) {
    if (existsSync(out)) return Promise.resolve(out);
    if (!marking.has(out)) {
      const tmp = out.replace(/\.mp4$/, '.part.mp4'); // a half-written file is never served
      marking.set(out, watermark(src, tmp).then(() => rename(tmp, out)).then(() => out).finally(() => marking.delete(out)));
    }
    return marking.get(out);
  }

  r.get('/:id/media/:file', async (req, res) => {
    const job = req.job, name = req.params.file;
    if (!MEDIA.test(name)) return res.status(404).end();
    // a customer never gets the clean file of a free version or of a trial video: both play as the watermarked copy
    const full = req.who.admin || job.byok;
    const n = Number(name.match(/^video-(\d+)\.mp4$/)?.[1]);
    if (n && !full && job.candidates.find((c) => c.n === n)?.free) return res.status(403).json({ error: 'This version was free (under the move-match line): it’s to watch, not to keep.' });
    if (n && !full && job.watermark) return res.status(403).json({ error: 'Free trial videos come with a watermark.', code: 'plan' });
    const wn = Number(name.match(/^wm-(\d+)\.mp4$/)?.[1]);
    if (wn) {
      const c = job.candidates.find((x) => x.n === wn);
      if (!c?.file || !watermark) return res.status(404).end();
      try { return res.sendFile(await marked(jobs.path(job.id, c.file), jobs.path(job.id, name))); }
      catch (e) { console.warn(e.message); return res.status(503).json({ error: 'The video isn’t ready yet. Try again in a moment.' }); }
    }
    // logo lock: the first frame (placing the logo), the locked video (trial: its watermarked copy), the logo itself
    const fr = Number(name.match(/^frame-(\d+)\.jpg$/)?.[1]);
    if (fr) {
      const c = job.candidates.find((x) => x.n === fr);
      if (!c?.file || !logolock) return res.status(404).end();
      try { return res.sendFile(await logolock.firstFrame(job, fr, c.file)); } catch { return res.status(500).end(); }
    }
    const ln = Number(name.match(/^lock-(\d+)\.mp4$/)?.[1]);
    if (ln && !full && (job.watermark || job.candidates.find((c) => c.n === ln)?.free)) return res.status(403).json({ error: 'Free trial videos come with a watermark.', code: 'plan' });
    const lw = Number(name.match(/^lockwm-(\d+)\.mp4$/)?.[1]);
    if (lw) {
      const src = jobs.path(job.id, `lock-${lw}.mp4`), out = jobs.path(job.id, name);
      if (!existsSync(src) || !watermark) return res.status(404).end();
      try { return res.sendFile(await marked(src, out)); }
      catch (e) { console.warn(e.message); return res.status(503).json({ error: 'The video isn’t ready yet. Try again in a moment.' }); }
    }
    const file = jobs.path(job.id, name);
    if (!existsSync(file)) return res.status(404).end();
    res.sendFile(file); // supports Range requests, which Safari needs to play video
  });
  return r;
}
