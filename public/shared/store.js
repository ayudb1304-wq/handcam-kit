// Plain IndexedDB, no library. Each page has its own copy (phone and laptop are different browsers).
// takes: keyed by take.id. scenes: keyed by scene.id, so a take can be replayed in the set it was shot in.
const DB = 'handcam', VERSION = 1, STORES = ['takes', 'scenes'];
let opening;

function db() {
  return opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => { for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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
export const putScene = (scene) => run('scenes', 'readwrite', s => s.put(scene));
export const getScene = (id) => run('scenes', 'readonly', s => s.get(id));
