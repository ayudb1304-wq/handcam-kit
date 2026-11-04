// HTTP routes for Make video. Laptop only for now (isLocal): these spend AI credits, and there are no accounts yet.
import express from 'express';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { checkLabTake, isLocal } from '../lab.js';
import { UPLOADS } from './jobs.js';

const MEDIA = /^(start-\d+\.(png|jpg)|video-\d+\.mp4|reference\.mp4|first-frame\.png)$/;

/** What the browser may see of a job: no provider URLs, no internal request ids. */
export function publicJob(job, recipe) {
  const { urls, log, ...rest } = job;
  return {
    ...rest,
    startImages: job.startImages.map(({ n, status, file }) => ({ n, status, file })),
    candidates: job.candidates.map(({ n, status, file, verdict, match, error, score }) => ({
      n, status, file, verdict, match, error,
      score: score && { timing_offset_s: score.timing_offset_s, turn_corr: score.turn_corr, walk_ratio: score.walk_ratio ?? null },
    })),
    log: log.slice(-12),
    recipe: recipe && { id: recipe.id, label: recipe.label, status: recipe.status, cost: recipe.cost },
  };
}

export function makeRoutes({ jobs, recipes, ready }) {
  const r = express.Router();
  r.use((req, res, next) => (isLocal(req) ? next() : res.status(403).json({ error: 'Make video works on the laptop running HandCam (http://localhost:3000/desk) for now.' })));

  /** Which recipes exist and which can run here (Higgsfield needs keys in .env). The prompts stay on the server. */
  r.get('/config', (req, res) => {
    res.json({ recipes: Object.values(recipes).map((x) => ({ id: x.id, label: x.label, status: x.status, provider: x.provider, cost: x.cost || null, candidates: x.candidates, ready: ready(x.provider) })) });
  });

  r.get('/', async (req, res) => {
    res.json({ jobs: (await jobs.list()).map((j) => publicJob(j, recipes[j.recipeId])) });
  });

  r.post('/', async (req, res) => {
    const { take, scene, look, recipeId, demo } = req.body || {};
    const errors = checkLabTake({ take: { ...take, label: undefined }, scene });
    if (errors.length) return res.status(400).json({ error: errors.slice(0, 2).join('; ') });
    const recipe = recipes[recipeId];
    if (recipe && !ready(recipe.provider)) return res.status(400).json({ error: `${recipe.label} isn’t set up on this computer yet.` });
    try { res.json({ job: publicJob(await jobs.create({ take, scene, look, recipeId, demo }), recipe), uploads: Object.keys(UPLOADS) }); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  r.put('/:id/files/:name', express.raw({ type: '*/*', limit: '200mb' }), async (req, res) => {
    const job = await jobs.load(req.params.id);
    if (!job || job.status !== 'uploading') return res.status(404).json({ error: 'no such job waiting for files' });
    if (!(req.params.name in UPLOADS) || !req.body?.length) return res.status(400).json({ error: 'unexpected file' });
    await writeFile(jobs.path(job.id, req.params.name), req.body);
    res.json({ ok: true });
  });

  const step = (fn) => async (req, res) => {
    const job = await fn(req);
    if (!job) return res.status(404).json({ error: 'no such job' });
    res.json({ job: publicJob(job, recipes[job.recipeId]) });
  };
  r.post('/:id/start', step((req) => jobs.start(req.params.id)));
  r.post('/:id/redo-start', step((req) => jobs.redoStart(req.params.id, req.body?.look)));
  r.post('/:id/approve', step((req) => jobs.approve(req.params.id, Number(req.body?.n))));
  r.post('/:id/more', step((req) => jobs.more(req.params.id)));
  r.get('/:id', step((req) => jobs.load(req.params.id)));

  r.get('/:id/media/:file', async (req, res) => {
    if (!MEDIA.test(req.params.file)) return res.status(404).end();
    const job = await jobs.load(req.params.id);
    const file = job && jobs.path(job.id, req.params.file);
    if (!file || !existsSync(file)) return res.status(404).end();
    res.sendFile(file); // supports Range requests, which Safari needs to play video
  });
  return r;
}
