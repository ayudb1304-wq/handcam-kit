// CineHand relay: static files + dumb WebSocket relay + QR info + POST /api/scene. See docs/ARCHITECTURE.md.
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { networkInterfaces } from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MSG, ROLES, makeRoomCode } from '../public/shared/protocol.js';
import { buildScene, makeSceneCache, DEFAULT_MODEL } from './scene.js';
import { validateScene } from './validate-scene.js';
import { checkLabTake, isLocal, saveLabTake } from './lab.js';
import { loadRecipes } from './make/recipe.js';
import { makeJobs } from './make/jobs.js';
import { makeRoutes } from './make/routes.js';
import { makeMock } from './make/providers/mock.js';
import { makeHiggsfield, higgsfieldReady } from './make/providers/higgsfield.js';
import { makeQueue } from './make/queue.js';
import { watermark } from './watermark.js';
import { makeLogoLock } from './make/logolock.js';
import { publicCatalogue } from './plans.js';
import { runScore } from './make/score.js';
import { spawn } from 'node:child_process';
import { makeAccounts } from './accounts.js';
import { makeSupabase } from './supa.js';
import { loadPricing } from './billing.js';
import { makeDodo, makePayRoutes, productIds } from './payments.js';
import { rateLimit, clientIp } from './limits.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Optional .env in the project root (gitignored) for ANTHROPIC_API_KEY etc. Needs Node ≥ 20.12; otherwise use `export`.
const ENV_FILE = join(__dirname, '..', '.env');
if (existsSync(ENV_FILE)) process.loadEnvFile ? process.loadEnvFile(ENV_FILE) : console.warn('.env found but this Node is too old to load it; export the variables instead');
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || ''; // Render sets RENDER_EXTERNAL_URL itself

const ROOT_DIR = join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || join(ROOT_DIR, 'data'); // Render: a persistent disk, e.g. /var/data
const flag = (v) => /^(1|on|true|yes)$/i.test(String(v || ''));

const app = express();
app.set('trust proxy', true); // behind cloudflared / Render: req.protocol is https when the visitor's is
// With a custom domain (PUBLIC_URL), pages opened on the old *.onrender.com address move there, so the sign-in cookie,
// checkout returns and phone links all live on one host. /api stays reachable on both (Dodo's webhook points at Render).
const canonical = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL) : null;
app.use((req, res, next) => {
  const page = (req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/api/');
  if (canonical && page && req.hostname.endsWith('.onrender.com')) return res.redirect(301, canonical.origin + req.originalUrl);
  next();
});
// ---- accounts, plans and payments (Phase 5, 5c: docs/PRICING-PLAN.md) ----
const pricing = loadPricing(join(ROOT_DIR, 'config', 'pricing.json'));
// Supabase (Phase 5d): sign-in and the accounts database. Without its env vars CineHand keeps working on the file.
const supa = makeSupabase({ url: process.env.SUPABASE_URL, publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY, secretKey: process.env.SUPABASE_SECRET_KEY });
const accounts = await makeAccounts({ store: supa.store, dir: DATA_DIR, secret: process.env.SESSION_SECRET, pricing, adminEmails: (process.env.ADMIN_EMAILS || '').split(',') });
const dodoMode = process.env.DODO_MODE === 'live' ? 'live' : 'test';
const dodo = makeDodo({ apiKey: process.env.DODO_PAYMENTS_API_KEY, mode: dodoMode });
const products = await productIds(pricing, dodoMode, join(ROOT_DIR, 'config', `dodo-products.${dodoMode}.json`));
const publicBase = (req) => (PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const pay = makePayRoutes({ dodo, accounts, pricing, products, publicBase, webhookSecret: process.env.DODO_WEBHOOK_SECRET });
app.use('/api/pay', pay.api); // before express.json: the webhook needs the raw body for its signature
app.use(pay.pages);
app.use(express.json({ limit: '5mb' }));
app.use(express.static(join(__dirname, '..', 'public'), { extensions: ['html'] }));
// The Blender importer, so the desk can put it in the Blender export zip (Phase 4). JSON and Blender export come with
// a paid plan (Phase 5c); the importer is the part the server can actually withhold.
app.get('/exporters/blender_import.py', (req, res) => {
  if (!isLocal(req) && !accounts.ent(accounts.userFrom(req)).features.exportData) {
    return res.status(403).json({ error: 'Blender and JSON export come with a paid plan.', code: accounts.userFrom(req) ? 'plan' : 'signin' });
  }
  res.type('text/x-python').sendFile(join(__dirname, '..', 'exporters', 'blender_import.py'));
});

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
const signupLimit = rateLimit({ perHour: Number(process.env.SIGNUP_LIMIT || 5) }); // each new account gets trial videos: slow down farming
app.get('/api/account', async (req, res) => {
  const user = await pay.refreshIfStale(accounts.userFrom(req)); // a missed webhook must not keep or lose a plan
  res.json({ account: accounts.pub(user), local: isLocal(req), founder: isLocal(req) || accounts.isAdmin(user) });
});
// What's for sale (prices and what each plan includes, never our costs): the landing page and the studio draw from it.
app.get('/api/plans', (req, res) => {
  const c = publicCatalogue(pricing);
  if (c.lifetime) c.lifetime.soldOut = !!pricing.lifetime.limit && accounts.lifetimeCount() >= pricing.lifetime.limit;
  res.json({ ...c, payments: dodo.ready });
});
// The customer's own Higgsfield key (paid plans): stored encrypted, never sent back (only its last 4 characters).
app.post('/api/account/byok', async (req, res) => {
  const user = accounts.userFrom(req);
  if (!user) return res.status(401).json({ error: 'Sign in first.', code: 'signin' });
  if (!accounts.ent(user).features.byok) return res.status(403).json({ error: 'Using your own AI key comes with a paid plan.', code: 'plan' });
  try { await accounts.setByok(user.id, req.body || {}); res.json({ account: accounts.pub(accounts.get(user.id)) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.delete('/api/account/byok', async (req, res) => {
  const user = accounts.userFrom(req);
  if (!user) return res.status(401).json({ error: 'Sign in first.', code: 'signin' });
  await accounts.clearByok(user.id);
  res.json({ account: accounts.pub(accounts.get(user.id)) });
});
app.post('/api/account/signup', async (req, res) => {
  if (!authLimit(clientIp(req)) || (!isLocal(req) && !signupLimit(clientIp(req)))) return res.status(429).json({ error: 'Too many tries. Wait a little and try again.' });
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
// Sign-in through Supabase Auth (Google, email + password): the browser sends its access token once, we check it with
// Supabase and hand out CineHand's own session cookie. Both config values are public (publishable key).
app.get('/api/auth/config', (req, res) => res.json({ supabase: supa.publicConfig() }));
app.post('/api/account/supabase', async (req, res) => {
  if (!authLimit(clientIp(req))) return res.status(429).json({ error: 'Too many tries. Wait a little and try again.' });
  try {
    const who = await supa.userFromToken(String(req.body?.access_token || ''));
    if (!who) return res.status(401).json({ error: 'That sign-in didn’t work. Try again.' });
    if (!who.verified) return res.status(403).json({ error: 'Confirm your email first: open the link Supabase sent you.', code: 'confirm' });
    const known = accounts.byEmail(who.email);
    if (!known && !isLocal(req) && !signupLimit(clientIp(req))) return res.status(429).json({ error: 'Too many new accounts from here. Try again later.' });
    const { user, created } = await accounts.fromAuth({ authId: who.id, email: who.email, name: who.name });
    res.setHeader('Set-Cookie', accounts.cookieFor(user, { secure: secure(req) }));
    res.json({ account: accounts.pub(user), created });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.post('/api/account/logout', (req, res) => { res.setHeader('Set-Cookie', accounts.clearCookie({ secure: secure(req) })); res.json({ ok: true }); });

// Scene from a sentence: Claude if ANTHROPIC_API_KEY is set, else (or on failure) a keyword-matched template.
// Rate-limited per visitor before the URL is public (each build spends our Claude key): DECISIONS §15.
const sceneCache = makeSceneCache(join(DATA_DIR, 'scene-cache.json')); // same words, same set, one Claude call
const sceneLimitAnon = rateLimit({ perHour: Number(process.env.SCENE_LIMIT_ANON || 15) });
const sceneLimitUser = rateLimit({ perHour: Number(process.env.SCENE_LIMIT_USER || 80) });
app.post('/api/scene', async (req, res) => {
  if (!isLocal(req)) {
    const user = accounts.userFrom(req);
    const ok = user ? sceneLimitUser(`u:${user.id}`) : sceneLimitAnon(clientIp(req));
    if (!ok) return res.status(429).json({ error: user ? 'That’s a lot of sets for one hour. Try again a bit later.' : 'Sign in to build more sets this hour.', code: user ? 'limit' : 'signin' });
  }
  const current = req.body?.current && !validateScene(req.body.current).length ? req.body.current : undefined;
  // a photo to build from: a resized JPEG/PNG from the browser (shared/image.js), base64, at most ~4 MB
  const img = req.body?.image;
  const image = img && /^image\/(jpeg|png|webp|gif)$/.test(img.mediaType) && typeof img.data === 'string' && img.data.length < 5_500_000 && /^[A-Za-z0-9+/=]+$/.test(img.data.slice(0, 200)) ? { mediaType: img.mediaType, data: img.data } : undefined;
  if (img && !image) return res.status(400).json({ error: 'That picture can’t be used. Try a JPEG or PNG photo.' });
  res.json(await buildScene(req.body?.prompt, { current: image ? undefined : current, cache: sceneCache, image }));
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
// A job on the customer's own key runs on their Higgsfield account; without a saved key it fails with a clear reason.
const noKey = () => { throw new Error('Your Higgsfield key isn’t saved any more: add it again in your account.'); };
const providerFor = (job) => {
  if (!job.byok) return providers[job.provider];
  const env = job.userId && accounts.byokEnv(job.userId);
  return env ? makeHiggsfield({ env }) : { name: 'higgsfield', upload: noKey, submit: noKey, status: noKey, download: noKey };
};
const jobs = makeJobs({
  dir: join(DATA_DIR, 'jobs'), recipes, providers, score: runScore, providerFor,
  queue: makeQueue({ slots: Number(process.env.MAKE_SLOTS || 6) }), // AI versions at once on our key; higher plans first when busy
  // give back what the customer doesn't owe (free and failed versions), to where it came from
  onSettle: async (job) => {
    const back = refundDue(job);
    if (back > 0 && job.userId) {
      job.charge.from ||= { month: 0, topup: job.charge.reserved, trial: 0, cycle: null }; // jobs from before plans paid from the old balance (now top-ups)
      await accounts.refund(job.userId, job.charge.from, back, `refund ${job.id} (free or failed versions)`);
      job.charge.refunded += back;
    }
  },
});
const preview = (src, out) => new Promise((resolve, reject) => {
  const p = spawn(process.env.HANDCAM_PYTHON || 'python3', [join(__dirname, 'preview.py'), src, out], { stdio: 'ignore' });
  p.on('error', reject); p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`preview exit ${c}`))));
});
app.use('/api/make', makeRoutes({ jobs, recipes, ready: providerReady, accounts, pricing, preview, watermark, logolock: makeLogoLock({ jobs }), refsForCustomers: flag(process.env.REFS_FOR_CUSTOMERS), realAiForCustomers: flag(process.env.REAL_AI), chargePractice: flag(process.env.PRACTICE_CHARGES) }));
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
  console.log(`CineHand relay  →  http://localhost:${PORT}/desk   (LAN: http://${lanIp()}:${PORT})`);
  console.log(process.env.ANTHROPIC_API_KEY ? `scenes: Claude (${process.env.ANTHROPIC_MODEL || DEFAULT_MODEL})` : 'scenes: templates only (set ANTHROPIC_API_KEY for AI blockouts)');
  console.log(`make video: ${Object.values(recipes).map((r) => `${r.label}${providerReady(r.provider) ? '' : ' (needs HF_API_KEY_ID/SECRET)'}`).join(', ')}`);
  console.log(`sign-in: ${supa.authReady ? 'Supabase (Google, email)' : 'built-in email + password'}   database: ${supa.dbReady ? 'Supabase' : 'file only'}`);
  console.log(`accounts: ${DATA_DIR}   payments: ${dodo.ready ? `Dodo ${dodoMode}${Object.values(products).every(Boolean) ? '' : ' (plans not set up: npm run dodo:setup)'}` : 'off (set DODO_PAYMENTS_API_KEY)'}   real AI for customers: ${flag(process.env.REAL_AI) ? 'on' : 'off'}`);
  console.log(`room ${DEFAULT_ROOM}${PUBLIC_URL ? `   public: ${PUBLIC_URL}` : '   (set PUBLIC_URL to your https tunnel for phone testing)'}`);
});
