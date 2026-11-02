// Canonical wire protocol. Imported by server (Node) and both pages (browser).
// Keep this file dependency-free and tiny.

export const MSG = Object.freeze({
  HELLO: 'hello',   // any -> relay   { role, room }
  PEER: 'peer',     // relay -> any   { role, joined }
  SCENE: 'scene',   // desk -> cam    { scene }
  POSE: 'pose',     // cam -> desk    { ts, q:[x,y,z,w], p:[x,y,z], rec, fov, aspect }  fov = vertical degrees, aspect = w/h of the phone view
  REC: 'rec',       // desk -> cam    { state:'start'|'stop' }
  TAKE: 'take',     // cam -> desk    { take }
  ANCHOR: 'anchor', // cam -> desk    {}
});

export const ROLES = Object.freeze(['cam', 'desk']);

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion when read aloud
export function makeRoomCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

/** Open a relay socket, say hello, and call onMessage(msg) for each parsed message. Reconnect is Phase 5. */
export function connectRelay({ role, room, onMessage, onStatus = () => {} }) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ t: MSG.HELLO, role, room }));
    onStatus('connected');
  });
  ws.addEventListener('message', (e) => { try { onMessage(JSON.parse(e.data)); } catch {} });
  ws.addEventListener('close', () => onStatus('disconnected'));
  return {
    send(obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); },
    close() { ws.close(); },
  };
}
