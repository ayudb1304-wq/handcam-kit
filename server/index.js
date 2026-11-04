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
import { spawn } from 'node:child_process';
import { makeAccounts } from './accounts.js';
import { loadPricing } from './billing.js';
import { makeDodo, makePayRoutes, productIds } from './payments.js';
import { rateLimit, clientIp } from './limits.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Optional .env in the project root (gitignored) for ANTHROPIC_API_KEY etc. Needs Node ≥ 20.12; otherwise use `export`.
const ENV_FILE = join(__dirname, '..', '.env');
if (existsSync(ENV_FILE)) process.loadEnvFile ? process.loadEnvFile(ENV_FILE) : console.warn('.env found but this Node is too old to load it; export the variables instead');
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.PUBLIC_URL || '';

const ROOT_DIR = join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || join(ROOT_DIR, 'data'); // Render: a persistent disk, e.g. /var/data
const flag = (v) => /^(1|on|true|yes)$/i.test(String(v || ''));

const app = express();
app.set('trust proxy', true); // behind cloudflared / Render: req.protocol is https when the visitor's is
// ---- accounts + payments (Phase 5) ----
const pricing = loadPricing(join(ROOT_DIR, 'config', 'pricing.json'));
const accounts = await makeAccounts({ dir: DATA_DIR, secret: process.env.SESSION_SECRET, freeVideos: pricing.freeVideosOnSignup ?? 1, adminEmails: (process.env.ADMIN_EMAILS || '').split(',') });
const dodoMode = process.env.DODO_MODE === 'live' ? 'live' : 'test';
const dodo = makeDodo({ apiKey: process.env.DODO_PAYMENTS_API_KEY, mode: dodoMode });
const products = await productIds(pricing, dodoMode, join(ROOT_DIR, 'config', `dodo-products.${dodoMode}.json`));
const publicBase = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const pay = makePayRoutes({ dodo, accounts, pricing, products, publicBase, webhookSecret: process.env.DODO_WEBHOOK_SECRET });
app.use('/api/pay', pay.api); // before express.json: the webhook needs the raw body for its signature
app.use(pay.pages);
app.use(express.json({ limit: '5mb' }));
app.use(express.static(join(__dirname, '..', 'public'), { extensions: ['html'] }));
// The Blender importer, so the desk can put it in the Blender export zip (Phase 4).
app.get('/exporters/blender_import.py', (req, res) => res.type('text/x-python').sendFile(join(__dirname, '..', 'exporters', 'blender_import.py')));

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

// ---- account routes ----
const secure = (req) => req.protocol === 'https';
const authLimit = rateLimit({ perHour: 30 });
app.get('/api/account', (req, res) => res.json({ account: accounts.pub(accounts.userFrom(req)), local: isLocal(req) }));
app.post('/api/account/signup', async (req, res) => {
  if (!authLimit(clientIp(req))) return res.status(429).json({ error: 'Too many tries. Wait a little and try again.' });
  try {
    const u = await accounts.signup(req.body || {});
    res.setHeader('Set-Cookie', accounts.cookieFor(u, { secure: secure(req) }));
    res.json({ account: accounts.pub(u) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.post('/api/account/login', async (req, res) => {
  if (!authLimit(clientIp(req))) return res.status(429).json({ error: 'Too many tries. Wait a little and try again.' });
  try {
    const u = await accounts.login(req.body || {});
    res.setHeader('Set-Cookie', accounts.cookieFor(u, { secure: secure(req) }));
    res.json({ account: accounts.pub(u) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.post('/api/account/logout', (req, res) => { res.setHeader('Set-Cookie', accounts.clearCookie({ secure: secure(req) })); res.json({ ok: true }); });

// Scene from a sentence: Claude if ANTHROPIC_API_KEY is set, else (or on failure) a keyword-matched template.
// Rate-limited per visitor before the URL is public (each build spends our Claude key): DECISIONS §15.
const sceneLimitAnon = rateLimit({ perHour: Number(process.env.SCENE_LIMIT_ANON || 15) });
const sceneLimitUser = rateLimit({ perHour: Number(process.env.SCENE_LIMIT_USER || 80) });
app.post('/api/scene', async (req, res) => {
  if (!isLocal(req)) {
    const user = accounts.userFrom(req);
    const ok = user ? sceneLimitUser(`u:${user.id}`) : sceneLimitAnon(clientIp(req));
    if (!ok) return res.status(429).json({ error: user ? 'That’s a lot of sets for one hour. Try again a bit later.' : 'Sign in to build more sets this hour.', code: user ? 'limit' : 'signin' });
  }
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
const ROOT = ROOT_DIR;
const recipes = await loadRecipes(join(ROOT, 'recipes'));
const providers = { mock: makeMock({ demoDir: join(ROOT, 'public', 'demo') }), higgsfield: makeHiggsfield() };
const providerReady = (p) => p === 'mock' || (p === 'higgsfield' && higgsfieldReady());
const { refundDue } = await import('./billing.js');
const jobs = makeJobs({
  dir: join(DATA_DIR, 'jobs'), recipes, providers, score: runScore,
  // give back what the customer doesn't owe: free (under the move-match line) and failed versions
  onSettle: async (job) => {
    const back = refundDue(job);
    if (back > 0 && job.userId) { await accounts.adjust(job.userId, back, `refund ${job.id} (free or failed versions)`); job.charge.refunded += back; }
  },
});
const preview = (src, out) => new Promise((resolve, reject) => {
  const p = spawn(process.env.HANDCAM_PYTHON || 'python3', [join(__dirname, 'preview.py'), src, out], { stdio: 'ignore' });
  p.on('error', reject); p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`preview exit ${c}`))));
});
app.use('/api/make', makeRoutes({ jobs, recipes, ready: providerReady, accounts, pricing, preview, realAiForCustomers: flag(process.env.REAL_AI), chargePractice: flag(process.env.PRACTICE_CHARGES) }));
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
  console.log(`accounts: ${DATA_DIR}   payments: ${dodo.ready ? `Dodo ${dodoMode}${Object.values(products).every(Boolean) ? '' : ' (packs not set up: npm run dodo:setup)'}` : 'off (set DODO_PAYMENTS_API_KEY)'}   real AI for customers: ${flag(process.env.REAL_AI) ? 'on' : 'off'}`);
  console.log(`room ${DEFAULT_ROOM}${PUBLIC_URL ? `   public: ${PUBLIC_URL}` : '   (set PUBLIC_URL to your https tunnel for phone testing)'}`);
});
