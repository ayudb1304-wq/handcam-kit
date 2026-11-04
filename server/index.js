// HandCam relay: static files + dumb WebSocket relay + QR info + POST /api/scene. See docs/ARCHITECTURE.md.
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { networkInterfaces } from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MSG, ROLES, makeRoomCode } from '../public/shared/protocol.js';
import { buildScene, DEFAULT_MODEL } from './scene.js';
import { validateScene } from './validate-scene.js';
import { checkLabTake, isLocal, saveLabTake } from './lab.js';
import { loadRecipes } from './make/recipe.js';
import { makeJobs } from './make/jobs.js';
import { makeRoutes } from './make/routes.js';
import { makeMock } from './make/providers/mock.js';
import { makeHiggsfield, higgsfieldReady } from './make/providers/higgsfield.js';
import { runScore } from './make/score.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Optional .env in the project root (gitignored) for ANTHROPIC_API_KEY etc. Needs Node ≥ 20.12; otherwise use `export`.
const ENV_FILE = join(__dirname, '..', '.env');
if (existsSync(ENV_FILE)) process.loadEnvFile ? process.loadEnvFile(ENV_FILE) : console.warn('.env found but this Node is too old to load it; export the variables instead');
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

// Scene from a sentence: Claude if ANTHROPIC_API_KEY is set, else (or on failure) a keyword-matched template.
app.post('/api/scene', async (req, res) => {
  const current = req.body?.current && !validateScene(req.body.current).length ? req.body.current : undefined;
  res.json(await buildScene(req.body?.prompt, { current }));
});

// Send to lab: save a take + its set under lab/takes/ for recipe tests. Laptop only, never via the tunnel.
app.post('/api/lab/take', async (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'Open the desk at http://localhost:' + PORT + '/desk on this laptop to send takes to the lab.' });
  const errors = checkLabTake(req.body);
  if (errors.length) return res.status(400).json({ error: errors.slice(0, 3).join('; ') });
  try {
    res.json({ saved: await saveLabTake(join(__dirname, '..'), req.body) });
  } catch (e) {
    res.status(500).json({ error: `could not save: ${e.message}` });
  }
});

// Make video: take + set + look -> a real video that follows the move, checked. See server/make/ and recipes/.
const ROOT = join(__dirname, '..');
const recipes = await loadRecipes(join(ROOT, 'recipes'));
const providers = { mock: makeMock({ demoDir: join(ROOT, 'public', 'demo') }), higgsfield: makeHiggsfield() };
const providerReady = (p) => p === 'mock' || (p === 'higgsfield' && higgsfieldReady());
const jobs = makeJobs({ dir: join(ROOT, 'data', 'jobs'), recipes, providers, score: runScore });
app.use('/api/make', makeRoutes({ jobs, recipes, ready: providerReady }));
jobs.resume().catch((e) => console.warn('could not resume make jobs:', e.message));

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
  console.log(process.env.ANTHROPIC_API_KEY ? `scenes: Claude (${process.env.ANTHROPIC_MODEL || DEFAULT_MODEL})` : 'scenes: templates only (set ANTHROPIC_API_KEY for AI blockouts)');
  console.log(`make video: ${Object.values(recipes).map((r) => `${r.label}${providerReady(r.provider) ? '' : ' (needs HF_API_KEY_ID/SECRET)'}`).join(', ')}`);
  console.log(`room ${DEFAULT_ROOM}${PUBLIC_URL ? `   public: ${PUBLIC_URL}` : '   (set PUBLIC_URL to your https tunnel for phone testing)'}`);
});
