// npm run dodo:webhook -- https://<public link>
// Points HandCam's Dodo webhook at <link>/api/pay/webhook (creates it the first time) and, if .env has no
// DODO_WEBHOOK_SECRET yet, fetches the signing secret from Dodo and appends it to .env. The secret is never printed.
// `npm run share` calls this with each new tunnel link, so renewals, failed cards and refunds keep arriving.
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { DODO_BASE } from '../server/payments.js';

export async function pointWebhook(base, { env = process.env, log = console.log } = {}) {
  const key = env.DODO_PAYMENTS_API_KEY;
  if (!key) { log('webhook: skipped (no DODO_PAYMENTS_API_KEY)'); return null; }
  const api = DODO_BASE[env.DODO_MODE === 'live' ? 'live' : 'test'];
  const call = async (method, path, body) => {
    const r = await fetch(`${api}${path}`, { method, headers: { Authorization: `Bearer ${key}`, ...(body && { 'Content-Type': 'application/json' }) }, body: body && JSON.stringify(body) });
    const t = await r.text();
    if (!r.ok) throw new Error(`Dodo ${method} ${path} ${r.status}: ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : {};
  };
  const url = `${base.replace(/\/$/, '')}/api/pay/webhook`;
  const list = await call('GET', '/webhooks?limit=100');
  let hook = (list.data || []).find((w) => w.metadata?.handcam === '1');
  // all event types: HandCam ignores the ones it doesn't use (subscription.*, payment.*, refund.*, dispute.* matter)
  if (hook) { if (hook.url !== url) await call('PATCH', `/webhooks/${hook.id}`, { url, disabled: false }); }
  else hook = await call('POST', '/webhooks', { url, description: 'HandCam (npm run share keeps this pointed at the current link)', metadata: { handcam: '1' } });
  log(`webhook: ${url}`);
  const envText = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
  if (!/^DODO_WEBHOOK_SECRET=.+/m.test(envText) && !env.DODO_WEBHOOK_SECRET) {
    const { secret } = await call('GET', `/webhooks/${hook.id}/secret`);
    appendFileSync('.env', `${envText && !envText.endsWith('\n') ? '\n' : ''}DODO_WEBHOOK_SECRET=${secret}\n`);
    log('webhook: signing secret saved to .env');
  }
  return hook.id;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (existsSync('.env') && process.loadEnvFile) process.loadEnvFile('.env');
  const base = process.argv[2];
  if (!/^https:\/\//.test(base || '')) { console.error('usage: npm run dodo:webhook -- https://<public link>'); process.exit(1); }
  pointWebhook(base).catch((e) => { console.error(e.message); process.exit(1); });
}
