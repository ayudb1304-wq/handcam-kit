// Make video jobs: take + set + look -> start image -> (you approve) -> videos -> scored -> best one.
// Each job is a folder under data/jobs/<id>/ with job.json and its files, so a server restart resumes it.
// The steps run here, in the server process; the browser only uploads files and polls job.json.
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fill, pick, judge, badness, matchPercent, pickQuality, pickVersions, videoCost, FREE_BELOW_MATCH } from './recipe.js';

export const UPLOADS = Object.freeze({ 'reference.mp4': 'video/mp4', 'measure.mp4': 'video/mp4', 'first-frame.png': 'image/png' });
// Optional reference pictures, sent to the AI after the step's own pictures (DECISIONS §47, §50). Only on jobs made with
// refs (routes.js decides who may: the founder until it's tested).
//  - ref-look.jpg: the look of the set, one wide picture of the whole place, approved once per set. The first frame is
//    made from it and the video gets it too, so the place is the same in every shot and never changes mid-video.
//  - ref-subject.jpg, ref-logo.png: the product as it really is, so the AI keeps its shape, label and colours.
export const REF_UPLOADS = Object.freeze({ 'ref-look.jpg': 'image/jpeg', 'ref-subject.jpg': 'image/jpeg', 'ref-logo.png': 'image/png' });
const LOOK_NOTE = 'The first extra reference image is a wide view of the whole place this shot is in. This shot is in that same place: the same landscape, buildings and objects, the same colours, light and weather, wherever they come into view. Do not invent a different place.';
const PRODUCT_NOTE = 'extra reference images show the real product. Keep it exactly as it is in them: same shape, proportions, colours, label and logo. Do not redesign, restyle or reletter it.';

/** What to tell the AI about the reference pictures a job has (names from REF_UPLOADS), in the order they are sent. */
export function refsNote(names, productNote) {
  const look = names.includes('ref-look.jpg'), product = names.some((n) => n !== 'ref-look.jpg');
  return [look && LOOK_NOTE, product && (productNote || `The ${look ? 'other ' : ''}${PRODUCT_NOTE}`)].filter(Boolean).join(' ');
}

/** A filled AI step input with the job's reference pictures added after its own images, and the note added to its prompt. */
export function withRefs(input, refUrls, note = refsNote(['ref-subject.jpg'])) {
  if (!refUrls?.length) return input;
  const out = { ...input, image_urls: [...(input.image_urls || []), ...refUrls] };
  if (typeof out.prompt === 'string') out.prompt = `${out.prompt}\n\n${note}`;
  return out;
}
const TERMINAL = new Set(['completed', 'failed', 'nsfw', 'canceled']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** rename, tried again a few times: on Windows it fails (EPERM) while a read still has the target open. */
async function swap(tmp, dest) {
  for (let i = 0; ; i++) {
    try { return await rename(tmp, dest); } catch (e) { if (i >= 6 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e; await sleep(10 * (i + 1)); }
  }
}

/**
 * providerFor(job): the provider a job runs on (default: providers[job.provider]); index.js uses it to run a job on the
 * customer's own Higgsfield key. queue: { run(priority, fn), busy } decides when each version may start (queue.js).
 */
export function makeJobs({ dir, recipes, providers, score, pollMs = [2000, 10000], onSettle = async () => {}, providerFor = null, queue = null, lookDir = join(dir, '..', 'looks') }) {
  const running = new Set();
  const writes = new Map(); // one job.json write at a time per job: versions finish in parallel

  const path = (id, f = '') => join(dir, id, f);
  async function load(id) {
    if (!/^[a-z0-9-]{8,64}$/.test(id)) return null;
    try { return JSON.parse(await readFile(path(id, 'job.json'), 'utf8')); } catch { return null; }
  }
  function save(job) {
    const next = (writes.get(job.id) || Promise.resolve()).then(async () => {
      job.updatedAt = new Date().toISOString();
      const tmp = path(job.id, 'job.json.tmp');
      await writeFile(tmp, JSON.stringify(job, null, 2));
      await swap(tmp, path(job.id, 'job.json')); // atomic: a crash never leaves half a job.json
    });
    writes.set(job.id, next.catch(() => {}));
    return next.then(() => job);
  }
  let index = null; // job id → { userId (null: the founder's laptop), at: when it was made }; filled on first use
  async function owners() {
    if (index) return index;
    const m = new Map();
    for (const id of await readdir(dir).catch(() => [])) { const j = await load(id); if (j) m.set(id, { userId: j.userId ?? null, at: j.createdAt || '' }); }
    return (index ??= m);
  }
  /** Run one version's work when the queue lets it (higher plans first when busy). Own-key jobs don't wait for our slots. */
  function lane(job, fn) {
    if (!queue || job.byok) return fn();
    if (queue.busy) say(job, 'Busy right now: waiting for a free slot');
    return queue.run(job.priority ?? 0, fn);
  }
  const say = (job, msg) => { job.log.push({ t: new Date().toISOString(), msg }); };

  /** Create a job and save take/scene; the browser then PUTs the UPLOADS and calls start(). */
  /** check(job): a last look before anything is written (routes.js: can this account afford it?). Throw to refuse. */
  async function create({ take, scene, look, recipeId, demo = false, quality, versions, userId = null, unitFor = () => 0, priority = 0, byok = false, refs = false, check = () => {} }) {
    const recipe = recipes[recipeId];
    if (!recipe) throw Object.assign(new Error(`unknown recipe ${recipeId}`), { status: 400 });
    if (typeof look !== 'string' || look.trim().length < 3) throw Object.assign(new Error('Describe the look in a few words first.'), { status: 400 });
    const resolution = pickQuality(recipe, quality);
    const versionCount = pickVersions(recipe, versions);
    const id = `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
    const durationMs = take.samples.at(-1).ts;
    const maxS = recipe.maxDurationS ?? 15;
    if (Math.round(durationMs / 1000) > maxS) throw Object.assign(new Error(`This take is ${(durationMs / 1000).toFixed(1)} s. ${recipe.label} takes up to ${maxS} s: shoot it again a little shorter.`), { status: 400 });
    const job = {
      id, createdAt: new Date().toISOString(), recipeId, provider: recipe.provider, demo: Boolean(demo),
      look: look.trim(), take: { id: take.id, label: take.label || null, durationS: +(durationMs / 1000).toFixed(2) },
      aspect: (take.view?.aspect ?? 0.5) < 1 ? '9:16' : '16:9', resolution, versions: versionCount,
      durationS: Math.min(maxS, Math.max(recipe.minDurationS ?? 4, Math.round(durationMs / 1000))),
      status: 'uploading', urls: {}, startImages: [], candidates: [], best: null, outcome: null, error: null, log: [],
      userId, priority, byok: Boolean(byok), ...(refs && { refs: true }),
    };
    const unit = unitFor(job); // videos per version for this account (0: free, e.g. practice or the founder's laptop)
    if (unit > 0) job.charge = { unit, reserved: 0, refunded: 0 };
    check(job);
    await mkdir(path(id), { recursive: true });
    index?.set(id, { userId, at: job.createdAt });
    await writeFile(path(id, 'take.json'), JSON.stringify(take));
    await writeFile(path(id, 'scene.json'), JSON.stringify(scene));
    say(job, 'Job created');
    return save(job);
  }

  async function begin(id, work) { // run one step chain per job at a time
    if (running.has(id)) return;
    running.add(id);
    try { await work(); } finally { running.delete(id); }
  }
  async function fail(job, e) {
    job.status = 'failed';
    job.error = e.message || String(e);
    say(job, `Failed: ${job.error}`);
    await save(job);
    await settle(job);
  }
  /** Give back what the customer doesn't owe (free and failed versions). Never throws into the job. */
  async function settle(job) {
    try { await onSettle(job); await save(job); } catch (e) { console.warn(`settle ${job.id}:`, e.message); }
  }

  async function poll(provider, requestId) {
    let wait = pollMs[0];
    for (;;) {
      let s;
      try { s = await provider.status(requestId); } catch (e) { if (!e.retryable && e.status) throw e; s = { status: 'in_progress' }; }
      if (TERMINAL.has(s.status)) return s;
      await sleep(wait + Math.random() * 300);
      wait = Math.min(wait * 1.5, pollMs[1]);
    }
  }

  /** A filled AI step input with this job's reference pictures and the note about them. */
  function refd(job, recipe, input) {
    const names = job.refs ? Object.keys(REF_UPLOADS).filter((n) => job.urls[n]) : [];
    return withRefs(input, names.map((n) => job.urls[n]), refsNote(names, recipe.refsNote));
  }
  function vars(job, extra = {}) {
    return { look: job.look, aspect: job.aspect, durationS: job.durationS, resolution: job.resolution ?? '480p', demo: job.demo, firstFrameUrl: job.urls['first-frame.png'], referenceUrl: job.urls['reference.mp4'], ...extra };
  }

  async function makeStartImage(job, recipe, provider) {
    const n = job.startImages.length + 1;
    const entry = { n, status: 'running', file: null, requestId: null };
    job.startImages.push(entry);
    job.status = 'start_image';
    say(job, `Making start image ${n}`);
    await save(job);
    const { requestId } = await provider.submit(recipe.startImage.endpoint, refd(job, recipe, fill(recipe.startImage.input, vars(job))), `${job.id}-start-${n}`);
    entry.requestId = requestId;
    await save(job);
    const s = await poll(provider, requestId);
    if (s.status !== 'completed') throw new Error(s.status === 'nsfw' ? 'The picture was blocked by the AI’s content filter. Try other words for the look.' : `start image ${s.status}${s.error ? `: ${s.error}` : ''}`);
    const url = pick(s.result, recipe.startImage.output);
    if (!url) throw new Error('start image finished without a picture');
    entry.file = `start-${n}${/\.png($|\?)/.test(url) ? '.png' : '.jpg'}`;
    await provider.download(url, path(job.id, entry.file));
    entry.url = url;
    entry.status = 'done';
    job.status = 'needs_approval';
    say(job, 'Start image ready: waiting for your OK');
    await save(job);
  }

  async function makeCandidate(job, recipe, provider) {
    const n = job.candidates.length + 1;
    const c = { n, status: 'running', requestId: null, file: null, score: null, verdict: null, match: null };
    job.candidates.push(c);
    await save(job);
    const start = job.startImages.find((s) => s.n === job.approvedStart);
    const input = refd(job, recipe, fill(recipe.video.input, vars(job, { startImageUrl: start.url })));
    const { requestId } = await provider.submit(recipe.video.endpoint, input, `${job.id}-video-${n}`);
    c.requestId = requestId;
    await save(job);
    return c;
  }
  async function finishCandidate(job, recipe, provider, c) {
    const s = await poll(provider, c.requestId);
    if (s.status !== 'completed') { c.status = 'failed'; c.error = s.status === 'nsfw' ? 'blocked by content filter' : s.error || s.status; return; }
    const url = pick(s.result, recipe.video.output);
    c.file = `video-${c.n}.mp4`;
    await provider.download(url, path(job.id, c.file));
    c.status = 'made';
  }

  async function scoreAndChoose(job, recipe) {
    const todo = job.candidates.filter((c) => c.status === 'made');
    if (todo.length) {
      job.status = 'checking';
      say(job, `Checking ${todo.length} video${todo.length > 1 ? 's' : ''} against your move`);
      await save(job);
      const r = await score(path(job.id, 'take.json'), todo.map((c) => path(job.id, c.file)));
      todo.forEach((c, i) => {
        c.status = 'checked';
        if (r.error) { c.verdict = { pass: null, reasons: [r.error] }; return; }
        c.score = r.scores[i];
        c.verdict = judge(c.score, recipe.pass);
        c.match = matchPercent(c.score);
      });
      if (r.error) job.checkError = r.error;
    }
    const done = job.candidates.filter((c) => c.status === 'checked');
    const passed = done.filter((c) => c.verdict?.pass);
    const pool = passed.length ? passed : done;
    const best = [...pool].sort((a, b) => badness(a.score) - badness(b.score))[0];
    job.best = best?.n ?? null;
    job.outcome = !best ? null : job.checkError ? 'unchecked' : passed.length ? 'passed' : 'best_effort';
    bill(job, recipe);
    return passed.length > 0;
  }

  /**
   * Who pays for what. A version under FREE_BELOW_MATCH% move match is free: the customer is not charged for it
   * (an unchecked version is charged: we can't show it failed). Not on the free trial (job.watermark: paid with trial
   * videos): there every version made counts, so the two free videos are two tries, not tries until one fits
   * (DECISIONS §49). apiUsd is what the provider charged us for everything.
   */
  function bill(job, recipe) {
    const made = job.candidates.filter((c) => c.file);
    for (const c of made) c.free = !job.watermark && c.match != null && c.match < FREE_BELOW_MATCH;
    const per = videoCost(recipe, job.resolution, job.durationS);
    const best = made.find((c) => c.n === job.best);
    job.billing = {
      videos: made.length,
      charged: made.filter((c) => !c.free).length,
      free: made.filter((c) => c.free).length,
      apiUsd: +(job.startImages.filter((x) => x.file).length * (recipe.cost?.startImage ?? 0) + made.length * per).toFixed(2),
      freeBelow: FREE_BELOW_MATCH,
      tryAgain: Boolean(best?.free), // the kept one didn't follow: offer to make another
    };
  }

  async function makeVideos(job, recipe, provider) {
    job.status = 'making';
    const count = job.versions ?? recipe.candidates;
    say(job, `Making ${count} version${count > 1 ? 's' : ''}`);
    await save(job);
    const fresh = [];
    for (let i = 0; i < count; i++) fresh.push(lane(job, async () => { const c = await makeCandidate(job, recipe, provider); await finishCandidate(job, recipe, provider, c); await save(job); }));
    await Promise.all(fresh);
    let ok = await scoreAndChoose(job, recipe);
    // You choose how many versions (job.versions): no automatic extra tries. Older jobs keep the recipe's retry.
    const extraTries = job.versions == null ? recipe.extraTries ?? 0 : 0;
    for (let extra = 0; !ok && !job.checkError && extra < extraTries; extra++) {
      job.status = 'making';
      say(job, 'No version followed your move closely enough: making one more');
      await save(job);
      await lane(job, async () => { const c = await makeCandidate(job, recipe, provider); await finishCandidate(job, recipe, provider, c); });
      ok = await scoreAndChoose(job, recipe);
    }
    if (job.best == null) throw new Error(job.candidates.map((c) => c.error).filter(Boolean)[0] || 'no video was made');
    job.status = 'done';
    say(job, job.billing?.tryAgain ? `Done: under ${FREE_BELOW_MATCH}% move match, not charged` : job.outcome === 'passed' ? 'Done: follows your move' : job.outcome === 'unchecked' ? 'Done (not checked)' : 'Done: closest version kept');
    await save(job);
    await settle(job);
  }

  // ---- public steps ----------------------------------------------------------------
  const ctx = (job) => ({ recipe: recipes[job.recipeId], provider: providerFor ? providerFor(job) : providers[job.provider] });

  async function upload(job) {
    const { provider } = ctx(job);
    for (const [name, type] of Object.entries(UPLOADS)) {
      if (job.urls[name]) continue;
      if (!existsSync(path(job.id, name))) throw new Error(`${name} was not uploaded`);
      job.urls[name] = await provider.upload(path(job.id, name), type);
    }
    if (job.refs) for (const [name, type] of Object.entries(REF_UPLOADS)) { // optional: whichever the person gave
      if (!job.urls[name] && existsSync(path(job.id, name))) job.urls[name] = await provider.upload(path(job.id, name), type);
    }
  }

  /**
   * The look of a set: one wide photoreal picture of the whole place, made from a grey wide view of the blockout (and
   * the product photo, when there is one). Not a job: the picture goes back to the browser, which keeps it with the
   * set, and nothing stays here. → { file, done() } (call done() once the file has been sent)
   */
  async function look({ recipeId, words, aspect = '16:9', wide, subject = null, byok = false, userId = null }) {
    const recipe = recipes[recipeId];
    if (!recipe) throw Object.assign(new Error(`unknown recipe ${recipeId}`), { status: 400 });
    if (typeof words !== 'string' || words.trim().length < 3) throw Object.assign(new Error('Describe the look in a few words first.'), { status: 400 });
    const id = `look-${randomUUID().slice(0, 12)}`, at = join(lookDir, id);
    const done = () => rm(at, { recursive: true, force: true }).catch(() => {});
    try {
      await mkdir(at, { recursive: true });
      const provider = providerFor ? providerFor({ provider: recipe.provider, byok, userId }) : providers[recipe.provider];
      await writeFile(join(at, 'wide.png'), wide);
      const wideUrl = await provider.upload(join(at, 'wide.png'), 'image/png');
      let subjectUrl = null;
      if (subject) { await writeFile(join(at, 'subject.jpg'), subject); subjectUrl = await provider.upload(join(at, 'subject.jpg'), 'image/jpeg'); }
      const step = recipe.setLook || recipe.startImage;
      const filled = fill(step.input, { look: words.trim(), aspect, resolution: '480p', durationS: 0, demo: false, firstFrameUrl: wideUrl, referenceUrl: '' });
      const input = subjectUrl ? withRefs(filled, [subjectUrl], refsNote(['ref-subject.jpg'], recipe.refsNote)) : filled;
      const { requestId } = await provider.submit(step.endpoint, input, id);
      const s = await poll(provider, requestId);
      if (s.status !== 'completed') throw new Error(s.status === 'nsfw' ? 'The picture was blocked by the AI’s content filter. Try other words for the look.' : `the look ${s.status}${s.error ? `: ${s.error}` : ''}`);
      const url = pick(s.result, step.output);
      if (!url) throw new Error('the look finished without a picture');
      const file = join(at, `look${/\.png($|\?)/.test(url) ? '.png' : '.jpg'}`);
      await provider.download(url, file);
      return { file, done };
    } catch (e) { await done(); throw e; }
  }

  return {
    create, load, save, look,
    path: (id, f) => path(id, f),
    /**
     * Jobs, newest first. `owner`: only that account's (undefined: everyone's, for the founder). Who owns which job is
     * read once and remembered, so one account's list never depends on how many videos other people have made.
     */
    async list({ owner, limit = 60 } = {}) {
      const all = await owners();
      const ids = [...all.entries()].filter(([, o]) => owner === undefined || o.userId === owner).sort((a, b) => (a[1].at < b[1].at ? 1 : -1)).slice(0, limit).map(([id]) => id);
      return (await Promise.all(ids.map(load))).filter(Boolean);
    },
    /** All files are in: upload to the provider and make the start image. */
    async start(id) {
      const job = await load(id);
      if (!job) return null;
      if (job.status !== 'uploading') return job;
      begin(id, async () => {
        const { recipe, provider } = ctx(job);
        try { job.status = 'preparing'; await save(job); await upload(job); await save(job); await makeStartImage(job, recipe, provider); }
        catch (e) { await fail(job, e); }
      });
      return job;
    },
    /** New start image, optionally with new words for the look. */
    async redoStart(id, look) {
      const job = await load(id);
      if (!job || job.status !== 'needs_approval') return job;
      if (typeof look === 'string' && look.trim().length >= 3) job.look = look.trim();
      begin(id, async () => { try { await makeStartImage(job, ...Object.values(ctx(job))); } catch (e) { await fail(job, e); } });
      return job;
    },
    /** You approved start image n: make the videos. */
    async approve(id, n) {
      const job = await load(id);
      if (!job || job.status !== 'needs_approval') return job;
      job.approvedStart = job.startImages.some((s) => s.n === n && s.file) ? n : job.startImages.findLast((s) => s.file)?.n;
      await save(job);
      begin(id, async () => { try { await makeVideos(job, ...Object.values(ctx(job))); } catch (e) { await fail(job, e); } });
      return job;
    },
    /**
     * Stop a video while its first frame waits for an OK. Nothing has been taken from the account yet (videos are
     * reserved on approve), so there is nothing to give back. Once the versions are being made there is no cancel.
     */
    async cancel(id) {
      const job = await load(id);
      if (!job || job.status !== 'needs_approval') return job;
      job.status = 'canceled';
      say(job, 'Cancelled before the video was made');
      await save(job);
      await settle(job); // nothing to give back; it lets the record of what happened be kept
      return job;
    },
    /** "Try again" after done: one more version, then pick the best of all. */
    async more(id) {
      const job = await load(id);
      if (!job || job.status !== 'done') return job;
      begin(id, async () => {
        const { recipe, provider } = ctx(job);
        try {
          job.status = 'making'; say(job, 'Making one more version'); await save(job);
          await lane(job, async () => { const c = await makeCandidate(job, recipe, provider); await finishCandidate(job, recipe, provider, c); });
          await scoreAndChoose(job, recipe);
          job.status = 'done'; await save(job); await settle(job);
        } catch (e) { await fail(job, e); }
      });
      return job;
    },
    /** After a restart: carry on any job that was mid-way. Practice jobs can't resume (their fake requests are gone). */
    async resume() {
      for (const job of await this.list({ limit: Infinity })) {
        if (!['preparing', 'start_image', 'making', 'checking'].includes(job.status)) continue;
        const { recipe, provider } = ctx(job);
        if (!recipe || !provider || provider.name === 'mock') { await fail(job, new Error('interrupted by a restart')); continue; }
        begin(job.id, async () => {
          try {
            if (job.status === 'preparing' || job.status === 'start_image') {
              job.startImages = job.startImages.filter((s) => s.file); // the idempotency key returns the same request
              await upload(job); await makeStartImage(job, recipe, provider);
            } else {
              for (const c of job.candidates) if (c.status === 'running' && !c.requestId) { c.status = 'failed'; c.error = 'interrupted before it started'; }
              await Promise.all(job.candidates.filter((c) => c.status === 'running').map((c) => finishCandidate(job, recipe, provider, c)));
              await scoreAndChoose(job, recipe);
              if (job.best == null) throw new Error('no video was made');
              job.status = 'done'; await save(job); await settle(job);
            }
          } catch (e) { await fail(job, e); }
        });
      }
    },
  };
}
