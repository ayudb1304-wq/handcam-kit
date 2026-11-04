// Buying video packs with Dodo Payments (Phase 5). Plain fetch, no SDK (docs.dodopayments.com, read 2026-11-05).
//  POST /api/pay/checkout {packId}  -> Dodo checkout session -> { url }   (signed-in accounts only)
//  GET  /pay/return?payment_id=…    -> confirm with GET /payments/{id} (never trust the URL) -> credit -> back to the studio
//  POST /api/pay/webhook            -> Standard Webhooks signature check -> payment.succeeded -> credit
// A pack is credited once per payment id, whichever of the return page or the webhook arrives first.
import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export const DODO_BASE = { test: 'https://test.dodopayments.com', live: 'https://live.dodopayments.com' };

/** Standard Webhooks: v1 = base64(HMAC-SHA256(key, `${id}.${timestamp}.${body}`)), key = base64-decoded secret after "whsec_". */
export function verifyWebhook(rawBody, headers, secret, nowS = Date.now() / 1000) {
  const id = headers['webhook-id'], ts = headers['webhook-timestamp'], sig = headers['webhook-signature'];
  if (!id || !ts || !sig || !secret) return false;
  if (Math.abs(nowS - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest();
  return String(sig).split(' ').some((part) => {
    const [v, b64] = part.split(',');
    if (v !== 'v1' || !b64) return false;
    const got = Buffer.from(b64, 'base64');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

export function makeDodo({ apiKey, mode = 'test', fetchImpl = fetch }) {
  const base = DODO_BASE[mode] || DODO_BASE.test;
  async function call(method, path, body) {
    const r = await fetchImpl(`${base}${path}`, {
      method, headers: { Authorization: `Bearer ${apiKey}`, ...(body && { 'Content-Type': 'application/json' }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = { message: text.slice(0, 200) }; }
    if (!r.ok) throw Object.assign(new Error(`Dodo ${r.status}: ${json.message || json.code || 'error'}`), { status: r.status, code: json.code });
    return json;
  }
  return {
    ready: !!apiKey, mode,
    createProduct: (p) => call('POST', '/products', p),
    listProducts: () => call('GET', '/products?page_size=100&page_number=0&recurring=false'),
    checkout: (body) => call('POST', '/checkouts', body),
    payment: (id) => call('GET', `/payments/${encodeURIComponent(id)}`),
  };
}

/** Pack id -> Dodo product id: env DODO_PRODUCT_<PACK> wins, else config/dodo-products.<mode>.json (npm run dodo:setup writes it). */
export async function productIds(pricing, mode, file) {
  const saved = file && existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : {};
  return Object.fromEntries(pricing.packs.map((p) => [p.id, process.env[`DODO_PRODUCT_${p.id.toUpperCase()}`] || saved[p.id] || null]));
}

export function makePayRoutes({ dodo, accounts, pricing, products, publicBase, webhookSecret, log = console }) {
  const api = express.Router(), pages = express.Router();
  const packById = (id) => pricing.packs.find((p) => p.id === id);

  /** Credit a payment we have confirmed with Dodo. → { credited, videos } */
  async function fulfil(payment) {
    if (payment?.status !== 'succeeded') return { credited: false };
    const { userId, packId } = payment.metadata || {};
    const pack = packById(packId);
    if (!pack || !userId) return { credited: false };
    const credited = await accounts.creditPayment(payment.payment_id, { userId, videos: pack.videos, packId, amount: payment.total_amount, currency: payment.currency });
    return { credited, videos: pack.videos };
  }

  api.post('/checkout', express.json(), async (req, res) => {
    const user = accounts.userFrom(req);
    if (!user) return res.status(401).json({ error: 'Sign in first.', code: 'signin' });
    if (!dodo.ready) return res.status(503).json({ error: 'Payments aren’t set up on this server yet.' });
    const pack = packById(req.body?.packId), productId = pack && products[pack.id];
    if (!pack) return res.status(400).json({ error: 'Unknown pack.' });
    if (!productId) return res.status(503).json({ error: 'This pack isn’t set up in Dodo yet (npm run dodo:setup).' });
    const base = publicBase(req), back = req.body?.from === 'cam' ? 'cam' : 'desk';
    try {
      const s = await dodo.checkout({
        product_cart: [{ product_id: productId, quantity: 1 }],
        customer: { email: user.email, name: user.name || user.email.split('@')[0] },
        return_url: `${base}/pay/return?back=${back}`,
        cancel_url: `${base}/${back}?paid=cancelled`,
        metadata: { userId: user.id, packId: pack.id },
        feature_flags: { redirect_immediately: true },
      });
      res.json({ url: s.checkout_url, session: s.session_id });
    } catch (e) {
      log.warn(`[pay] checkout failed: ${e.message}`);
      res.status(502).json({ error: 'Could not start the payment. Try again in a minute.' });
    }
  });

  // Webhook: raw body (the signature covers the exact bytes), mounted before express.json in index.js.
  api.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const raw = req.body?.toString('utf8') || '';
    if (!verifyWebhook(raw, req.headers, webhookSecret)) return res.status(401).end();
    try {
      const event = JSON.parse(raw);
      if (event.type === 'payment.succeeded' && event.data?.payment_id) {
        // confirm with Dodo too, so a replayed or edited event can't credit anything
        const r = await fulfil(await dodo.payment(event.data.payment_id));
        log.log(`[pay] webhook ${event.data.payment_id}: ${r.credited ? `credited ${r.videos} videos` : 'nothing to do'}`);
      }
      res.status(200).json({ ok: true });
    } catch (e) {
      log.warn(`[pay] webhook error: ${e.message}`);
      res.status(500).end(); // Dodo retries
    }
  });

  pages.get('/pay/return', async (req, res) => {
    const back = req.query.back === 'cam' ? 'cam' : 'desk', id = String(req.query.payment_id || '');
    if (!id) return res.redirect(`/${back}?paid=cancelled`);
    try {
      const payment = await dodo.payment(id);
      if (payment.status !== 'succeeded') return res.redirect(`/${back}?paid=${payment.status === 'processing' ? 'processing' : 'failed'}`);
      const r = await fulfil(payment);
      res.redirect(`/${back}?paid=${r.videos ? `ok&videos=${r.videos}` : 'ok'}`);
    } catch (e) {
      log.warn(`[pay] return check failed for ${id}: ${e.message}`);
      res.redirect(`/${back}?paid=check`);
    }
  });

  return { api, pages, fulfil };
}
