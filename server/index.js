// HandCam relay. Phase 0: static files + dumb WebSocket relay + QR info.
// Phase 1 adds POST /api/scene (LLM with template fallback). See docs/ARCHITECTURE.md.
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { MSG, ROLES, makeRoomCode } from '../public/shared/protocol.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.PUBLIC_URL || '';

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(join(__dirname, '..', 'public'), { extensions: ['html'] }));

// A single default room per server process keeps Phase 0 simple. Desk can ask for a fresh one.
const DEFAULT_ROOM = makeRoomCode();

app.get('/api/info', (req, res) => {
  res.json({
    room: req.query.room || DEFAULT_ROOM,
    publicUrl: PUBLIC_URL || null,
    lanUrl: `http://${lanIp()}:${PORT}`,
    httpsRequiredForMotion: true,
  });
});

// Phase 1 fills this in. Phase 0 returns a template so the pages have something to render.
app.post('/api/scene', async (req, res) => {
  const { prompt = '' } = req.body || {};
  const scene = await templateScene(prompt);
  res.json({ scene, source: 'template' });
});

async function templateScene(prompt) {
  const dir = join(__dirname, 'templates');
  const files = (await readdir(dir)).filter(f => f.endsWith('.json'));
  const p = prompt.toLowerCase();
  // crude keyword match; Phase 1 replaces with a scored matcher + tests
  const pick = files.find(f => p.includes(f.replace('.json', '').split('-')[0])) || 'parking-lot.json';
  const scene = JSON.parse(await readFile(join(dir, pick), 'utf8'));
  scene.prompt = prompt;
  scene.id = `scene-${Date.now()}`;
  return scene;
}

// ---- WebSocket relay -------------------------------------------------------
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map(); // code -> Set<ws>

wss.on('connection', (ws) => {
  ws.meta = { role: null, room: null };
  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf); } catch { return; }
    if (msg.t === MSG.HELLO) {
      if (!ROLES.includes(msg.role)) return ws.close(1008, 'bad role');
      const room = String(msg.room || DEFAULT_ROOM).toUpperCase().slice(0, 4);
      ws.meta = { role: msg.role, room };
      if (!rooms.has(room)) rooms.set(room, new Set());
      rooms.get(room).add(ws);
      broadcast(room, ws, { t: MSG.PEER, role: msg.role, joined: true });
      return;
    }
    if (!ws.meta.room) return; // must hello first
    broadcast(ws.meta.room, ws, msg); // forward untouched
  });
  ws.on('close', () => {
    const { room, role } = ws.meta;
    if (!room) return;
    rooms.get(room)?.delete(ws);
    broadcast(room, ws, { t: MSG.PEER, role, joined: false });
    if (rooms.get(room)?.size === 0) rooms.delete(room);
  });
});

function broadcast(room, from, msg) {
  const data = JSON.stringify(msg);
  for (const peer of rooms.get(room) || []) {
    if (peer !== from && peer.readyState === 1 && peer.meta.role !== from.meta?.role) peer.send(data);
  }
}

function lanIp() {
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return 'localhost';
}

server.listen(PORT, () => {
  console.log(`HandCam relay  →  http://localhost:${PORT}/desk   (LAN: http://${lanIp()}:${PORT})`);
  console.log(`room ${DEFAULT_ROOM}${PUBLIC_URL ? `   public: ${PUBLIC_URL}` : '   (set PUBLIC_URL to your https tunnel for phone testing)'}`);
});
