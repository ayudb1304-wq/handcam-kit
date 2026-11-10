import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
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
  const r = await loadRecipes(fileURLToPath(new URL('../recipes', import.meta.url)));
  assert.ok(r.practice && r['seedance-2.5']);
  for (const x of Object.values(r)) assert.deepEqual(checkRecipe(x), []);
  assert.ok(checkRecipe({ id: 'x', provider: 'nope' }).length);
});

async function practiceJob({ scores, versions }) {
  const dir = await mkdtemp(join(tmpdir(), 'jobs-'));
  const recipes = await loadRecipes(fileURLToPath(new URL('../recipes', import.meta.url)));
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
  const recipes = await loadRecipes(fileURLToPath(new URL('../recipes', import.meta.url)));
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
    const recipes = await loadRecipes(fileURLToPath(new URL('../recipes', import.meta.url)));
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
  const recipes = await loadRecipes(fileURLToPath(new URL('../recipes', import.meta.url)));
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

test('customer Make video: trial videos are spent and watermarked, every trial version counts; running out says so before anything is made', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pay-make-'));
  const pricing = loadPricing(fileURLToPath(new URL('../config/pricing.json', import.meta.url)));
  const recipes = await loadRecipes(fileURLToPath(new URL('../recipes', import.meta.url)));
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
  app.use('/api/make', makeRoutes({ jobs, recipes, ready: () => true, accounts, pricing, chargePractice: true, watermark: async (src, out) => { marked.push(src); await writeFile(out, 'wm'); } }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/make`;
  try {
    const { user: u } = await accounts.fromAuth({ authId: 'g-t', email: 't@x.co' });
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
    assert.equal(accounts.get(u.id).trial, 0, 'on the free trial a version under 70% still counts: two videos are two tries');
    assert.deepEqual([j.candidates[0].free, j.billing.charged, j.billing.tryAgain], [false, 2, false]);
    const pub = (await call(`/${id}`, undefined, 'GET')).body.job;
    assert.deepEqual(pub.candidates.map((c) => c.file), ['wm-1.mp4', 'wm-2.mp4'], 'trial videos: the watermarked copies, both playable');
    assert.equal((await fetch(`${base}/${id}/media/video-2.mp4`, { headers })).status, 403, 'never the clean file');
    const [one, two] = await Promise.all([fetch(`${base}/${id}/media/wm-2.mp4`, { headers }), fetch(`${base}/${id}/media/wm-2.mp4`, { headers })]);
    assert.deepEqual([one.status, two.status], [200, 200]);
    assert.equal(marked.length, 1, 'two requests at once share one watermark run');
    const more = await call(`/${id}/more`);
    assert.deepEqual([more.status, more.body.code], [402, 'balance'], 'no third try on the free trial');
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
  const recipes = await loadRecipes(fileURLToPath(new URL('../recipes', import.meta.url)));
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

import { rateLimit, networkOf } from './limits.js';
test('limits: a window takes n at once or nothing; an IPv6 address counts as its /64', () => {
  const take = rateLimit({ max: 3, windowMs: 60_000 });
  assert.deepEqual([take('a', 2), take('a', 2), take('a'), take('a'), take('b', 3)], [true, false, true, false, true]);
  assert.equal(networkOf('203.0.113.7'), '203.0.113.7');
  assert.equal(networkOf('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(networkOf('2001:0db8:85a3:0001:aaaa:bbbb:cccc:dddd'), networkOf('2001:db8:85a3:1::42'));
  assert.notEqual(networkOf('2001:db8:85a3:1::42'), networkOf('2001:db8:85a3:2::42'));
});

test('a paying customer: a free (under 70%) version plays as a watermarked copy, never the clean file; first frames and versions on our key are capped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'caps-'));
  const pricing = loadPricing(fileURLToPath(new URL('../config/pricing.json', import.meta.url)));
  const all = await loadRecipes(fileURLToPath(new URL('../recipes', import.meta.url)));
  // "ai": the practice recipe on a provider that isn't called mock, so it counts as our AI key
  const recipes = { ...all, ai: { ...all.practice, id: 'ai', provider: 'fake' } };
  const accounts = await makeAccounts({ dir: join(dir, 'acct'), pricing });
  let calls = 0;
  const jobs = makeJobs({
    dir: join(dir, 'jobs'), recipes, providers: { fake: makeMock({ delay: { start: 5, video: 5 } }) }, pollMs: [5, 10],
    score: async (t, videos) => ({ scores: videos.map(() => [bad, good][calls++] ?? bad) }),
    onSettle: async (job) => { const back = refundDue(job); if (back > 0) { await accounts.refund(job.userId, job.charge.from, back); job.charge.refunded += back; } },
  });
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/make', makeRoutes({ jobs, recipes, ready: () => true, accounts, pricing, realAiForCustomers: true, watermark: async (src, out) => { await writeFile(out, 'wm'); },
    limits: { jobsPerHour: 30, startsPerJob: 2, startsPerDay: { free: 6, paid: 3 }, versionsPerDay: { free: 6, paid: 3 } } }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/make`;
  try {
    const { user: u } = await accounts.fromAuth({ authId: 'g-pay', email: 'pay@x.co' });
    await accounts.syncSubscription(u.id, { id: 'sub_1', plan: 'creator', interval: 'month', status: 'active', paidThrough: '2099-01-01T00:00:00.000Z', startedAt: new Date().toISOString() });
    const headers = { cookie: accounts.cookieFor(u, { secure: false }).split(';')[0], 'x-forwarded-for': '1.2.3.4', 'content-type': 'application/json' };
    const call = async (path, body, method = 'POST') => { const r = await fetch(`${base}${path}`, { method, headers, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    const scene = await loadTemplate('parking-lot');
    const begin = async () => {
      const made = await call('/', { take, scene, look: 'wet night', recipeId: 'ai', versions: 2 });
      assert.equal(made.status, 200);
      for (const f of ['reference.mp4', 'measure.mp4', 'first-frame.png']) await writeFile(jobs.path(made.body.job.id, f), f);
      return made.body.job.id;
    };
    const id = await begin();
    assert.equal((await call(`/${id}/start`)).status, 200);
    await until(jobs, id, 'needs_approval');
    assert.equal((await call(`/${id}/redo-start`, { look: 'dry night' })).status, 200);
    for (let i = 0; i < 200; i++) { const x = await jobs.load(id); if (x?.status === 'needs_approval' && x.startImages.length === 2) break; await new Promise((r) => setTimeout(r, 10)); }
    assert.deepEqual([(await call(`/${id}/redo-start`, {})).status, (await jobs.load(id)).startImages.length], [429, 2], 'first frames per video are capped');
    assert.equal((await call(`/${id}/approve`, { n: 1, versions: 2 })).status, 200);
    const settled = () => new Promise((r) => setTimeout(r, 150)); // the refund is written just after 'done'
    const j = await until(jobs, id, 'done');
    await settled();
    assert.deepEqual([j.candidates[0].free, j.candidates[1].free, j.watermark], [true, false, undefined]);
    assert.equal(accounts.pub(accounts.get(u.id)).videos.left, 14, 'a plan still pays only for the version that followed');
    const pub = (await call(`/${id}`, undefined, 'GET')).body.job;
    assert.deepEqual(pub.candidates.map((c) => [c.file, c.preview]), [['wm-1.mp4', true], ['video-2.mp4', false]], 'the free version is a video to watch; the paid one is theirs');
    assert.equal((await fetch(`${base}/${id}/media/wm-1.mp4`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/${id}/media/video-1.mp4`, { headers })).status, 403, 'never the clean file of a free version');
    assert.equal((await fetch(`${base}/${id}/media/video-2.mp4`, { headers })).status, 200);
    // the day's caps: 3 versions (2 made), 3 first frames (2 made)
    assert.equal((await call(`/${id}/more`)).status, 200);
    await settled();
    await until(jobs, id, 'done');
    await settled();
    const over = await call(`/${id}/more`);
    assert.deepEqual([over.status, over.body.code], [429, 'limit'], 'versions on our key per day are capped, free ones included');
    const id2 = await begin();
    assert.equal((await call(`/${id2}/start`)).status, 200);
    const id3 = await begin();
    assert.equal((await call(`/${id3}/start`)).status, 429, 'first frames per day are capped');
    assert.equal((await jobs.load(id3)).status, 'uploading', 'and nothing was sent to the AI');
    await until(jobs, id2, 'needs_approval');
    await settled();
  } finally { server.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

import { refsNote, REF_UPLOADS } from './make/jobs.js';
import { readdir } from 'node:fs/promises';
test('the look of a set: sent first among the references, with its own note; made by POST /look and never kept on the server', async () => {
  assert.equal(Object.keys(REF_UPLOADS)[0], 'ref-look.jpg', 'the look goes right after the step’s own picture');
  assert.match(refsNote(['ref-look.jpg']), /^The first extra reference image is a wide view of the whole place/);
  assert.match(refsNote(['ref-look.jpg', 'ref-subject.jpg']), /Do not invent a different place\. The other extra reference images show the real product/);
  assert.match(refsNote(['ref-subject.jpg', 'ref-logo.png']), /^The extra reference images show the real product/);
  assert.equal(refsNote(['ref-look.jpg', 'ref-logo.png'], 'KEEP IT').endsWith('KEEP IT'), true, 'a recipe’s own product note is used');

  const dir = await mkdtemp(join(tmpdir(), 'look-'));
  const pricing = loadPricing(fileURLToPath(new URL('../config/pricing.json', import.meta.url)));
  const recipes = await loadRecipes(fileURLToPath(new URL('../recipes', import.meta.url)));
  const accounts = await makeAccounts({ dir: join(dir, 'acct'), pricing });
  const sent = [], mock = makeMock({ delay: { start: 5, video: 5 } });
  const spy = { ...mock, submit: (endpoint, input, key) => { sent.push({ endpoint, input }); return mock.submit(endpoint, input, key); } };
  const jobs = makeJobs({ dir: join(dir, 'jobs'), recipes, providers: { mock: spy }, pollMs: [5, 10], score: async (t, videos) => ({ scores: videos.map(() => good) }) });
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/make', makeRoutes({ jobs, recipes, ready: () => true, accounts, pricing }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/make`;
  try {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('a grey wide view')]);
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('the product')]);
    const body = { recipeId: 'practice', look: 'Himalayan valley, morning', wide: { data: png.toString('base64') }, subject: { data: jpg.toString('base64') } };
    const post = (b, headers = {}) => fetch(`${base}/look`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(b) });
    // the founder's laptop: the picture comes straight back (Practice hands back the grey view)
    const ok = await post(body);
    assert.equal(ok.status, 200);
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), png);
    assert.deepEqual(sent.at(-1).input.image_urls.length, 2, 'the grey wide view, then the product photo');
    assert.match(sent.at(-1).input.prompt, /Himalayan valley, morning[\s\S]*show the real product/);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(await readdir(join(dir, 'looks')), [], 'nothing is kept on the server');
    assert.equal((await post({ ...body, look: 'x' })).status, 400, 'needs words');
    assert.equal((await post({ ...body, wide: { data: jpg.toString('base64') } })).status, 400, 'the wide view must be a PNG');
    // a customer: closed until it is tested (REFS_FOR_CUSTOMERS)
    const { user: u } = await accounts.fromAuth({ authId: 'g-look', email: 'look@x.co' });
    const cookie = accounts.cookieFor(u, { secure: false }).split(';')[0];
    assert.equal((await post(body, { cookie, 'x-forwarded-for': '1.2.3.4' })).status, 403);

    // a video made with the look: it is the first reference of the first frame AND of the video
    const scene = await loadTemplate('parking-lot');
    const job = await jobs.create({ take, scene, look: 'wet night', recipeId: 'practice', versions: 1, refs: true });
    for (const f of ['reference.mp4', 'measure.mp4', 'first-frame.png', 'ref-look.jpg', 'ref-subject.jpg']) await writeFile(jobs.path(job.id, f), f);
    await jobs.start(job.id);
    await until(jobs, job.id, 'needs_approval');
    const first = sent.at(-1).input;
    assert.deepEqual(first.image_urls.map((u) => u.split(/[\\/]/).pop()), ['first-frame.png', 'ref-look.jpg', 'ref-subject.jpg']);
    assert.match(first.prompt, /wide view of the whole place[\s\S]*The other extra reference images show the real product/);
    await jobs.approve(job.id, 1);
    await until(jobs, job.id, 'done');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(sent.at(-1).endpoint, 'mock/video');
    assert.deepEqual(sent.at(-1).input.image_urls.map((u) => u.split(/[\\/]/).pop()), ['first-frame.png', 'ref-look.jpg', 'ref-subject.jpg'], 'Practice’s first frame is the grey one; the look and product follow it');
  } finally { server.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('cancel: only while the first frame waits for an OK; nothing is taken, and a cancelled video can’t be approved', async () => {
  const { dir, jobs, job } = await practiceJob({ scores: [good, good], versions: 2 });
  try {
    assert.equal((await jobs.cancel(job.id)).status, 'uploading', 'not before there is a first frame');
    await jobs.start(job.id);
    await until(jobs, job.id, 'needs_approval');
    assert.equal((await jobs.cancel(job.id)).status, 'canceled');
    assert.equal((await jobs.approve(job.id, 1)).status, 'canceled', 'approve does nothing now');
    assert.equal((await jobs.load(job.id)).candidates.length, 0, 'no video was made');
    assert.equal((await jobs.cancel(job.id)).status, 'canceled');
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('a person’s videos are theirs however many others have made: the list is by owner, not the newest 50 of everyone', async () => {
  const { dir, jobs } = await practiceJob({ scores: [good], versions: 1 });
  try {
    const scene = await loadTemplate('parking-lot');
    const mine = await jobs.create({ take, scene, look: 'my old video', recipeId: 'practice', userId: 'me' });
    for (let i = 0; i < 4; i++) await jobs.create({ take, scene, look: `someone else ${i}`, recipeId: 'practice', userId: 'them' });
    assert.deepEqual((await jobs.list({ owners: ['me'] })).map((j) => j.id), [mine.id]);
    assert.equal((await jobs.list({ owners: ['them'], limit: 2 })).length, 2);
    assert.equal((await jobs.list()).length, 6, 'housekeeping sees everything (5 here + the helper’s own)');
    assert.deepEqual((await jobs.list({ owners: [null] })).length, 1, 'the laptop’s own, made with no account');
    assert.equal((await jobs.list({ owners: ['nobody'] })).length, 0);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

import { rowsOf, recipeHash, summarise, moveOf, makeLearn } from './learn.js';
test('the recipe’s memory: one row per version with the move, the references and the result; a changed prompt is a new recipe hash', async () => {
  const recipes = await loadRecipes(fileURLToPath(new URL('../recipes', import.meta.url)));
  const r = recipes['seedance-2.5'];
  assert.match(recipeHash(r), /^[0-9a-f]{12}$/);
  assert.notEqual(recipeHash(r), recipeHash({ ...r, video: { ...r.video, input: { ...r.video.input, prompt: 'other words' } } }), 'a new wording is a new version');
  assert.equal(recipeHash(r), recipeHash({ ...r, label: 'renamed', cost: {} }), 'the name and the price are not the recipe');
  assert.equal(moveOf(take).seconds > 0, true);
  const job = { id: 'j1', createdAt: '2026-11-10T00:00:00Z', recipeId: 'seedance-2.5', provider: 'higgsfield', userId: 'u1', resolution: '480p', durationS: 6, aspect: '16:9', look: 'night', refs: true,
    urls: { 'ref-look.jpg': 'x', 'first-frame.png': 'y' }, startImages: [{ n: 1 }, { n: 2 }], best: 2, status: 'done',
    candidates: [{ n: 1, file: 'video-1.mp4', match: 55, free: true, verdict: { pass: false, reasons: ['turns don’t match your move'] }, score: bad },
      { n: 2, file: 'video-2.mp4', match: 91, verdict: { pass: true, reasons: [] }, score: good }, { n: 3, file: null, error: 'blocked by content filter' }] };
  const rows = rowsOf(job, r, take);
  assert.deepEqual(rows.map((x) => [x.id, x.status, x.match, x.kept, x.has_look, x.has_subject, x.first_frames]), [['j1-1', 'made', 55, false, true, false, 2], ['j1-2', 'made', 91, true, true, false, 2], ['j1-3', 'failed', null, false, true, false, 2]]);
  assert.equal(rows[0].recipe_hash, recipeHash(r));
  // a video cancelled at the first frame is one row that says so; an unfinished one is nothing yet
  assert.deepEqual(rowsOf({ ...job, id: 'j2', candidates: [], status: 'canceled' }, r, take).map((x) => [x.id, x.status]), [['j2-0', 'canceled']]);
  assert.deepEqual(rowsOf({ ...job, id: 'j3', candidates: [], status: 'needs_approval' }, r, take), []);
  const sum = summarise([...rows, ...rowsOf({ ...job, id: 'j2', candidates: [], status: 'canceled' }, r, take), { ...rows[1], id: 'p-1', provider: 'mock' }]);
  const g = Object.values(sum.byRecipe)[0];
  assert.deepEqual([sum.rows, g.videos, g.versions, g.failed, g.cancelledAtFirstFrame, g.passRate, g.under70Rate, g.medianMatch], [4, 2, 3, 1, 1, 0.5, 0.5, 91]);
  assert.equal(g.topReasons.length, 2);
  assert.ok(sum.bySetLook['with the set look']);
  // kept in a file when there is no database; the same version recorded twice counts once
  const dir = await mkdtemp(join(tmpdir(), 'learn-'));
  try {
    const learn = makeLearn({ dir, recipes, readTake: async () => take, log: { warn() {} } });
    await learn.record(job); await learn.record(job);
    assert.equal((await learn.rows()).length, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

import { makeKeep, expiresAt } from './make/keep.js';
import { existsSync } from 'node:fs';
test('keeping videos: trial videos go after 14 days, a paid account’s 30 days after its plan ends; archived files come back when the folder is gone; delete removes everything', async () => {
  const made = '2026-11-01T00:00:00.000Z', job0 = { id: '2026-11-01-aaaaaaaa', createdAt: made, userId: 'u1', status: 'done' };
  assert.equal(expiresAt({ ...job0, userId: null }), null, 'the founder’s laptop');
  assert.equal(expiresAt({ ...job0, watermark: true }, { owner: 'u1' }), '2026-11-15T00:00:00.000Z', 'a free trial video');
  assert.equal(expiresAt({ ...job0, watermark: true }, { owner: 'u1', paid: true }), null, 'upgraded in time: kept');
  assert.equal(expiresAt(job0, { owner: 'u1', paid: true }), null, 'a paying customer');
  assert.equal(expiresAt(job0, { owner: 'u1', planEnded: '2026-12-01T00:00:00.000Z' }), '2026-12-31T00:00:00.000Z', '30 days after the plan ended');
  assert.equal(expiresAt(job0, { owner: 'u1', admin: true }), null);

  const dir = await mkdtemp(join(tmpdir(), 'keep-'));
  try {
    const bucket = new Map(), table = new Map();
    const store = {
      async saveVideo(row) { table.set(row.id, JSON.parse(JSON.stringify(row))); }, async loadVideos() { return [...table.values()].map(({ id, data }) => ({ id, data })); }, async removeVideo(id) { table.delete(id); },
      files: { async put(k, buf) { bucket.set(k, Buffer.from(buf)); }, async get(k) { return bucket.get(k) || null; }, async remove(keys) { for (const k of keys) bucket.delete(k); } },
    };
    const owners = { u1: { paid: false }, u2: { paid: true } };
    let clock = new Date('2026-11-02T00:00:00Z').getTime();
    const keep = makeKeep({ dir, store, ownerOf: (id) => owners[id], now: () => clock, log: { warn() {} } });
    const write = async (job, names) => { await mkdir(join(dir, job.id), { recursive: true }); await writeFile(join(dir, job.id, 'job.json'), JSON.stringify(job)); for (const n of names) await writeFile(join(dir, job.id, n), n); };
    const loadLocal = async (id) => { try { return JSON.parse(await readFile(join(dir, id, 'job.json'), 'utf8')); } catch { return null; } };
    const trial = { ...job0, watermark: true, updatedAt: made }, paid = { ...job0, id: '2026-11-01-bbbbbbbb', userId: 'u2', updatedAt: made };
    for (const j of [trial, paid]) { await write(j, ['video-1.mp4', 'reference.mp4', 'start-1.png', 'measure.mp4', 'take.json']); await keep.archive(j); }
    assert.deepEqual([...bucket.keys()].filter((k) => k.startsWith(trial.id)).sort(), [`${trial.id}/reference.mp4`, `${trial.id}/start-1.png`, `${trial.id}/video-1.mp4`], 'the videos and the move, not the working files');
    assert.equal(table.get(trial.id).expires_at, '2026-11-15T00:00:00.000Z');
    assert.equal(table.get(paid.id).expires_at, null);
    assert.equal(keep.working(trial), true);
    // a week on: the working folders are cleared, the videos stay
    clock = new Date('2026-11-09T00:00:01Z').getTime();
    assert.deepEqual(await keep.sweep({ loadLocal }), { expired: 0, cleared: 2 });
    assert.equal(existsSync(join(dir, paid.id)), false);
    assert.equal(keep.working(paid), false, 'another version needs the working files');
    const back = await keep.remote.get(paid.id);
    await keep.restore(back);
    assert.equal(await readFile(join(dir, paid.id, 'video-1.mp4'), 'utf8'), 'video-1.mp4', 'opened again: back from the archive');
    assert.equal(existsSync(join(dir, paid.id, 'measure.mp4')), false);
    // day 15: the trial video is deleted everywhere; the paying customer's is not
    clock = new Date('2026-11-15T00:00:01Z').getTime();
    const forgot = [];
    assert.equal((await keep.sweep({ loadLocal, forget: (id) => forgot.push(id) })).expired, 1);
    assert.deepEqual([forgot, table.has(trial.id), [...bucket.keys()].some((k) => k.startsWith(trial.id)), table.has(paid.id)], [[trial.id], false, false, true]);
    // the owner deletes one
    await keep.remove(await keep.remote.get(paid.id));
    assert.deepEqual([table.size, bucket.size, existsSync(join(dir, paid.id))], [0, 0, false]);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

import { makeLibrary, fileLibrary } from './library.js';
test('sets and takes saved to the account: paid plans only, each account its own, and a delete leaves a marker for other computers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lib-'));
  let clock = 1000;
  const lib = makeLibrary({ store: fileLibrary(dir), may: (req) => (req.headers['x-acct'] ? { id: req.headers['x-acct'] } : null), now: () => clock++, limits: { items: { takes: 2, scenes: 2 }, bytes: 2000, writesPerHour: 100 } });
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/library', lib.routes);
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/library`;
  const call = async (acct, method, path, body) => { const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(acct && { 'x-acct': acct }) }, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  try {
    assert.equal((await call(null, 'GET', '')).status, 403, 'a free account keeps its work in the browser');
    assert.equal((await call('a', 'PUT', '/takes/t1', { id: 't1', samples: [1, 2] })).status, 200);
    assert.equal((await call('a', 'PUT', '/takes/t1', { id: 'other' })).status, 400);
    assert.equal((await call('a', 'PUT', '/scenes/s1', { id: 's1', objects: [] })).status, 200);
    assert.equal((await call('a', 'PUT', '/takes/big', { id: 'big', pad: 'x'.repeat(3000) })).status, 413);
    const mine = (await call('a', 'GET', '')).body;
    assert.deepEqual([mine.takes.map((x) => x.id), mine.scenes.map((x) => x.id), mine.gone], [['t1'], ['s1'], { takes: [], scenes: [] }]);
    assert.deepEqual((await call('a', 'GET', '/takes/t1')).body, { id: 't1', samples: [1, 2] });
    assert.deepEqual((await call('b', 'GET', '')).body.takes, [], 'another account sees none of it');
    assert.equal((await call('b', 'GET', '/takes/t1')).status, 404);
    assert.equal((await call('a', 'PUT', '/takes/t2', { id: 't2' })).status, 200);
    assert.deepEqual([(await call('a', 'PUT', '/takes/t3', { id: 't3' })).status, (await call('a', 'PUT', '/takes/t2', { id: 't2', star: true })).status], [409, 200], 'full for new ones; a change to one it has still saves');
    await call('a', 'DELETE', '/takes/t1');
    const after = (await call('a', 'GET', '')).body;
    assert.deepEqual([after.takes.map((x) => x.id), after.gone.takes], [['t2'], ['t1']]);
    assert.equal((await call('a', 'GET', '/takes/t1')).status, 404);
    assert.deepEqual(await lib.count('a'), { takes: 1, sets: 1 });
    await lib.clear('a');
    assert.deepEqual((await call('a', 'GET', '')).body.takes, []);
    assert.equal((await call('a', 'GET', '/nope/x')).status, 404);
  } finally { server.close(); await rm(dir, { recursive: true, force: true }); }
});
