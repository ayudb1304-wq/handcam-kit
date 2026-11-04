// Make video jobs: take + set + look -> start image -> (you approve) -> videos -> scored -> best one.
// Each job is a folder under data/jobs/<id>/ with job.json and its files, so a server restart resumes it.
// The steps run here, in the server process; the browser only uploads files and polls job.json.
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fill, pick, judge, badness, matchPercent, pickQuality, pickVersions, videoCost, FREE_BELOW_MATCH } from './recipe.js';

export const UPLOADS = Object.freeze({ 'reference.mp4': 'video/mp4', 'measure.mp4': 'video/mp4', 'first-frame.png': 'image/png' });
const TERMINAL = new Set(['completed', 'failed', 'nsfw', 'canceled']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeJobs({ dir, recipes, providers, score, pollMs = [2000, 10000] }) {
  const running = new Set();

  const path = (id, f = '') => join(dir, id, f);
  async function load(id) {
    if (!/^[a-z0-9-]{8,64}$/.test(id)) return null;
    try { return JSON.parse(await readFile(path(id, 'job.json'), 'utf8')); } catch { return null; }
  }
  async function save(job) {
    job.updatedAt = new Date().toISOString();
    const tmp = path(job.id, 'job.json.tmp');
    await writeFile(tmp, JSON.stringify(job, null, 2));
    await rename(tmp, path(job.id, 'job.json')); // atomic: a crash never leaves half a job.json
    return job;
  }
  const say = (job, msg) => { job.log.push({ t: new Date().toISOString(), msg }); };

  /** Create a job and save take/scene; the browser then PUTs the UPLOADS and calls start(). */
  async function create({ take, scene, look, recipeId, demo = false, quality, versions }) {
    const recipe = recipes[recipeId];
    if (!recipe) throw Object.assign(new Error(`unknown recipe ${recipeId}`), { status: 400 });
    if (typeof look !== 'string' || look.trim().length < 3) throw Object.assign(new Error('Describe the look in a few words first.'), { status: 400 });
    const resolution = pickQuality(recipe, quality);
    const versionCount = pickVersions(recipe, versions);
    const id = `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
    await mkdir(path(id), { recursive: true });
    await writeFile(path(id, 'take.json'), JSON.stringify(take));
    await writeFile(path(id, 'scene.json'), JSON.stringify(scene));
    const durationMs = take.samples.at(-1).ts;
    const job = {
      id, createdAt: new Date().toISOString(), recipeId, provider: recipe.provider, demo: Boolean(demo),
      look: look.trim(), take: { id: take.id, label: take.label || null, durationS: +(durationMs / 1000).toFixed(2) },
      aspect: (take.view?.aspect ?? 0.5) < 1 ? '9:16' : '16:9', resolution, versions: versionCount,
      durationS: Math.min(recipe.maxDurationS ?? 15, Math.max(recipe.minDurationS ?? 4, Math.round(durationMs / 1000))),
      status: 'uploading', urls: {}, startImages: [], candidates: [], best: null, outcome: null, error: null, log: [],
    };
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
    const { requestId } = await provider.submit(recipe.startImage.endpoint, fill(recipe.startImage.input, vars(job)), `${job.id}-start-${n}`);
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
    const input = fill(recipe.video.input, vars(job, { startImageUrl: start.url }));
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
   * (an unchecked version is charged: we can't show it failed). apiUsd is what the provider charged us for everything.
   */
  function bill(job, recipe) {
    const made = job.candidates.filter((c) => c.file);
    for (const c of made) c.free = c.match != null && c.match < FREE_BELOW_MATCH;
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
    for (let i = 0; i < count; i++) fresh.push(await makeCandidate(job, recipe, provider));
    await Promise.all(fresh.map((c) => finishCandidate(job, recipe, provider, c).then(() => save(job))));
    let ok = await scoreAndChoose(job, recipe);
    // You choose how many versions (job.versions): no automatic extra tries. Older jobs keep the recipe's retry.
    const extraTries = job.versions == null ? recipe.extraTries ?? 0 : 0;
    for (let extra = 0; !ok && !job.checkError && extra < extraTries; extra++) {
      job.status = 'making';
      say(job, 'No version followed your move closely enough: making one more');
      await save(job);
      const c = await makeCandidate(job, recipe, provider);
      await finishCandidate(job, recipe, provider, c);
      ok = await scoreAndChoose(job, recipe);
    }
    if (job.best == null) throw new Error(job.candidates.map((c) => c.error).filter(Boolean)[0] || 'no video was made');
    job.status = 'done';
    say(job, job.billing?.tryAgain ? `Done: under ${FREE_BELOW_MATCH}% move match, not charged` : job.outcome === 'passed' ? 'Done: follows your move' : job.outcome === 'unchecked' ? 'Done (not checked)' : 'Done: closest version kept');
    await save(job);
  }

  // ---- public steps ----------------------------------------------------------------
  const ctx = (job) => ({ recipe: recipes[job.recipeId], provider: providers[job.provider] });

  async function upload(job) {
    const { provider } = ctx(job);
    for (const [name, type] of Object.entries(UPLOADS)) {
      if (job.urls[name]) continue;
      if (!existsSync(path(job.id, name))) throw new Error(`${name} was not uploaded`);
      job.urls[name] = await provider.upload(path(job.id, name), type);
    }
  }

  return {
    create, load,
    path: (id, f) => path(id, f),
    async list() {
      const ids = (await readdir(dir).catch(() => [])).sort().reverse().slice(0, 50);
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
    /** "Try again" after done: one more version, then pick the best of all. */
    async more(id) {
      const job = await load(id);
      if (!job || job.status !== 'done') return job;
      begin(id, async () => {
        const { recipe, provider } = ctx(job);
        try {
          job.status = 'making'; say(job, 'Making one more version'); await save(job);
          const c = await makeCandidate(job, recipe, provider);
          await finishCandidate(job, recipe, provider, c);
          await scoreAndChoose(job, recipe);
          job.status = 'done'; await save(job);
        } catch (e) { await fail(job, e); }
      });
      return job;
    },
    /** After a restart: carry on any job that was mid-way. Practice jobs can't resume (their fake requests are gone). */
    async resume() {
      for (const job of await this.list()) {
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
              job.status = 'done'; await save(job);
            }
          } catch (e) { await fail(job, e); }
        });
      }
    },
  };
}
