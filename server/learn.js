// The record the recipe is refined from (DECISIONS §53): one row for every AI version ever made, with what went in
// (which recipe wording, what kind of move, which reference pictures) and what came out (the move-match numbers, why it
// failed, whether it was the one kept). Nothing here is shown to customers. It is the product's memory: a change to a
// recipe gets a new hash by itself, so two wordings can be compared on real videos instead of by feel.
// Rows go to Supabase when it is set up (handcam_generations) and always to DATA_DIR/generations.jsonl.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { measureMove } from '../public/shared/describe.js';

/** A short id for the parts of a recipe that decide the result: change a prompt or an endpoint and it changes. */
export function recipeHash(recipe) {
  const { startImage, setLook = null, video, refsNote = null } = recipe || {};
  return createHash('sha256').update(JSON.stringify({ startImage, setLook, video, refsNote })).digest('hex').slice(0, 12);
}

const round = (x, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
/** The move in a few numbers and one word, so results can be compared by kind of shot. */
export function moveOf(take) {
  if (!take?.samples?.length) return null;
  const m = measureMove(take.samples);
  const kind = m.fastest > 150 && m.turnRange > 25 ? 'whip' : Math.abs(m.side) > 1.5 && Math.abs(m.turn) > 40 ? 'arc'
    : m.forward > 0.8 ? 'push-in' : m.forward < -0.8 ? 'pull-back' : Math.abs(m.turn) > 20 ? 'pan' : Math.abs(m.side) > 1 ? 'sideways'
    : Math.abs(m.up) > 0.4 ? 'rise-lower' : m.zoom > 1.25 || m.zoom < 0.8 ? 'zoom' : 'still';
  return { kind, seconds: round(m.seconds, 1), turn: round(m.turn, 0), fastest: round(m.fastest, 0), forward: round(m.forward), side: round(m.side), up: round(m.up), tilt: round(m.tilt, 0), zoom: round(m.zoom), rig: take.rig || null, frame: take.frame || null, shot: take.label || null };
}

/**
 * The rows of one job: one per version made (or tried), or a single row for a job that ended before any version
 * (cancelled at the first frame, or failed while preparing): those say the first-frame step is where it went wrong.
 */
export function rowsOf(job, recipe, take) {
  const refs = job.refs ? Object.keys(job.urls || {}).filter((n) => n.startsWith('ref-')) : [];
  const base = {
    job_id: job.id, account_id: job.userId || null, created_at: job.createdAt,
    recipe_id: job.recipeId, recipe_hash: recipeHash(recipe), provider: job.provider, model: recipe?.video?.endpoint || null,
    resolution: job.resolution || null, duration_s: job.durationS ?? null, aspect: job.aspect || null, byok: !!job.byok,
    has_look: refs.includes('ref-look.jpg'), has_subject: refs.includes('ref-subject.jpg'), has_logo: refs.includes('ref-logo.png'),
    first_frames: (job.startImages || []).length, look: job.look || null, move: moveOf(take),
  };
  const made = (job.candidates || []).map((c) => ({
    ...base, id: `${job.id}-${c.n}`, n: c.n,
    status: c.file ? 'made' : 'failed', error: c.error || null,
    match: c.match ?? null, pass: c.verdict?.pass ?? null, reasons: c.verdict?.reasons || [], score: c.score || null,
    free: !!c.free, kept: c.n === job.best,
  }));
  if (made.length) return made;
  if (!['failed', 'canceled'].includes(job.status)) return [];
  return [{ ...base, id: `${job.id}-0`, n: 0, status: job.status, error: job.error || null, match: null, pass: null, reasons: [], score: null, free: false, kept: false }];
}

const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
/** Numbers per recipe wording and per kind of move: where the recipe works and where it doesn't. */
export function summarise(all) {
  const rows = all.filter((r) => r.provider !== 'mock'); // Practice makes nothing: it says nothing about the recipe
  const group = (key) => {
    const out = {};
    for (const r of rows) {
      const k = key(r); if (k == null) continue;
      const g = (out[k] ||= { versions: 0, failed: 0, passed: 0, under70: 0, matches: [], reasons: {}, jobs: new Set(), frames: 0, cancelled: 0 });
      if (!g.jobs.has(r.job_id)) { g.jobs.add(r.job_id); g.frames += r.first_frames || 0; }
      if (r.n === 0) { if (r.status === 'canceled') g.cancelled++; else g.failed++; continue; }
      g.versions++;
      if (r.status === 'failed') g.failed++;
      if (r.pass === true) g.passed++;
      if (r.match != null) { g.matches.push(r.match); if (r.match < 70) g.under70++; }
      for (const why of r.reasons || []) g.reasons[why] = (g.reasons[why] || 0) + 1;
      if (r.error) g.reasons[r.error] = (g.reasons[r.error] || 0) + 1;
    }
    return Object.fromEntries(Object.entries(out).map(([k, g]) => [k, {
      videos: g.jobs.size, versions: g.versions, failed: g.failed, cancelledAtFirstFrame: g.cancelled,
      passRate: g.matches.length ? round(g.passed / g.matches.length) : null, under70Rate: g.matches.length ? round(g.under70 / g.matches.length) : null,
      medianMatch: median(g.matches), firstFramesPerVideo: g.jobs.size ? round(g.frames / g.jobs.size, 1) : null,
      topReasons: Object.entries(g.reasons).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([why, n]) => ({ why, n })),
    }]));
  };
  return {
    rows: rows.length,
    byRecipe: group((r) => `${r.recipe_id}@${r.recipe_hash}`),
    byMove: group((r) => r.move?.kind),
    bySetLook: group((r) => (r.has_look ? 'with the set look' : 'without')),
  };
}

/** store: { saveGenerations(rows), loadGenerations() } from supa.js, or null. readTake(job) → the job's take, or null. */
export function makeLearn({ dir, store = null, recipes, readTake, log = console }) {
  const file = join(dir, 'generations.jsonl');
  async function fromFile() {
    const text = await readFile(file, 'utf8').catch(() => '');
    const byId = new Map();
    for (const line of text.split('\n')) { if (!line) continue; try { const r = JSON.parse(line); byId.set(r.id, r); } catch { /* a torn line */ } }
    return [...byId.values()]; // a version recorded twice (settled again after "one more") keeps its last state
  }
  return {
    /** Record what a job's versions did. Never throws into the job. */
    async record(job) {
      try {
        const rows = rowsOf(job, recipes[job.recipeId], await readTake(job).catch(() => null));
        if (!rows.length) return;
        await mkdir(dir, { recursive: true });
        await appendFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
        if (store) await store.saveGenerations(rows);
      } catch (e) { log.warn(`learn ${job.id}:`, e.message); }
    },
    /** Everything recorded: from the database when there is one (it survives a new disk), else the file. */
    async rows() {
      if (store) { try { return await store.loadGenerations(); } catch (e) { log.warn('learn: reading the database failed, using the file:', e.message); } }
      return fromFile();
    },
    async summary() { return summarise(await this.rows()); },
  };
}
