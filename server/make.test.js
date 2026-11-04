import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fill, pick, judge, checkRecipe, loadRecipes, badness, matchPercent } from './make/recipe.js';
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

async function practiceJob({ scores }) {
  const dir = await mkdtemp(join(tmpdir(), 'jobs-'));
  const recipes = await loadRecipes(new URL('../recipes', import.meta.url).pathname);
  let calls = 0;
  const score = async (takeJson, videos) => ({ scores: videos.map(() => scores[calls++] ?? good) });
  const jobs = makeJobs({ dir, recipes, providers: { mock: makeMock({ delay: { start: 5, video: 5 } }) }, score, pollMs: [5, 10] });
  const scene = await loadTemplate('parking-lot');
  const job = await jobs.create({ take, scene, look: 'wet parking lot at night', recipeId: 'practice' });
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
    const pub = publicJob(j, { id: 'practice' });
    assert.equal(pub.urls, undefined, 'provider URLs never reach the browser');
    assert.equal(pub.candidates[0].requestId, undefined);
  } finally { await rm(dir, { recursive: true }); }
});

test('if no version passes, one extra is made; if that fails too, the closest is kept and labelled', async () => {
  const { dir, jobs, job } = await practiceJob({ scores: [bad, bad, { ...bad, turn_rms_after_shift_deg: 20 }] });
  try {
    await jobs.start(job.id);
    await until(jobs, job.id, 'needs_approval');
    await jobs.approve(job.id, 1);
    const j = await until(jobs, job.id, 'done');
    assert.equal(j.candidates.length, 3);
    assert.equal(j.best, 3);
    assert.equal(j.outcome, 'best_effort');
  } finally { await rm(dir, { recursive: true }); }
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
