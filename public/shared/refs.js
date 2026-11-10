// The reference kit of a set: the pictures the AI video must keep exactly. Today one subject photo (often the photo the
// set was built from), an optional logo, and the look of the set (one wide picture of the whole place, approved once:
// DECISIONS §50); the slots already take more (subject angles, environment) for later.
// Its own small IndexedDB, like shot lists (store.js): a new database never waits on an upgrade of 'handcam'.
// Pictures stay in this browser; they are uploaded only with a Make video that uses them.

const DB = 'handcam-refs', STORE = 'kits';
export const LIMITS = Object.freeze({ subject: 1, environment: 0 }); // raise these when multi-photo kits ship

let opening;
function db() {
  return opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'setId' });
    req.onsuccess = () => { req.result.onversionchange = () => { req.result.close(); opening = null; }; resolve(req.result); };
    req.onerror = () => reject(req.error);
  });
}
async function run(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

const empty = (setId) => ({ setId, subject: [], environment: [], logo: null, look: null });

/** The kit of a set (an empty one when there is none). */
export async function getKit(setId) {
  if (!setId) return empty(setId);
  return (await run('readonly', (s) => s.get(setId)).catch(() => null)) || empty(setId);
}
export const saveKit = (kit) => run('readwrite', (s) => s.put(kit));

/** Put a picture in a slot ('subject' | 'environment'), newest first, keeping the slot's limit. */
export async function addPicture(setId, slot, pic) {
  const kit = await getKit(setId);
  kit[slot] = [pic, ...kit[slot]].slice(0, Math.max(1, LIMITS[slot] || 1));
  await saveKit(kit);
  return kit;
}
export async function setLogo(setId, logo) {
  const kit = await getKit(setId);
  kit.logo = logo;
  await saveKit(kit);
  return kit;
}
/** The look of the set: { dataUrl, width, height, words, at }, or null to forget it. */
export async function setLook(setId, look) {
  const kit = await getKit(setId);
  kit.look = look;
  await saveKit(kit);
  return kit;
}
export async function clearSlot(setId, slot) {
  const kit = await getKit(setId);
  if (slot === 'logo') kit.logo = null; else kit[slot] = [];
  await saveKit(kit);
  return kit;
}
