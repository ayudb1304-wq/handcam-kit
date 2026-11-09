// Plans, top-ups and Lifetime with Dodo Payments (Phase 5, 5c). Plain fetch, no SDK. API shapes from Dodo's own
// SDK types (dodopayments 2.61.1, read 2026-11-05). What each event means for the customer: docs/PRICING-PLAN.md.
//
//  POST /api/pay/checkout {kind: plan|topup|lifetime, id, interval}  -> Dodo checkout session -> { url }
//  POST /api/pay/change   {plan, interval}  -> upgrade now (prorated) · downgrade at the end of the paid period
//  POST /api/pay/keep     -> drop a scheduled downgrade        POST /api/pay/cancel | /resume -> at period end / undo
//  POST /api/pay/portal   -> Dodo customer portal (card, invoices)
//  GET  /pay/return       -> confirm with Dodo (never trust the URL) -> back to the studio
//  POST /api/pay/webhook  -> Standard Webhooks signature -> re-read the object from Dodo -> apply
// Every change is confirmed by reading the subscription/payment back from Dodo; events only say "look again".
import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { INTERVALS, planById, planDirection, subscriptionState } from './plans.js';

/** Dodo's CancellationFeedback values (docs: PATCH /subscriptions). */
export const CANCEL_REASONS = ['too_expensive', 'missing_features', 'switched_service', 'unused', 'customer_service', 'low_quality', 'too_complex', 'other'];

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
    let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { message: text.slice(0, 200) }; }
    if (!r.ok) throw Object.assign(new Error(`Dodo ${r.status}: ${json.message || json.code || 'error'}`), { status: r.status, code: json.code });
    return json;
  }
  const id = encodeURIComponent;
  return {
    ready: !!apiKey, mode,
    createProduct: (p) => call('POST', '/products', p),
    updateProduct: (id, p) => call('PATCH', `/products/${id}`, p),
    listProducts: (recurring) => call('GET', `/products?page_size=100&page_number=0&recurring=${recurring ? 'true' : 'false'}`),
    checkout: (body) => call('POST', '/checkouts', body),
    payment: (x) => call('GET', `/payments/${id(x)}`),
    refund: (x) => call('GET', `/refunds/${id(x)}`),
    dispute: (x) => call('GET', `/disputes/${id(x)}`),
    subscription: (x) => call('GET', `/subscriptions/${id(x)}`),
    updateSubscription: (x, body) => call('PATCH', `/subscriptions/${id(x)}`, body),
    changePlan: (x, body) => call('POST', `/subscriptions/${id(x)}/change-plan`, body),
    cancelScheduledChange: (x) => call('DELETE', `/subscriptions/${id(x)}/change-plan/scheduled`),
    portal: (customerId, body) => call('POST', `/customers/${id(customerId)}/customer-portal/session`, body),
  };
}

/** Everything sold, by key: "creator.month", "creator.year", "topup5", "lifetime". */
export function catalogueItems(pricing) {
  const items = {};
  for (const p of pricing.plans) if (p.id !== 'free') for (const interval of INTERVALS) items[`${p.id}.${interval}`] = { kind: 'plan', plan: p.id, interval, usd: p.price[interval], name: `CineHand ${p.name} (${interval === 'year' ? 'yearly' : 'monthly'})` };
  for (const t of pricing.topups || []) items[t.id] = { kind: 'topup', id: t.id, videos: t.videos, usd: t.usd, name: `CineHand: ${t.name}` };
  if (pricing.lifetime) items[pricing.lifetime.id] = { kind: 'lifetime', id: pricing.lifetime.id, usd: pricing.lifetime.usd, name: `CineHand ${pricing.lifetime.name}` };
  return items;
}

/** Item key -> Dodo product id: env DODO_PRODUCT_<KEY> (dots as _) wins, else config/dodo-products.<mode>.json (npm run dodo:setup). */
export async function productIds(pricing, mode, file) {
  const saved = file && existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : {};
  return Object.fromEntries(Object.keys(catalogueItems(pricing)).map((k) => [k, process.env[`DODO_PRODUCT_${k.replace(/\W/g, '_').toUpperCase()}`] || saved[k] || null]));
}

/** A Dodo subscription in our words. Unknown products give null (not ours to act on). */
export function normaliseSubscription(s, byProduct) {
  const item = byProduct[s.product_id];
  if (!item || item.kind !== 'plan') return null;
  const status = { past_due: 'on_hold', paused: 'on_hold' }[s.status] || s.status;
  const next = s.scheduled_change && byProduct[s.scheduled_change.product_id];
  return {
    id: s.subscription_id, customerId: s.customer?.customer_id || null, userId: s.metadata?.userId || null, email: s.customer?.email || null,
    plan: item.plan, interval: item.interval, status, paidThrough: s.next_billing_date || null,
    cancelAtPeriodEnd: !!s.cancel_at_next_billing_date, startedAt: s.created_at || null,
    pending: next?.kind === 'plan' ? { plan: next.plan, interval: next.interval, at: s.scheduled_change.effective_at } : null,
  };
}

export function makePayRoutes({ dodo, accounts, pricing, products, publicBase, webhookSecret, log = console }) {
  const api = express.Router(), pages = express.Router();
  const items = catalogueItems(pricing);
  const byProduct = Object.fromEntries(Object.entries(products).filter(([, pid]) => pid).map(([k, pid]) => [pid, { ...items[k], key: k }]));
  const fail = (res, status, error, code) => res.status(status).json({ error, code });

  /** Read a subscription from Dodo and store it on its account. → the account, or null. */
  async function syncSubscription(subId, userHint) {
    const s = await dodo.subscription(subId);
    const sub = normaliseSubscription(s, byProduct);
    if (!sub) { log.warn(`[pay] subscription ${subId}: product ${s.product_id} is not a CineHand plan`); return null; }
    const user = (userHint && accounts.get(userHint)) || accounts.bySubscription(subId) || (sub.userId && accounts.get(sub.userId)) || (sub.email && accounts.byEmail(sub.email));
    if (!user) { log.warn(`[pay] subscription ${subId}: no account`); return null; }
    await accounts.syncSubscription(user.id, sub);
    return accounts.get(user.id);
  }

  /** Apply a one-time payment we have confirmed with Dodo (top-up or Lifetime). Plan payments re-read their subscription. */
  async function fulfil(payment) {
    if (payment?.status !== 'succeeded') return { credited: false };
    if (payment.subscription_id) { await syncSubscription(payment.subscription_id, payment.metadata?.userId); return { credited: false, plan: true }; }
    const { userId, kind, itemId } = payment.metadata || {};
    const item = items[itemId];
    if (!userId || !item || item.kind !== kind || kind === 'plan') return { credited: false };
    const credited = await accounts.recordPayment(payment.payment_id, { kind, userId, videos: item.videos || 0, itemId, amount: payment.total_amount, currency: payment.currency });
    return { credited, kind, videos: item.videos || 0 };
  }

  /** The account for a payment (for refunds and disputes): ours if we recorded it, else its subscription's or metadata's. */
  async function accountForPayment(paymentId) {
    const ours = accounts.payment(paymentId);
    if (ours) return { user: accounts.get(ours.userId), payment: null };
    const p = await dodo.payment(paymentId);
    const user = (p.subscription_id && accounts.bySubscription(p.subscription_id)) || (p.metadata?.userId && accounts.get(p.metadata.userId)) || null;
    return { user, payment: p };
  }

  async function onEvent(event) {
    const d = event.data || {}, type = event.type || '';
    if (type.startsWith('subscription.') && d.subscription_id) {
      const u = await syncSubscription(d.subscription_id);
      return u ? `${type}: ${u.email} is ${u.sub.plan}/${u.sub.interval} ${u.sub.status}` : `${type}: ignored`;
    }
    if (type === 'payment.succeeded' && d.payment_id) {
      const r = await fulfil(await dodo.payment(d.payment_id));
      return r.credited ? `credited ${r.kind} ${r.videos || ''}` : r.plan ? 'plan payment: subscription re-read' : 'nothing to do';
    }
    if (type === 'refund.succeeded' && d.refund_id) {
      const ref = await dodo.refund(d.refund_id);
      if (ref.status !== 'succeeded') return 'refund not succeeded';
      const ours = accounts.payment(ref.payment_id);
      if (!ours) return 'refund of a plan payment: Dodo sends the subscription events';
      const fraction = ours.amount && ref.amount != null ? ref.amount / ours.amount : 1;
      return (await accounts.reversePayment(ref.payment_id, { refundId: ref.refund_id, fraction })) ? `refund ${ref.refund_id} applied` : 'refund already applied';
    }
    if (type.startsWith('dispute.') && d.dispute_id) {
      const dis = await dodo.dispute(d.dispute_id);
      const { user } = await accountForPayment(dis.payment_id);
      if (!user) return 'dispute: no account';
      const status = dis.dispute_status;
      if (status === 'dispute_opened' || status === 'dispute_challenged') { await accounts.setHold(user.id, `dispute ${dis.dispute_id}`); return `hold on ${user.email}`; }
      if (status === 'dispute_lost' || status === 'dispute_accepted') await accounts.reversePayment(dis.payment_id, { refundId: dis.dispute_id, fraction: 1 });
      await accounts.setHold(user.id, null);
      return `dispute ${status}: hold lifted on ${user.email}`;
    }
    return 'ignored';
  }

  const signedIn = (req, res) => {
    const user = accounts.userFrom(req);
    if (!user) { fail(res, 401, 'Sign in first.', 'signin'); return null; }
    if (!dodo.ready) { fail(res, 503, 'Payments aren’t set up on this server yet.'); return null; }
    return user;
  };
  const answer = async (res, user) => res.json({ account: accounts.pub(accounts.get(user.id)) });
  const dodoError = (res, e, what) => { log.warn(`[pay] ${what} failed: ${e.message}`); fail(res, e.status === 409 ? 409 : 502, e.status === 409 ? 'A change is already waiting on a payment. Try again in a minute.' : `Could not ${what}. Try again in a minute.`); };

  api.post('/checkout', express.json(), async (req, res) => {
    const user = signedIn(req, res);
    if (!user) return;
    const { kind, id, interval = 'month' } = req.body || {};
    const key = kind === 'plan' ? `${id}.${interval}` : id, item = items[key];
    if (!item || item.kind !== kind) return fail(res, 400, 'Unknown plan or pack.');
    const e = accounts.ent(user);
    if (kind === 'plan' && subscriptionState(user.sub)) return fail(res, 409, 'You already have a plan: change it from your account instead.', 'has_plan');
    if (kind === 'topup' && !e.features.topups) return fail(res, 403, 'Top-ups are for paid plans. Choose a plan first: it comes with videos every month.', 'plan');
    if (kind === 'lifetime') {
      if (user.lifetime) return fail(res, 409, 'You already have Lifetime.', 'has_plan');
      if (pricing.lifetime.limit && accounts.lifetimeCount() >= pricing.lifetime.limit) return fail(res, 410, 'The early-adopter Lifetime offer is sold out.', 'sold_out');
    }
    const productId = products[key];
    if (!productId) return fail(res, 503, 'This isn’t set up in Dodo yet (npm run dodo:setup).');
    const base = publicBase(req), back = req.body?.from === 'cam' ? 'cam' : req.body?.from === 'site' ? 'site' : 'desk';
    try {
      const s = await dodo.checkout({
        product_cart: [{ product_id: productId, quantity: 1 }],
        customer: { email: user.email, name: user.name || user.email.split('@')[0] },
        return_url: `${base}/pay/return?back=${back}`,
        cancel_url: `${base}/${back === 'site' ? '' : back}?paid=cancelled`,
        metadata: { userId: user.id, kind, itemId: key, ...(kind === 'plan' && { plan: item.plan, interval: item.interval }) },
        feature_flags: { redirect_immediately: true },
      });
      res.json({ url: s.checkout_url, session: s.session_id });
    } catch (x) { dodoError(res, x, 'start the payment'); }
  });

  /** A live, paid plan to change, or an answer saying why not. */
  function changeable(user, res) {
    const state = subscriptionState(user.sub);
    if (!state) { fail(res, 409, 'You don’t have a plan to change. Choose one instead.', 'no_plan'); return null; }
    if (state === 'on_hold') { fail(res, 409, 'Your last payment didn’t go through. Update your card in Manage billing first.', 'on_hold'); return null; }
    return state;
  }

  api.post('/change', express.json(), async (req, res) => {
    const user = signedIn(req, res);
    if (!user) return;
    const state = changeable(user, res);
    if (!state) return;
    const to = { plan: String(req.body?.plan || ''), interval: req.body?.interval === 'year' ? 'year' : 'month' };
    if (to.plan === 'free') return cancel(req, res, user);
    if (!planById(pricing, to.plan) || !products[`${to.plan}.${to.interval}`]) return fail(res, 400, 'Unknown plan.');
    const dir = planDirection(pricing, user.sub, to);
    try {
      if (state === 'ending') await dodo.updateSubscription(user.sub.id, { cancel_at_next_billing_date: false }); // changing plan means staying
      if (dir === 'same') { if (user.sub.pending) await dodo.cancelScheduledChange(user.sub.id); }
      else await dodo.changePlan(user.sub.id, {
        product_id: products[`${to.plan}.${to.interval}`], quantity: 1,
        // upgrade: now, the prorated difference charged today; downgrade: at the end of what's paid, full new price then
        ...(dir === 'upgrade'
          ? { proration_billing_mode: 'prorated_immediately', effective_at: 'immediately', on_payment_failure: 'prevent_change' }
          : { proration_billing_mode: 'full_immediately', effective_at: 'next_billing_date' }),
        cancel_scheduled_change_plan: true,
      });
      await syncSubscription(user.sub.id, user.id);
      await answer(res, user);
    } catch (x) { dodoError(res, x, 'change the plan'); }
  });

  api.post('/keep', async (req, res) => { // undo a scheduled downgrade
    const user = signedIn(req, res);
    if (!user || !changeable(user, res)) return;
    try { if (user.sub.pending) await dodo.cancelScheduledChange(user.sub.id); await syncSubscription(user.sub.id, user.id); await answer(res, user); }
    catch (x) { dodoError(res, x, 'keep the plan'); }
  });

  async function cancel(req, res, user) {
    try {
      // Dodo accepts only its own reasons here (anything else is a 422 that would block the cancel): drop the rest
      const why = String(req.body?.feedback || '');
      await dodo.updateSubscription(user.sub.id, { cancel_at_next_billing_date: true, ...(CANCEL_REASONS.includes(why) && { cancellation_feedback: why }) });
      await syncSubscription(user.sub.id, user.id);
      await answer(res, user);
    } catch (x) { dodoError(res, x, 'cancel the plan'); }
  }
  api.post('/cancel', express.json(), async (req, res) => {
    const user = signedIn(req, res);
    if (!user) return;
    if (!subscriptionState(user.sub)) return fail(res, 409, 'There’s no plan to cancel.', 'no_plan');
    return cancel(req, res, user);
  });
  api.post('/resume', async (req, res) => {
    const user = signedIn(req, res);
    if (!user) return;
    if (subscriptionState(user.sub) !== 'ending' || user.sub.status !== 'active') return fail(res, 409, 'Your plan isn’t set to end, or it has already ended: choose a plan again.', 'no_plan');
    try { await dodo.updateSubscription(user.sub.id, { cancel_at_next_billing_date: false }); await syncSubscription(user.sub.id, user.id); await answer(res, user); }
    catch (x) { dodoError(res, x, 'keep the plan'); }
  });

  api.post('/portal', express.json(), async (req, res) => {
    const user = signedIn(req, res);
    if (!user) return;
    if (!user.sub?.customerId) return fail(res, 409, 'Billing appears here once you have a plan.', 'no_plan');
    try { res.json({ url: (await dodo.portal(user.sub.customerId, { return_url: `${publicBase(req)}/${req.body?.from === 'cam' ? 'cam' : 'desk'}` })).link }); }
    catch (x) { dodoError(res, x, 'open billing'); }
  });

  // Webhook: raw body (the signature covers the exact bytes), mounted before express.json in index.js.
  api.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const raw = req.body?.toString('utf8') || '';
    if (!verifyWebhook(raw, req.headers, webhookSecret)) return res.status(401).end();
    try {
      log.log(`[pay] webhook ${await onEvent(JSON.parse(raw))}`);
      res.status(200).json({ ok: true });
    } catch (e) {
      log.warn(`[pay] webhook error: ${e.message}`);
      res.status(500).end(); // Dodo retries
    }
  });

  pages.get('/pay/return', async (req, res) => {
    const back = req.query.back === 'cam' ? 'cam' : req.query.back === 'site' ? 'desk' : 'desk';
    const subId = String(req.query.subscription_id || ''), payId = String(req.query.payment_id || '');
    if (!subId && !payId) return res.redirect(`/${back}?paid=cancelled`);
    try {
      if (subId) {
        const u = await syncSubscription(subId);
        const state = u && subscriptionState(u.sub);
        return res.redirect(`/${back}?paid=${state === 'active' || state === 'ending' ? 'plan' : u?.sub?.status === 'pending' ? 'processing' : 'failed'}`);
      }
      const payment = await dodo.payment(payId);
      if (payment.status !== 'succeeded') return res.redirect(`/${back}?paid=${payment.status === 'processing' ? 'processing' : 'failed'}`);
      const r = await fulfil(payment);
      res.redirect(`/${back}?paid=${r.plan ? 'plan' : r.kind === 'lifetime' ? 'lifetime' : 'ok'}`);
    } catch (e) {
      log.warn(`[pay] return check failed for ${subId || payId}: ${e.message}`);
      res.redirect(`/${back}?paid=check`);
    }
  });

  /** Re-read a subscription whose paid-through date has passed (a missed webhook must not keep or lose a plan). */
  const lastRefresh = new Map();
  async function refreshIfStale(user) {
    if (!dodo.ready || !user?.sub?.id || !user.sub.paidThrough) return user;
    if (new Date(user.sub.paidThrough) > new Date() || ['expired', 'failed'].includes(user.sub.status)) return user;
    if (Date.now() - (lastRefresh.get(user.id) || 0) < 10 * 60_000) return user;
    lastRefresh.set(user.id, Date.now());
    try { return (await syncSubscription(user.sub.id, user.id)) || user; } catch (e) { log.warn(`[pay] refresh ${user.sub.id}: ${e.message}`); return user; }
  }

  return { api, pages, fulfil, onEvent, syncSubscription, refreshIfStale };
}
