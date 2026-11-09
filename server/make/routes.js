// HTTP routes for Make video. Who may use them (Phase 5, 5c):
//  - the founder on the laptop running CineHand (isLocal) or an ADMIN_EMAILS account: everything, real AI, sees real
//    AI cost in dollars;
//  - a signed-in account: their own jobs only; pays in videos from its plan, top-ups or trial (docs/PRICING-PLAN.md);
//    never sees our AI cost; real AI only when the server allows it for customers (REAL_AI=on), else Practice;
//    or, on a paid plan, on their own Higgsfield key (byok), which uses no videos and spends none of our money.
// Trial videos are watermarked; free (under the move-match line) versions are previews. Everyone else signs in.
import express from 'express';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { checkLabTake, isLocal } from '../lab.js';
import { UPLOADS } from './jobs.js';
import { FREE_BELOW_MATCH, MAX_VERSIONS } from './recipe.js';
import { unitsPerVersion } from '../billing.js';

const MEDIA = /^(start-\d+\.(png|jpg)|video-\d+\.mp4|wm-\d+\.mp4|reference\.mp4|first-frame\.png|preview-\d+\.jpg)$/;

/**
 * What the browser may see of a job: no provider URLs, no internal request ids; our AI cost only for the founder.
 * Customers get previews of free versions and the watermarked copy of trial videos; own-key jobs are theirs in full.
 */
export function publicJob(job, recipe, { admin = true } = {}) {
  const { urls, log, charge, ...rest } = job;
  const full = admin || job.byok;
  const out = {
    ...rest,
    startImages: job.startImages.map(({ n, status, file }) => ({ n, status, file })),
    candidates: job.candidates.map(({ n, status, file, verdict, match, error, score, free }) => ({
      n, status, verdict, match, error, free,
      // a free (under the line) version is a preview for customers: frames, not the video file
      file: !file ? file : free && !full ? `preview-${n}.jpg` : job.watermark && !full ? `wm-${n}.mp4` : file,
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

export function makeRoutes({ jobs, recipes, ready, accounts, pricing, realAiForCustomers = false, chargePractice = false, preview, watermark }) {
  const r = express.Router();
  const who = (req) => {
    const local = isLocal(req), user = accounts?.userFrom(req) || null;
    const admin = local || accounts?.isAdmin(user) || false;
    return { local, user, admin, ent: accounts?.ent(user, { admin }) || null };
  };
  /** Can this person run this recipe on our key? (Practice always; real AI for the founder, or customers when REAL_AI is on.) */
  const allowed = (w, recipe) => !!recipe && ready(recipe.provider) && (recipe.provider === 'mock' || w.admin || realAiForCustomers);
  /** …or on their own Higgsfield key? (a paid plan, a saved key, a Higgsfield recipe) */
  const ownKey = (w, recipe) => !!recipe && recipe.provider === 'higgsfield' && !w.admin && !!w.ent?.features.byok && !!w.user?.byok;
  const owns = (w, job) => w.admin || (w.user && job.userId === w.user.id);
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
      freeBelowMatch: FREE_BELOW_MATCH, maxVersions: MAX_VERSIONS, admin: w.admin, signedIn: !!(w.user || w.local),
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

  r.get('/', async (req, res) => {
    const list = (await jobs.list()).filter((j) => owns(req.who, j));
    res.json({ jobs: list.map((j) => publicJob(j, recipes[j.recipeId], req.who)) });
  });

  r.post('/', async (req, res) => {
    const { take, scene, look, recipeId, demo, quality, versions } = req.body || {};
    const errors = checkLabTake({ take: { ...take, label: undefined }, scene });
    if (errors.length) return res.status(400).json({ error: errors.slice(0, 2).join('; ') });
    const w = req.who, recipe = recipes[recipeId];
    // own key: when asked for, or when it's the only way this person can run this recipe
    const byok = !!recipe && ownKey(w, recipe) && (req.body?.byok === true || (req.body?.byok == null && !allowed(w, recipe)));
    if (req.body?.byok === true && recipe && !byok) return res.status(403).json(!w.ent?.features.byok ? { error: 'Using your own AI key comes with a paid plan.', code: 'plan' } : { error: 'Save your Higgsfield key in your account first.', code: 'byok' });
    if (recipe && !byok && !allowed(w, recipe)) return res.status(400).json({ error: `${recipe.label}: ${whyNot(w, recipe) === 'not set up on this server' ? 'isn’t set up on this server yet' : 'real AI video is switched off for this test. Try Practice.'}` });
    try {
      const job = await jobs.create({
        take, scene, look, recipeId, demo, quality, versions, userId: w.user?.id || null, unitFor: unitFor(w, byok), priority: w.ent?.features.priority ?? 0, byok,
        check: (j) => { const no = canAfford(w, j, j.versions ?? 1); if (no) throw Object.assign(new Error(no.error), { status: 402, code: no.code }); }, // before anything is rendered or uploaded
      });
      res.json({ job: publicJob(job, recipe, req.who), uploads: Object.keys(UPLOADS) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message, code: e.code }); }
  });

  // ---- steps on one job: only its owner (or the founder) ----
  r.param('id', async (req, res, next, id) => {
    const job = await jobs.load(id);
    if (!job || !owns(req.who, job)) return res.status(404).json({ error: 'no such job' });
    req.job = job;
    next();
  });

  r.put('/:id/files/:name', express.raw({ type: '*/*', limit: '200mb' }), async (req, res) => {
    const job = req.job;
    if (job.status !== 'uploading') return res.status(404).json({ error: 'no such job waiting for files' });
    if (!(req.params.name in UPLOADS) || !req.body?.length) return res.status(400).json({ error: 'unexpected file' });
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

  const step = (fn) => async (req, res) => {
    try {
      const job = await fn(req, res);
      if (res.headersSent) return;
      if (!job) return res.status(404).json({ error: 'no such job' });
      res.json({ job: publicJob(job, recipes[job.recipeId], req.who), account: accounts?.pub(req.who.user && accounts.get(req.who.user.id)) || null });
    } catch (e) { if (!res.headersSent) res.status(e.status || 500).json({ error: e.message }); }
  };
  r.post('/:id/start', step((req) => jobs.start(req.job.id)));
  r.post('/:id/redo-start', step((req) => jobs.redoStart(req.job.id, req.body?.look)));
  r.post('/:id/approve', step(async (req, res) => {
    if (req.job.status !== 'needs_approval') return req.job;
    const ask = Number(req.body?.versions);
    if (Number.isInteger(ask) && ask >= 1 && ask <= MAX_VERSIONS && ask !== req.job.versions) { req.job.versions = ask; await jobs.save(req.job); } // changed on the approval card
    if (!(await reserve(req.job, req.job.versions ?? recipes[req.job.recipeId]?.candidates ?? 1, res))) return null;
    return jobs.approve(req.job.id, Number(req.body?.n));
  }));
  r.post('/:id/more', step(async (req, res) => {
    if (req.job.status !== 'done') return req.job;
    if (!(await reserve(req.job, 1, res))) return null;
    return jobs.more(req.job.id);
  }));
  r.get('/:id', step((req) => req.job));

  r.get('/:id/media/:file', async (req, res) => {
    const job = req.job, name = req.params.file;
    if (!MEDIA.test(name)) return res.status(404).end();
    // a customer never gets the full file of a free version (only its preview frames), nor the clean file of a trial video
    const full = req.who.admin || job.byok;
    const n = Number(name.match(/^video-(\d+)\.mp4$/)?.[1]);
    if (n && !full && job.candidates.find((c) => c.n === n)?.free) return res.status(403).json({ error: 'This version was free (under the move-match line): preview only.' });
    if (n && !full && job.watermark) return res.status(403).json({ error: 'Free trial videos come with a watermark.', code: 'plan' });
    const wn = Number(name.match(/^wm-(\d+)\.mp4$/)?.[1]);
    if (wn) {
      const c = job.candidates.find((x) => x.n === wn);
      if (!c?.file || c.free || !watermark) return res.status(404).end();
      const out = jobs.path(job.id, name);
      if (!existsSync(out)) { try { await watermark(jobs.path(job.id, c.file), out); } catch (e) { console.warn(e.message); return res.status(503).json({ error: 'The video isn’t ready yet. Try again in a moment.' }); } }
      return res.sendFile(out);
    }
    const pn = Number(name.match(/^preview-(\d+)\.jpg$/)?.[1]);
    if (pn) {
      const c = job.candidates.find((x) => x.n === pn);
      if (!c?.file || !preview) return res.status(404).end();
      const out = jobs.path(job.id, name);
      if (!existsSync(out)) { try { await preview(jobs.path(job.id, c.file), out); } catch { return res.status(500).end(); } }
      return res.sendFile(out);
    }
    const file = jobs.path(job.id, name);
    if (!existsSync(file)) return res.status(404).end();
    res.sendFile(file); // supports Range requests, which Safari needs to play video
  });
  return r;
}
