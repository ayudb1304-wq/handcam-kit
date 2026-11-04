// Canonical wire protocol. Imported by server (Node) and both pages (browser).
// Keep this file dependency-free and tiny.

export const MSG = Object.freeze({
  HELLO: 'hello',   // any -> relay   { role, room }
  PEER: 'peer',     // relay -> any   { role, joined }
  SCENE: 'scene',   // desk -> cam    { scene }
  POSE: 'pose',     // cam -> desk    { ts, q:[x,y,z,w], p:[x,y,z], rec, st, fov, aspect }  st = the set's clock (ms since ●, or rehearsal; 0 = at rest), fov = vertical degrees, aspect = w/h of the phone view
  REC: 'rec',       // desk -> cam    { state:'start'|'stop' }
  TAKE: 'take',     // cam -> desk    { take }
  ACK: 'ack',       // desk -> cam    { id }  the desk has this take; the phone stops re-sending it (Phase 5)
  ANCHOR: 'anchor', // cam -> desk    {}
});

export const ROLES = Object.freeze(['cam', 'desk']);

/** Optional take.label: which standard test shot a take is (lab recipe tests), or 'other'. */
export const SHOTS = Object.freeze(['1 slow walk', '2 walk past', '3 half circle', '4 whip', '5 crouch', 'other']);

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion when read aloud
export function makeRoomCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

/**
 * Open a relay socket, say hello, and call onMessage(msg) for each parsed message. Reconnects by itself with backoff
 * (1 s, 2 s, 4 s … up to 10 s) and says hello again (Phase 5): a server restart or a Wi-Fi blip heals on its own.
 * onStatus: 'connected' | 'reconnecting' | 'disconnected'.
 */
export function connectRelay({ role, room, onMessage, onStatus = () => {} }) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws = null, delay = 1000, closed = false, timer = null;
  function open() {
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.addEventListener('open', () => {
      delay = 1000;
      ws.send(JSON.stringify({ t: MSG.HELLO, role, room }));
      onStatus('connected');
    });
    ws.addEventListener('message', (e) => { try { onMessage(JSON.parse(e.data)); } catch {} });
    ws.addEventListener('close', () => {
      if (closed) return onStatus('disconnected');
      onStatus('reconnecting');
      clearTimeout(timer);
      timer = setTimeout(open, delay);
      delay = Math.min(delay * 2, 10_000);
    });
  }
  open();
  // a phone coming back from the lock screen: try at once instead of waiting out the backoff
  addEventListener('online', () => { if (ws?.readyState === 3 && !closed) { clearTimeout(timer); delay = 1000; open(); } });
  document.addEventListener?.('visibilitychange', () => { if (document.visibilityState === 'visible' && ws?.readyState === 3 && !closed) { clearTimeout(timer); delay = 1000; open(); } });
  return {
    send(obj) { if (ws?.readyState === 1) ws.send(JSON.stringify(obj)); },
    close() { closed = true; clearTimeout(timer); ws?.close(); },
    get connected() { return ws?.readyState === 1; },
  };
}
