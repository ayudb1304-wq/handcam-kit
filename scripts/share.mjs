// npm run share — let a friend try CineHand from this laptop: starts a free Cloudflare tunnel (a public https link),
// then the server with PUBLIC_URL set to it, and prints the links to send. Ctrl+C stops both.
// The laptop must stay on and awake while they test. Your friend is a customer: they sign up, see prices in videos,
// and never see your AI costs; you on this laptop (localhost) are the founder.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const PORT = process.env.PORT || '3000';
const kids = [];
const stop = () => { for (const k of kids) k.kill('SIGINT'); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);

console.log('Starting a public https link (Cloudflare tunnel)…');
// macOS: keep the laptop awake while sharing (display may dim; the Mac won't sleep). Ends with this script.
if (process.platform === 'darwin') kids.push(spawn('caffeinate', ['-ims', '-w', String(process.pid)], { stdio: 'ignore' }));
const tunnel = spawn('npx', ['-y', 'cloudflared', 'tunnel', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
kids.push(tunnel);
let started = false;
const onOut = async (buf) => {
  const url = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
  if (!url || started) return;
  started = true;
  // payments: point the Dodo webhook at this link (renewals, failed cards and refunds arrive there), then start the server
  const { pointWebhook } = await import('./dodo-webhook.mjs');
  if (existsSync('.env') && process.loadEnvFile) process.loadEnvFile('.env');
  // once CineHand lives on Render, the webhook belongs to the Render address: DODO_WEBHOOK_HOME in .env stops share moving it
  if (process.env.DODO_WEBHOOK_HOME) console.log(`webhook: stays on ${process.env.DODO_WEBHOOK_HOME} (DODO_WEBHOOK_HOME); payments made through this link are still confirmed on return`);
  else try { await pointWebhook(url); } catch (e) { console.warn(`webhook not updated (${e.message}); plan renewals won't reach CineHand on this link`); }
  const server = spawn(process.execPath, ['server/index.js'], { stdio: 'inherit', env: { ...process.env, PORT, PUBLIC_URL: url } });
  kids.push(server);
  server.on('exit', (c) => { console.log(`server stopped (${c})`); stop(); });
  setTimeout(() => {
    console.log(`\n────────────────────────────────────────────────────────────
  Send your friend:   ${url}/cam     (phone only: open it on an iPhone/Android)
  Or with a laptop:   ${url}/desk    (then scan its QR code with the phone)
  The landing page:   ${url}/
  You (founder):      http://localhost:${PORT}/desk
  Keep this window open and the laptop awake. Ctrl+C to stop.
────────────────────────────────────────────────────────────\n`);
  }, 1500);
};
tunnel.stdout.on('data', onOut);
tunnel.stderr.on('data', onOut);
tunnel.on('exit', (c) => { if (!started) console.error(`The tunnel didn't start (exit ${c}). Check your internet connection and try again.`); stop(); });
