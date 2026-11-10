// Plain IndexedDB, no library. Each page has its own copy (phone and laptop are different browsers).
// takes: keyed by take.id. scenes: keyed by scene.id, so a take can be replayed in the set it was shot in.
const DB = 'handcam', VERSION = 1, STORES = ['takes', 'scenes'];
let opening;

function db() {
  return opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => { for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' }); };
    req.onsuccess = () => {
      // a newer page (after an update) needs to upgrade the database: let go so it isn't stuck waiting on this tab
      req.result.onversionchange = () => { req.result.close(); opening = null; };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => console.warn('CineHand: another open CineHand tab is using an older version; close it or reload it.');
  });
}

async function run(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const putTake = (take) => run('takes', 'readwrite', s => s.put(take)).then((r) => { push('takes', take); return r; });
/** All takes, newest first (ids start with an ISO timestamp). */
export const allTakes = async () => (await run('takes', 'readonly', s => s.getAll())).sort((a, b) => b.id.localeCompare(a.id));
export const deleteTake = (id) => run('takes', 'readwrite', s => s.delete(id)).then((r) => { drop('takes', id); return r; });
export const putScene = (scene) => run('scenes', 'readwrite', s => s.put(scene)).then((r) => { push('scenes', scene); return r; });
export const getScene = (id) => run('scenes', 'readonly', s => s.get(id));

// ---- saved to the account too, on paid plans (server/library.js). The browser stays the working copy: nothing here
// ever blocks or fails a save. Off until syncLibrary() says the account may. ----
let syncing = false;
const timers = new Map();
const seen = { get() { try { return JSON.parse(localStorage.getItem('handcam.sync') || '{}'); } catch { return {}; } }, set(k, v) { try { const m = this.get(); if (v == null) delete m[k]; else m[k] = v; localStorage.setItem('handcam.sync', JSON.stringify(m)); } catch {} } };
const url = (kind, id) => `/api/library/${kind}/${encodeURIComponent(id)}`;
/** Send an item to the account a moment after its last change (a set changes many times while it is being arranged). */
function push(kind, item) {
  if (!syncing || !item?.id || item.demo || String(item.id).startsWith('demo-')) return; // the example take and its set are everyone's
  clearTimeout(timers.get(`${kind}:${item.id}`));
  timers.set(`${kind}:${item.id}`, setTimeout(async () => {
    try {
      const { labSent, ...clean } = item;
      const r = await fetch(url(kind, item.id), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(clean) });
      if (r.ok) seen.set(`${kind}:${item.id}`, (await r.json()).v);
    } catch { /* offline: it goes up at the next sync */ }
  }, 1500));
}
function drop(kind, id) {
  if (!syncing) return;
  clearTimeout(timers.get(`${kind}:${id}`));
  seen.set(`${kind}:${id}`, null);
  fetch(url(kind, id), { method: 'DELETE' }).catch(() => {});
}
/**
 * Bring this browser and the account in line, once, when the studio opens: fetch what is new or changed in the
 * account, delete what was deleted on another computer, send up what only this browser has. → true when syncing is on.
 */
export async function syncLibrary() {
  let remote;
  try { const r = await fetch('/api/library'); if (!r.ok) return false; remote = await r.json(); } catch { return false; }
  const known = seen.get();
  for (const kind of ['scenes', 'takes']) { // sets first: a take is replayed in its set
    const local = new Map((await run(kind, 'readonly', (s) => s.getAll())).map((x) => [x.id, x]));
    for (const id of remote.gone[kind]) if (local.has(id)) { await run(kind, 'readwrite', (s) => s.delete(id)); local.delete(id); seen.set(`${kind}:${id}`, null); }
    const there = new Set(remote[kind].map((x) => x.id));
    for (const { id, v } of remote[kind]) {
      if (local.has(id) && known[`${kind}:${id}`] >= v) continue; // this browser already has that version
      try { const g = await fetch(url(kind, id)); if (g.ok) { const data = await g.json(); await run(kind, 'readwrite', (s) => s.put(data)); seen.set(`${kind}:${id}`, v); } } catch {}
    }
    syncing = true;
    for (const x of local.values()) if (!there.has(x.id) && !remote.gone[kind].includes(x.id)) push(kind, x);
  }
  syncing = true;
  return true;
}

// Phase 5b: shot lists live in their OWN small database. Adding a store to 'handcam' would need a version upgrade,
// and an upgrade waits until every open CineHand tab (old versions included) lets go; a new database never waits.
let seqOpening;
function seqDb() {
  return seqOpening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('handcam-sequences', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('sequences', { keyPath: 'setId' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function seqRun(mode, fn) {
  const d = await seqDb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('sequences', mode), req = fn(tx.objectStore('sequences'));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}
export const putSequence = (seq) => seqRun('readwrite', s => s.put(seq));
export const getSequence = (setId) => seqRun('readonly', s => s.get(setId));
