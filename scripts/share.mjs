// npm run share — let a friend try HandCam from this laptop: starts a free Cloudflare tunnel (a public https link),
// then the server with PUBLIC_URL set to it, and prints the links to send. Ctrl+C stops both.
// The laptop must stay on and awake while they test. Your friend is a customer: they sign up, see prices in videos,
// and never see your AI costs; you on this laptop (localhost) are the founder.
import { spawn } from 'node:child_process';

const PORT = process.env.PORT || '3000';
const kids = [];
const stop = () => { for (const k of kids) k.kill('SIGINT'); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);

console.log('Starting a public https link (Cloudflare tunnel)…');
const tunnel = spawn('npx', ['-y', 'cloudflared', 'tunnel', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
kids.push(tunnel);
let started = false;
const onOut = (buf) => {
  const url = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
  if (!url || started) return;
  started = true;
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
