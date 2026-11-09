import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fill, pick, judge, checkRecipe, loadRecipes, badness, matchPercent, pickQuality, pickVersions, videoCost } from './make/recipe.js';
import { makeJobs } from './make/jobs.js';
import { makeMock } from './make/providers/mock.js';
import { makeHiggsfield } from './make/providers/higgsfield.js';
import { publicJob } from './make/routes.js';
import { loadTemplate } from './scene.js';

const take = { id: '2026-11-04T19-00-00Z-ab12', view: { fov: 60, aspect: 0.46 },
  samples: Array.from({ length: 300 }, (_, i) => ({ ts: i * 16.67, q: [0, 0, 0, 1], p: [0, 1.6, 7 - i * 0.01] })) };
const good = { turn_corr: 0.99, timing_offset_s: 0.04, turn_rms_after_shift_deg: 6, walk_ratio: 0.95, walk_corr: 0.98 };
const bad = { turn_corr: 0.82, timing_offset_s: -0.13, turn_rms_after_shift_deg: 28, walk_ratio: 0.9, walk_corr: 0.95 };

test('fill keeps types for whole placeholders and refuses unknown ones', () => {
  assert.deepEqual(fill({ d: '{{n}}', p: 'look: {{look}}', a: ['{{u}}'], b: '{{flag}}' }, { n: 6, look: 'night', u: 'x', flag: false }),
    { d: 6, p: 'look: night', a: ['x'], b: false });
  assert.throws(() => fill('{{nope}}', {}), /nope/);
  assert.equal(pick({ images: [{ url: 'u' }] }, 'images.0.url'), 'u');
});

test('judge passes a good run, fails an invented move with a plain reason, and skips marks it has no number for', () => {
  const pass = { turnCorrMin: 0.95, maxOffsetS: 0.3, walkRatio: [0.7, 1.3], walkCorrMin: 0.9 };
  assert.equal(judge(good, pass).pass, true);
  assert.deepEqual(judge(bad, pass), { pass: false, reasons: ['turns don’t match your move'] });
  assert.match(judge({ ...good, walk_ratio: 0.13 }, pass).reasons[0], /walks less/);
  assert.equal(judge({ turn_corr: 0.99, timing_offset_s: 0 }, pass).pass, true, 'no walking measured: walk marks skipped');
  assert.ok(badness(good) < badness(bad));
  assert.ok(matchPercent(good) > matchPercent(bad));
});

test('the shipped recipes load and are complete', async () => {
  const r = await loadRecipes(new URL('../recipes', import.meta.url).pathname);
  assert.ok(r.practice && r['seedance-2.5']);
  for (const x of Object.values(r)) assert.deepEqual(checkRecipe(x), []);
  assert.ok(checkRecipe({ id: 'x', provider: 'nope' }).length);
});

async function practiceJob({ scores, versions }) {
  const dir = await mkdtemp(join(tmpdir(), 'jobs-'));
  const recipes = await loadRecipes(new URL('../recipes', import.meta.url).pathname);
  let calls = 0;
  const score = async (takeJson, videos) => ({ scores: videos.map(() => scores[calls++] ?? good) });
  const jobs = makeJobs({ dir, recipes, providers: { mock: makeMock({ delay: { start: 5, video: 5 } }) }, score, pollMs: [5, 10] });
  const scene = await loadTemplate('parking-lot');
  const job = await jobs.create({ take, scene, look: 'wet parking lot at night', recipeId: 'practice', versions });
  for (const f of ['reference.mp4', 'measure.mp4', 'first-frame.png']) await writeFile(jobs.path(job.id, f), f);
  return { dir, jobs, job };
}
const until = async (jobs, id, status) => {
  for (let i = 0; i < 400; i++) { const j = await jobs.load(id); if (j.status === status || j.status === 'failed') return j; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`timed out waiting for ${status}`);
};

test('practice job: start image, waits for approval, makes 2 versions, keeps the best passing one', async () => {
  const { dir, jobs, job } = await practiceJob({ scores: [bad, good] });
  try {
    await jobs.start(job.id);
    let j = await until(jobs, job.id, 'needs_approval');
    assert.equal(j.startImages[0].file, 'start-1.png');
    assert.equal(await readFile(jobs.path(job.id, 'start-1.png'), 'utf8'), 'first-frame.png', 'practice start image = grey first frame');
    await jobs.approve(job.id, 1);
    j = await until(jobs, job.id, 'done');
    assert.equal(j.candidates.length, 2);
    assert.equal(j.best, 2, 'the run that followed the move wins');
    assert.equal(j.outcome, 'passed');
    assert.deepEqual([j.candidates[0].free, j.candidates[1].free], [true, false], 'under 70% move match is free');
    assert.equal(j.billing.charged, 1);
    assert.equal(j.billing.tryAgain, false);
    const pub = publicJob(j, { id: 'practice' });
    assert.equal(pub.urls, undefined, 'provider URLs never reach the browser');
    assert.equal(pub.candidates[0].requestId, undefined);
  } finally { await rm(dir, { recursive: true }); }
});

test('you choose the number of versions: no automatic extra; if the kept one is under 70% it is free and Try again adds one', async () => {
  const { dir, jobs, job } = await practiceJob({ scores: [bad, bad, { ...bad, turn_rms_after_shift_deg: 20 }], versions: 2 });
  try {
    assert.equal(job.versions, 2);
    await jobs.start(job.id);
    await until(jobs, job.id, 'needs_approval');
    await jobs.approve(job.id, 1);
    let j = await until(jobs, job.id, 'done');
    assert.equal(j.candidates.length, 2, 'no extra version made on its own');
    assert.equal(j.outcome, 'best_effort');
    assert.deepEqual({ charged: j.billing.charged, free: j.billing.free, tryAgain: j.billing.tryAgain }, { charged: 0, free: 2, tryAgain: true });
    await jobs.more(job.id);
    await new Promise((r) => setTimeout(r, 50));
    j = await until(jobs, job.id, 'done');
    assert.equal(j.candidates.length, 3);
    assert.equal(j.best, 3);
    assert.equal(j.candidates[2].match, 74);
    assert.deepEqual({ charged: j.billing.charged, tryAgain: j.billing.tryAgain }, { charged: 1, tryAgain: false }, '74% is charged even though it misses the pass marks');
  } finally { await rm(dir, { recursive: true }); }
});

test('versions: 1 to 4 or the recipe default; video cost comes from the recipe in USD', async () => {
  const recipes = await loadRecipes(new URL('../recipes', import.meta.url).pathname);
  const sd = recipes['seedance-2.5'];
  assert.equal(pickVersions(sd), sd.candidates);
  assert.equal(pickVersions(sd, '3'), 3);
  assert.throws(() => pickVersions(sd, 5), /1 to 4/);
  assert.throws(() => pickVersions(sd, 0), /1 to 4/);
  assert.equal(+videoCost(sd, '480p', 6).toFixed(2), 1.0, 'matches the measured $1.00 for a 6 s 480p video');
  assert.equal(videoCost(recipes.practice, undefined, 6), 0);
});

test('a job refuses to start without its files, and needs words for the look', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jobs-'));
  try {
    const recipes = await loadRecipes(new URL('../recipes', import.meta.url).pathname);
    const jobs = makeJobs({ dir, recipes, providers: { mock: makeMock({ delay: { start: 5, video: 5 } }) }, score: async () => ({}), pollMs: [5, 10] });
    const scene = await loadTemplate('parking-lot');
    await assert.rejects(jobs.create({ take, scene, look: '', recipeId: 'practice' }), /look/);
    const job = await jobs.create({ take, scene, look: 'night', recipeId: 'practice' });
    await jobs.start(job.id);
    const j = await until(jobs, job.id, 'needs_approval');
    assert.equal(j.status, 'failed');
    assert.match(j.error, /was not uploaded/);
    assert.equal(await jobs.load('../../etc'), null);
  } finally { await rm(dir, { recursive: true }); }
});

test('higgsfield adapter: key header, idempotency key, presigned upload, status, all server-side', async () => {
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push({ url, opts });
    const json = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b), arrayBuffer: async () => new ArrayBuffer(3) });
    if (url.endsWith('/files/generate-upload-url')) return json({ public_url: 'https://cdn/x.mp4', upload_url: 'https://s3/put', upload_headers: { 'Content-Type': 'video/mp4' } });
    if (url === 'https://s3/put') return { ok: true, status: 200 };
    if (url.includes('/requests/')) return json({ status: 'completed', video: { url: 'https://cdn/out.mp4' } });
    if (url.endsWith('/bytedance/seedance-2.5/reference-to-video')) return json({ request_id: 'r1', status: 'queued' });
    return json({});
  };
  const hf = makeHiggsfield({ env: { HF_API_KEY_ID: 'id', HF_API_KEY_SECRET: 'sec' }, fetchImpl });
  const dir = await mkdtemp(join(tmpdir(), 'hf-'));
  try {
    await writeFile(join(dir, 'a.mp4'), 'abc');
    assert.equal(await hf.upload(join(dir, 'a.mp4'), 'video/mp4'), 'https://cdn/x.mp4');
    assert.equal(seen[0].opts.headers.Authorization, 'Key id:sec');
    assert.equal(seen[1].opts.headers.Authorization, undefined, 'credentials never go to the storage URL');
    assert.deepEqual(await hf.submit('bytedance/seedance-2.5/reference-to-video', { prompt: 'p' }, 'job-video-1'), { requestId: 'r1' });
    assert.equal(seen[2].opts.headers['Idempotency-Key'], 'job-video-1');
    assert.equal((await hf.status('r1')).status, 'completed');
  } finally { await rm(dir, { recursive: true }); }
  const none = makeHiggsfield({ env: {}, fetchImpl });
  await assert.rejects(none.submit('x', {}, 'k'), /HF_API_KEY_ID/);
});

test('quality: the recipe’s first quality is the default, others must be on its list, and it reaches the video request', async () => {
  const recipes = await loadRecipes(new URL('../recipes', import.meta.url).pathname);
  const sd = recipes['seedance-2.5'];
  assert.equal(pickQuality(sd), '480p');
  assert.equal(pickQuality(sd, '1080p'), '1080p');
  assert.throws(() => pickQuality(sd, '4k'), /480p, 720p, 1080p/);
  assert.equal(pickQuality(recipes.practice, '1080p'), null); // practice has no qualities: ignored
  assert.equal(fill(sd.video.input, { look: 'x', aspect: '9:16', durationS: 6, resolution: '720p', startImageUrl: 'a', referenceUrl: 'b' }).resolution, '720p');
  assert.ok(checkRecipe({ ...sd, qualities: { big: 1 } }).some((e) => /qualities/.test(e)));
});

// ---- Phase 5c: paywalls on Make video, as a customer sees them (docs/PRICING-PLAN.md) ----
import express from 'express';
import { makeRoutes } from './make/routes.js';
import { makeAccounts } from './accounts.js';
import { loadPricing, refundDue } from './billing.js';
import { makeQueue } from './make/queue.js';

test('queue: at most `slots` at once, higher priority first when busy, then first come first served', async () => {
  const q = makeQueue({ slots: 1 }), order = [];
  let release;
  const first = q.run(0, () => new Promise((r) => { release = r; order.push('a'); }));
  assert.equal(q.busy, true);
  const low = q.run(0, async () => order.push('low'));
  const high = q.run(2, async () => order.push('high'));
  const low2 = q.run(0, async () => order.push('low2'));
  await new Promise((r) => setTimeout(r, 0)); // the first one starts on the next tick
  release();
  await Promise.all([first, low, high, low2]);
  assert.deepEqual(order, ['a', 'high', 'low', 'low2']);
});

test('customer Make video: trial videos are spent, watermarked, refunded when free; running out says so before anything is made', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pay-make-'));
  const pricing = loadPricing(new URL('../config/pricing.json', import.meta.url).pathname);
  const recipes = await loadRecipes(new URL('../recipes', import.meta.url).pathname);
  const accounts = await makeAccounts({ dir: join(dir, 'acct'), pricing });
  const scores = [bad, good];
  let calls = 0;
  const jobs = makeJobs({
    dir: join(dir, 'jobs'), recipes, providers: { mock: makeMock({ delay: { start: 5, video: 5 } }) }, pollMs: [5, 10],
    score: async (t, videos) => ({ scores: videos.map(() => scores[calls++] ?? good) }),
    onSettle: async (job) => { const back = refundDue(job); if (back > 0) { await accounts.refund(job.userId, job.charge.from, back); job.charge.refunded += back; } },
  });
  const marked = [];
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/make', makeRoutes({ jobs, recipes, ready: () => true, accounts, pricing, chargePractice: true, preview: async () => {}, watermark: async (src, out) => { marked.push(src); await writeFile(out, 'wm'); } }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/make`;
  try {
    const u = await accounts.signup({ email: 't@x.co', password: 'longenough' });
    const headers = { cookie: accounts.cookieFor(u, { secure: false }).split(';')[0], 'x-forwarded-for': '1.2.3.4', 'content-type': 'application/json' }; // a visitor, not the founder's laptop
    const call = async (path, body, method = 'POST') => { const r = await fetch(`${base}${path}`, { method, headers, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    const scene = await loadTemplate('parking-lot');
    const cfg = await call('/config', undefined, 'GET');
    assert.equal(cfg.body.ent.videos.trial, 2);
    assert.equal(cfg.body.recipes.find((x) => x.id === 'seedance-2.5').ownKey, false, 'own key needs a paid plan and a saved key');

    const tooMany = await call('/', { take, scene, look: 'wet night', recipeId: 'practice', versions: 3 });
    assert.deepEqual([tooMany.status, tooMany.body.code], [402, 'balance'], 'refused before anything is rendered');
    assert.equal((await jobs.list()).length, 0, 'and nothing left behind');

    const made = await call('/', { take, scene, look: 'wet night', recipeId: 'practice', versions: 2 });
    assert.equal(made.status, 200);
    const id = made.body.job.id;
    for (const f of ['reference.mp4', 'measure.mp4', 'first-frame.png']) await writeFile(jobs.path(id, f), f);
    await call(`/${id}/start`);
    await until(jobs, id, 'needs_approval');
    const ok = await call(`/${id}/approve`, { n: 1, versions: 2 });
    assert.equal(ok.body.account.videos.trial, 0, 'both trial videos reserved');
    const j = await until(jobs, id, 'done');
    assert.equal(j.watermark, true);
    assert.equal(accounts.get(u.id).trial, 1, 'the free version (under 70%) gave its video back');
    const pub = (await call(`/${id}`, undefined, 'GET')).body.job;
    assert.equal(pub.candidates[0].file, 'preview-1.jpg', 'free version: preview only');
    assert.equal(pub.candidates[1].file, 'wm-2.mp4', 'trial video: the watermarked copy');
    assert.equal((await fetch(`${base}/${id}/media/video-2.mp4`, { headers })).status, 403, 'never the clean file');
    assert.equal((await fetch(`${base}/${id}/media/wm-2.mp4`, { headers })).status, 200);
    assert.equal(marked.length, 1);
  } finally { server.close(); await rm(dir, { recursive: true }); }
});

import { withRefs } from './make/jobs.js';
test('product references go after the step’s own pictures, with a note to keep the product as it is', () => {
  const input = { image_urls: ['start.png'], video_urls: ['ref.mp4'], prompt: 'Follow the camera.' };
  const out = withRefs(input, ['photo.jpg', 'logo.png']);
  assert.deepEqual(out.image_urls, ['start.png', 'photo.jpg', 'logo.png'], 'the start image stays first');
  assert.match(out.prompt, /^Follow the camera\.\n\n.*same shape, proportions, colours, label and logo/s);
  assert.equal(withRefs(input, []), input, 'no references: the request is unchanged');
  assert.deepEqual(input.image_urls, ['start.png'], 'the recipe input is not changed in place');
});

test('Seedance takes up to 10 s: a longer take is refused with the reason, never cut silently', async () => {
  const recipes = await loadRecipes(new URL('../recipes', import.meta.url).pathname);
  assert.equal(recipes['seedance-2.5'].maxDurationS, 10);
  const { MAX_TAKE_S } = await import('../public/shared/protocol.js');
  assert.ok(MAX_TAKE_S <= recipes['seedance-2.5'].maxDurationS, 'the phone stops before the model’s limit');
  const dir = await mkdtemp(join(tmpdir(), 'maxdur-'));
  const scene = await loadTemplate('parking-lot');
  const jobs = makeJobs({ dir, recipes, providers: {}, score: async () => ({}) });
  const long = { ...take, samples: Array.from({ length: 700 }, (_, i) => ({ ts: i * 16.67, q: [0, 0, 0, 1], p: [0, 1.6, 7] })) }; // 11.7 s
  await assert.rejects(jobs.create({ take: long, scene, look: 'night', recipeId: 'seedance-2.5' }), /11\.7 s.*up to 10 s/);
  const ok = { ...take, samples: Array.from({ length: 600 }, (_, i) => ({ ts: i * 16.67, q: [0, 0, 0, 1], p: [0, 1.6, 7] })) }; // 9.98 s
  assert.equal((await jobs.create({ take: ok, scene, look: 'night', recipeId: 'seedance-2.5' })).durationS, 10);
  await rm(dir, { recursive: true, force: true });
});
