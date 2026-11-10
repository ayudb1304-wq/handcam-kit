// Sets and takes saved to the account (DECISIONS §55), so a paying customer's work follows them to another computer.
// The browser stays the working copy (IndexedDB, public/shared/store.js); this is the copy that survives a new laptop.
// Free accounts keep everything in the browser only, as before. Rows live in Supabase (handcam_library: RLS on, no
// policies) or, without Supabase, as files under DATA_DIR/library. A deleted item leaves a marker, so another
// computer that still has it deletes it too instead of sending it back.
import express from 'express';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rateLimit } from './limits.js';

export const KINDS = ['takes', 'scenes'];
export const LIBRARY_LIMITS = Object.freeze({ items: { takes: 1000, scenes: 400 }, bytes: 3_000_000, writesPerHour: 1200 });
const ID = /^[0-9A-Za-z][0-9A-Za-z._:-]{0,99}$/;

/** A file-backed stand-in for the database, for local dev and tests: same four calls as supa.store.library. */
export function fileLibrary(dir) {
  const at = (acct, kind, id = '') => join(dir, acct, kind, id && `${encodeURIComponent(id)}.json`);
  return {
    async list(acct) {
      const out = [];
      for (const kind of KINDS) for (const f of await readdir(at(acct, kind)).catch(() => [])) {
        const row = JSON.parse(await readFile(join(at(acct, kind), f), 'utf8'));
        out.push({ kind, id: row.id, v: row.v, gone: row.data == null });
      }
      return out;
    },
    async get(acct, kind, id) { try { return JSON.parse(await readFile(at(acct, kind, id), 'utf8')).data; } catch { return null; } },
    async put(acct, kind, id, data, v) { await mkdir(at(acct, kind), { recursive: true }); await writeFile(at(acct, kind, id), JSON.stringify({ id, v, data })); },
    async remove(acct, kind, id) { await rm(at(acct, kind, id), { force: true }); },
    async clear(acct) { await rm(join(dir, acct), { recursive: true, force: true }); },
  };
}

/** store: { list(acct), get(acct, kind, id), put(acct, kind, id, data | null, v), remove(acct, kind, id), clear(acct) }. may(req) → the account that may sync, or null. */
export function makeLibrary({ store, may, limits = LIBRARY_LIMITS, now = () => Date.now() }) {
  const r = express.Router();
  const writes = rateLimit({ perHour: limits.writesPerHour });
  r.use((req, res, next) => {
    const user = may(req);
    if (!user) return res.status(403).json({ error: 'Saving sets and takes to your account comes with a paid plan.', code: 'plan' });
    req.acct = user.id;
    next();
  });
  r.param('kind', (req, res, next, kind) => (KINDS.includes(kind) ? next() : res.status(404).end()));
  r.param('id', (req, res, next, id) => (ID.test(id) ? next() : res.status(400).json({ error: 'bad id' })));

  /** What the account has: { takes: [{ id, v }], scenes: [...], gone: { takes: [ids], scenes: [ids] } } (v: when it last changed). */
  r.get('/', async (req, res) => {
    const out = { takes: [], scenes: [], gone: { takes: [], scenes: [] } };
    for (const x of await store.list(req.acct)) (x.gone ? out.gone[x.kind] : out[x.kind]).push(x.gone ? x.id : { id: x.id, v: x.v });
    res.json(out);
  });
  r.get('/:kind/:id', async (req, res) => {
    const data = await store.get(req.acct, req.params.kind, req.params.id);
    return data ? res.json(data) : res.status(404).end();
  });
  r.put('/:kind/:id', async (req, res) => {
    const { kind, id } = req.params, data = req.body;
    if (!data || typeof data !== 'object' || data.id !== id) return res.status(400).json({ error: 'the item’s id doesn’t match' });
    if (JSON.stringify(data).length > limits.bytes) return res.status(413).json({ error: 'That is too large to save to your account.' });
    if (!writes(req.acct)) return res.status(429).json({ error: 'Too many changes at once. They’ll be saved in a moment.' });
    const have = (await store.list(req.acct)).filter((x) => x.kind === kind && !x.gone);
    if (!have.some((x) => x.id === id) && have.length >= limits.items[kind]) return res.status(409).json({ error: `Your account holds ${limits.items[kind]} ${kind}. Delete some old ones to save new ones.`, code: 'full' });
    const v = now();
    await store.put(req.acct, kind, id, data, v);
    res.json({ v });
  });
  r.delete('/:kind/:id', async (req, res) => {
    const v = now();
    // ?replaced: an older version of a set that a newer one took the place of. It just goes: no marker, because another
    // computer may still have a take shot in it, and must not be told to delete it.
    if ('replaced' in req.query) await store.remove(req.acct, req.params.kind, req.params.id);
    else await store.put(req.acct, req.params.kind, req.params.id, null, v); // a marker: "this was deleted", so other computers follow
    res.json({ v });
  });
  return { routes: r, clear: (acct) => store.clear(acct), count: async (acct) => { const l = (await store.list(acct)).filter((x) => !x.gone); return { takes: l.filter((x) => x.kind === 'takes').length, sets: l.filter((x) => x.kind === 'scenes').length }; } };
}
