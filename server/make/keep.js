// Where a customer's videos are kept, and for how long (DECISIONS §55).
// The server's disk is the workshop: a job is made there, and its working files stay a week. The lasting copy is in
// Supabase: the job's record in handcam_videos and its files in a private storage bucket that only this server can
// read. A video whose folder has left the disk is brought back from there the first time someone opens it.
// Videos don't last for ever: free trial videos go after `trialDays`, a paid account's go `graceDays` after its plan
// ends, and the owner can delete any of them at once. Without Supabase (local dev) everything simply stays on disk.
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const KEEP_RULES = Object.freeze({ trialDays: 14, graceDays: 30, workingDays: 7 });
const DAY = 86400_000;
// what is worth keeping of a job: the videos, the move they are compared with, the approved first frame, the logo work
const KEPT = /^(video-\d+\.mp4|lock-\d+\.mp4|reference\.mp4|start-\d+\.(png|jpg)|logo\.png|locks\.json)$/;
const TYPES = { mp4: 'video/mp4', png: 'image/png', jpg: 'image/jpeg', json: 'application/json' };
const DONE = new Set(['done', 'failed', 'canceled']);

/**
 * When a video is deleted by itself, or null for never. `paid`: the owner has a plan or Lifetime right now.
 * A free trial video goes `trialDays` after it was made (upgrading in time keeps it); anything else on an account with
 * no plan goes `graceDays` after the plan ended (or after it was made, if there never was one).
 */
export function expiresAt(job, { owner = null, paid = false, admin = false, planEnded = null } = {}, rules = KEEP_RULES) {
  if (!owner || admin || paid) return null; // the founder's laptop, the founder, a paying customer
  const made = new Date(job.createdAt).getTime();
  if (job.watermark) return new Date(made + rules.trialDays * DAY).toISOString();
  return new Date(Math.max(made, planEnded ? new Date(planEnded).getTime() : 0) + rules.graceDays * DAY).toISOString();
}

/** store: supa.store (saveVideo, loadVideos, removeVideo, files.put/get/remove) or null. ownerOf(userId) → { paid, admin, planEnded } | null */
export function makeKeep({ dir, store = null, ownerOf = () => null, rules = KEEP_RULES, now = () => Date.now(), log = console }) {
  const path = (id, f = '') => join(dir, id, f);
  const files = store?.files || null;
  let records = null; // id → the job as last archived
  async function all() {
    if (records) return records;
    const m = new Map();
    if (store) { try { for (const row of await store.loadVideos()) m.set(row.id, row.data); } catch (e) { log.warn('keep: could not read the videos table:', e.message); } }
    return (records ??= m);
  }
  const expiry = (job) => expiresAt(job, { owner: job.userId, ...(job.userId ? ownerOf(job.userId) : null) }, rules);

  /** Copy a job's record and its files worth keeping to Supabase. Files already there (same size) are not sent again. */
  async function archive(job) {
    if (!store || job.provider === 'mock') return; // Practice makes grey copies of the move: nothing worth a place in storage
    try {
      const kept = { ...(job.kept || {}) };
      if (files) for (const name of await readdir(path(job.id)).catch(() => [])) {
        if (!KEPT.test(name)) continue;
        const size = (await stat(path(job.id, name))).size;
        if (kept[name] === size) continue;
        await files.put(`${job.id}/${name}`, await readFile(path(job.id, name)), TYPES[name.split('.').pop()] || 'application/octet-stream');
        kept[name] = size;
      }
      job.kept = kept;
      await store.saveVideo({ id: job.id, account_id: job.userId || null, status: job.status, created_at: job.createdAt, expires_at: expiry(job), data: job });
      (await all()).set(job.id, job);
    } catch (e) { log.warn(`keep ${job.id}:`, e.message); }
  }

  /** Is every file worth keeping in this job's folder in storage, at the size it has now? */
  async function archived(job) {
    for (const name of await readdir(path(job.id)).catch(() => [])) {
      if (KEPT.test(name) && job.kept?.[name] !== (await stat(path(job.id, name))).size) return false;
    }
    return true;
  }
  /** Is a logo being locked onto this job's video right now? (the folder is being written to) */
  async function locking(id) {
    try { return Object.values(JSON.parse(await readFile(path(id, 'locks.json'), 'utf8'))).some((l) => l?.status === 'working'); } catch { return false; }
  }

  /**
   * Bring a job's kept files back to the disk when its folder has been cleared. The folder gets its job.json too, dated
   * now, so it is an ordinary job folder again: new work on it (a logo lock) is archived and the folder cleared later.
   */
  async function restore(job) {
    if (!files || !job?.kept) return;
    const missing = Object.keys(job.kept).filter((name) => !existsSync(path(job.id, name)));
    if (!missing.length) return;
    await mkdir(path(job.id), { recursive: true });
    if (!existsSync(path(job.id, 'job.json'))) await writeFile(path(job.id, 'job.json'), JSON.stringify({ ...job, updatedAt: new Date(now()).toISOString() }, null, 2));
    for (const name of missing) {
      try { const buf = await files.get(`${job.id}/${name}`); if (buf) await writeFile(path(job.id, name), buf); }
      catch (e) { log.warn(`keep ${job.id}/${name}:`, e.message); }
    }
  }

  /** Delete a video everywhere: its files in storage, its record, its folder. */
  async function remove(job) {
    if (files && job.kept) await files.remove(Object.keys(job.kept).map((n) => `${job.id}/${n}`)).catch((e) => log.warn(`keep ${job.id}:`, e.message));
    if (store) await store.removeVideo(job.id).catch((e) => log.warn(`keep ${job.id}:`, e.message));
    (await all()).delete(job.id);
    await rm(path(job.id), { recursive: true, force: true }).catch(() => {});
  }

  return {
    archive, restore, remove, expiry, rules,
    /** For jobs.js: the archived jobs that may no longer be on the disk. */
    remote: { async get(id) { return (await all()).get(id) || null; }, async all() { return [...(await all()).values()]; } },
    /** Is the working copy still here? ("another version" needs it: the take and its measuring twin) */
    working: (job) => existsSync(path(job.id, 'measure.mp4')) && existsSync(path(job.id, 'take.json')),
    /**
     * The housekeeping, run now and then: delete videos whose time is up, and clear the folders of finished jobs older
     * than `workingDays` once their files are safely archived. loadLocal(id) → the job on disk, or null. → what it did
     */
    async sweep({ loadLocal, forget = () => {} }) {
      const out = { expired: 0, cleared: 0 }, t = now();
      const local = new Map();
      for (const id of await readdir(dir).catch(() => [])) { const j = await loadLocal(id); if (j) local.set(id, j); }
      const jobs = new Map([...(await all()), ...local]); // the disk is newer when a job is in both
      for (const job of jobs.values()) {
        const exp = expiry(job);
        if (exp && new Date(exp).getTime() <= t && DONE.has(job.status)) { await remove(job); forget(job.id); out.expired++; continue; }
        if (!local.has(job.id) || t - new Date(job.updatedAt || job.createdAt).getTime() < rules.workingDays * DAY) continue;
        // a week old and still on the disk:
        if (job.status === 'uploading' || job.status === 'needs_approval' || job.provider === 'mock') { // never finished (nothing was used), or Practice: nothing to keep
          if (!['uploading', 'needs_approval'].includes(job.status) && !DONE.has(job.status)) continue;
          await remove(job); forget(job.id); out.cleared++; continue;
        }
        if (!DONE.has(job.status) || !store || (await locking(job.id))) continue;
        await archive(job); // anything made since the last time (a logo lock), then let the folder go
        if (await archived(job)) { await rm(path(job.id), { recursive: true, force: true }).catch(() => {}); out.cleared++; } // only when every file is safely in storage
      }
      return out;
    },
  };
}
