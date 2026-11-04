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
    req.onblocked = () => console.warn('HandCam: another open HandCam tab is using an older version; close it or reload it.');
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

export const putTake = (take) => run('takes', 'readwrite', s => s.put(take));
/** All takes, newest first (ids start with an ISO timestamp). */
export const allTakes = async () => (await run('takes', 'readonly', s => s.getAll())).sort((a, b) => b.id.localeCompare(a.id));
export const deleteTake = (id) => run('takes', 'readwrite', s => s.delete(id));
export const putScene = (scene) => run('scenes', 'readwrite', s => s.put(scene));
export const getScene = (id) => run('scenes', 'readonly', s => s.get(id));

// Phase 5b: shot lists live in their OWN small database. Adding a store to 'handcam' would need a version upgrade,
// and an upgrade waits until every open HandCam tab (old versions included) lets go; a new database never waits.
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
