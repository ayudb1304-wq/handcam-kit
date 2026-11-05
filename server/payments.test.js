import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { verifyWebhook, makeDodo, makePayRoutes, catalogueItems, normaliseSubscription } from './payments.js';
import { makeAccounts } from './accounts.js';
import { loadPricing } from './billing.js';

const pricing = loadPricing(new URL('../config/pricing.json', import.meta.url).pathname);
const secret = 'whsec_' + Buffer.from('a-very-secret-key-1234').toString('base64');
const sign = (id, ts, body) => `v1,${createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${ts}.${body}`).digest('base64')}`;

test('webhook signature: Standard Webhooks v1, tampering and old timestamps refused', () => {
  const body = '{"type":"payment.succeeded"}', ts = '1790000000';
  const h = { 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': `v0,xx ${sign('msg_1', ts, body)}` };
  assert.equal(verifyWebhook(body, h, secret, 1790000010), true);
  assert.equal(verifyWebhook(body + ' ', h, secret, 1790000010), false);
  assert.equal(verifyWebhook(body, h, secret, 1790001000), false, 'more than 5 minutes off');
  assert.equal(verifyWebhook(body, { ...h, 'webhook-id': 'msg_2' }, secret, 1790000010), false);
});

test('dodo client: bearer key, test host, errors carry the status', async () => {
  let seen;
  const d = makeDodo({ apiKey: 'dodo_test_x', mode: 'test', fetchImpl: async (url, init) => { seen = { url, init }; return { ok: false, status: 422, text: async () => '{"code":"BAD","message":"nope"}' }; } });
  await assert.rejects(d.checkout({}), (e) => e.status === 422 && /nope/.test(e.message));
  assert.equal(seen.url, 'https://test.dodopayments.com/checkouts');
  assert.equal(seen.init.headers.Authorization, 'Bearer dodo_test_x');
});

test('catalogue: every paid plan monthly and yearly, top-ups and Lifetime; Dodo statuses in our words', () => {
  const items = catalogueItems(pricing);
  assert.deepEqual(Object.keys(items).sort(), ['creator.month', 'creator.year', 'indie.month', 'indie.year', 'lifetime', 'studio.month', 'studio.year', 'topup15', 'topup5']);
  const byProduct = { p_c: { kind: 'plan', plan: 'creator', interval: 'month' }, p_i: { kind: 'plan', plan: 'indie', interval: 'month' } };
  const s = normaliseSubscription({ subscription_id: 's', product_id: 'p_c', status: 'past_due', next_billing_date: 'n', cancel_at_next_billing_date: false, customer: { customer_id: 'c' }, scheduled_change: { product_id: 'p_i', effective_at: 'e' } }, byProduct);
  assert.deepEqual([s.status, s.plan, s.pending.plan, s.customerId], ['on_hold', 'creator', 'indie', 'c']);
  assert.equal(normaliseSubscription({ product_id: 'someone-else' }, byProduct), null);
});

/** A fake Dodo that keeps subscriptions and payments in memory, and records every call. */
function fakeDodo() {
  const subs = {}, payments = {}, refunds = {}, disputes = {}, calls = [];
  const rec = (name, ...a) => calls.push([name, ...a]);
  return {
    ready: true, subs, payments, refunds, disputes, calls,
    async checkout(body) { rec('checkout', body); return { checkout_url: 'https://pay/x', session_id: 'cs_1' }; },
    async subscription(id) { if (!subs[id]) throw Object.assign(new Error('nope'), { status: 404 }); return subs[id]; },
    async payment(id) { return payments[id]; },
    async refund(id) { return refunds[id]; },
    async dispute(id) { return disputes[id]; },
    async updateSubscription(id, body) { rec('update', id, body); if ('cancel_at_next_billing_date' in body) subs[id].cancel_at_next_billing_date = body.cancel_at_next_billing_date; return subs[id]; },
    async changePlan(id, body) {
      rec('change', id, body);
      if (body.effective_at === 'next_billing_date') subs[id].scheduled_change = { product_id: body.product_id, effective_at: subs[id].next_billing_date };
      else { subs[id].product_id = body.product_id; subs[id].scheduled_change = null; }
      return {};
    },
    async cancelScheduledChange(id) { rec('unschedule', id); subs[id].scheduled_change = null; return {}; },
    async portal(c, body) { rec('portal', c, body); return { link: 'https://portal/x' }; },
  };
}
const products = { 'indie.month': 'p_im', 'indie.year': 'p_iy', 'creator.month': 'p_cm', 'creator.year': 'p_cy', 'studio.month': 'p_sm', 'studio.year': 'p_sy', topup5: 'p_t5', topup15: 'p_t15', lifetime: 'p_life' };

async function harness(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pay-'));
  const accounts = await makeAccounts({ dir, pricing });
  const dodo = fakeDodo();
  const quiet = { log() {}, warn() {} };
  const pay = makePayRoutes({ dodo, accounts, pricing, products, publicBase: () => 'https://hc', webhookSecret: secret, log: quiet });
  const app = express();
  app.use('/api/pay', pay.api); app.use(pay.pages);
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const u = await accounts.signup({ email: 'c@x.co', password: 'longenough' });
  const cookie = accounts.cookieFor(u, { secure: false }).split(';')[0];
  const post = async (path, body) => { const r = await fetch(`${base}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const hook = async (event) => {
    const body = JSON.stringify(event), ts = String(Math.floor(Date.now() / 1000));
    return (await fetch(`${base}/api/pay/webhook`, { method: 'POST', headers: { 'webhook-id': 'm', 'webhook-timestamp': ts, 'webhook-signature': sign('m', ts, body) }, body })).status;
  };
  const subscribe = async (product = 'p_cm') => {
    dodo.subs.sub_1 = { subscription_id: 'sub_1', product_id: product, status: 'active', next_billing_date: new Date(Date.now() + 20 * 864e5).toISOString(), created_at: new Date().toISOString(), cancel_at_next_billing_date: false, customer: { customer_id: 'cus_1', email: 'c@x.co' }, metadata: { userId: u.id } };
    assert.equal(await hook({ type: 'subscription.active', data: { subscription_id: 'sub_1' } }), 200);
  };
  try { await fn({ accounts, dodo, u, post, hook, subscribe, base, cookie, pay }); }
  finally { server.close(); await rm(dir, { recursive: true }); }
}
const ent = (accounts, u) => accounts.pub(accounts.get(u.id));

test('checkout: plans carry who and what; top-ups need a plan; one plan at a time', () => harness(async ({ dodo, post, subscribe }) => {
  assert.equal((await post('/api/pay/checkout', { kind: 'topup', id: 'topup5' })).body.code, 'plan', 'Free accounts choose a plan first');
  const r = await post('/api/pay/checkout', { kind: 'plan', id: 'creator', interval: 'year' });
  assert.equal(r.body.url, 'https://pay/x');
  const body = dodo.calls.find((c) => c[0] === 'checkout')[1];
  assert.equal(body.product_cart[0].product_id, 'p_cy');
  assert.deepEqual([body.metadata.kind, body.metadata.plan, body.metadata.interval], ['plan', 'creator', 'year']);
  assert.equal((await post('/api/pay/checkout', { kind: 'plan', id: 'nope' })).status, 400);
  await subscribe();
  assert.equal((await post('/api/pay/checkout', { kind: 'plan', id: 'studio' })).body.code, 'has_plan');
  assert.equal((await post('/api/pay/checkout', { kind: 'topup', id: 'topup5' })).status, 200, 'top-ups once on a plan');
}));

test('subscribe → upgrade now → downgrade at period end → keep → cancel → resume', () => harness(async ({ accounts, dodo, u, post, subscribe }) => {
  await subscribe('p_im');
  assert.deepEqual([ent(accounts, u).plan, ent(accounts, u).videos.left], ['indie', 5]);
  await accounts.spend(u.id, 2, { resolution: '480p' });

  let r = await post('/api/pay/change', { plan: 'creator', interval: 'month' });
  assert.equal(r.status, 200);
  const up = dodo.calls.find((c) => c[0] === 'change')[2];
  assert.deepEqual([up.product_id, up.proration_billing_mode, up.effective_at, up.on_payment_failure], ['p_cm', 'prorated_immediately', 'immediately', 'prevent_change']);
  assert.deepEqual([r.body.account.plan, r.body.account.videos.left], ['creator', 13], 'upgrade: now, used videos still count');

  r = await post('/api/pay/change', { plan: 'indie', interval: 'month' });
  const down = dodo.calls.filter((c) => c[0] === 'change')[1][2];
  assert.equal(down.effective_at, 'next_billing_date');
  assert.equal(r.body.account.plan, 'creator', 'downgrade waits for the end of the paid period');
  assert.equal(r.body.account.sub.pending.plan, 'indie');

  r = await post('/api/pay/keep');
  assert.equal(r.body.account.sub.pending, null);

  r = await post('/api/pay/cancel', { feedback: 'too_expensive' });
  assert.deepEqual(dodo.calls.find((c) => c[0] === 'update')[2], { cancel_at_next_billing_date: true, cancellation_feedback: 'too_expensive' });
  assert.deepEqual([r.body.account.status, r.body.account.plan], ['ending', 'creator'], 'keeps the plan until the paid-through date');

  r = await post('/api/pay/resume');
  assert.equal(r.body.account.status, 'active');
  assert.equal((await post('/api/pay/portal')).body.url, 'https://portal/x');
}));

test('renewal failure pauses plan videos; recovery restores them; the end of a plan is Free with top-ups kept', () => harness(async ({ accounts, dodo, u, hook, subscribe }) => {
  await subscribe();
  await accounts.addTopup(u.id, 3, 'test');
  dodo.subs.sub_1.status = 'on_hold';
  await hook({ type: 'subscription.on_hold', data: { subscription_id: 'sub_1' } });
  assert.deepEqual([ent(accounts, u).status, ent(accounts, u).videos.left, ent(accounts, u).videos.topup, ent(accounts, u).features.exportData], ['on_hold', 0, 3, true]);
  dodo.subs.sub_1.status = 'active';
  await hook({ type: 'subscription.renewed', data: { subscription_id: 'sub_1' } });
  assert.equal(ent(accounts, u).videos.left, 15);
  dodo.subs.sub_1.status = 'expired';
  await hook({ type: 'subscription.expired', data: { subscription_id: 'sub_1' } });
  assert.deepEqual([ent(accounts, u).plan, ent(accounts, u).videos.left, ent(accounts, u).videos.topup, ent(accounts, u).features.exportData], ['free', 0, 3, false]);
}));

test('one-time payments: top-up credited once (return page or webhook); refunds and chargebacks take back the unspent part', () => harness(async ({ accounts, dodo, u, hook, subscribe, base }) => {
  await subscribe();
  dodo.payments.pay_1 = { payment_id: 'pay_1', status: 'succeeded', total_amount: 1500, currency: 'USD', metadata: { userId: u.id, kind: 'topup', itemId: 'topup5' } };
  const back = await fetch(`${base}/pay/return?back=desk&payment_id=pay_1`, { redirect: 'manual' });
  assert.equal(back.headers.get('location'), '/desk?paid=ok');
  await hook({ type: 'payment.succeeded', data: { payment_id: 'pay_1' } });
  assert.equal(accounts.get(u.id).topup, 5, 'credited once');
  dodo.refunds.ref_1 = { refund_id: 'ref_1', payment_id: 'pay_1', status: 'succeeded', amount: 600 };
  await hook({ type: 'refund.succeeded', data: { refund_id: 'ref_1' } });
  assert.equal(accounts.get(u.id).topup, 3, 'a 40% refund takes back 2 of 5');
  dodo.disputes.dp_1 = { dispute_id: 'dp_1', payment_id: 'pay_1', dispute_status: 'dispute_opened' };
  await hook({ type: 'dispute.opened', data: { dispute_id: 'dp_1' } });
  assert.equal(ent(accounts, u).hold, true);
  assert.equal(ent(accounts, u).videos.total, 0);
  dodo.disputes.dp_1.dispute_status = 'dispute_won';
  await hook({ type: 'dispute.won', data: { dispute_id: 'dp_1' } });
  assert.equal(ent(accounts, u).hold, false);
  assert.equal(ent(accounts, u).videos.topup, 3);
}));

test('the return page after a plan checkout confirms the subscription with Dodo', () => harness(async ({ accounts, dodo, u, base }) => {
  dodo.subs.sub_7 = { subscription_id: 'sub_7', product_id: 'p_sm', status: 'active', next_billing_date: new Date(Date.now() + 30 * 864e5).toISOString(), customer: { customer_id: 'cus_7', email: 'c@x.co' }, metadata: {} };
  const r = await fetch(`${base}/pay/return?back=desk&subscription_id=sub_7&status=active`, { redirect: 'manual' });
  assert.equal(r.headers.get('location'), '/desk?paid=plan');
  assert.equal(ent(accounts, u).plan, 'studio', 'found by the checkout email when metadata is missing');
  const none = await fetch(`${base}/pay/return?back=desk`, { redirect: 'manual' });
  assert.equal(none.headers.get('location'), '/desk?paid=cancelled');
}));

test('Lifetime: bought once, limited, gives features and no monthly videos', () => harness(async ({ accounts, dodo, u, hook, post }) => {
  dodo.payments.pay_l = { payment_id: 'pay_l', status: 'succeeded', total_amount: 12900, currency: 'USD', metadata: { userId: u.id, kind: 'lifetime', itemId: 'lifetime' } };
  await hook({ type: 'payment.succeeded', data: { payment_id: 'pay_l' } });
  assert.deepEqual([ent(accounts, u).plan, ent(accounts, u).features.exportData, ent(accounts, u).videos.included], ['lifetime', true, 0]);
  assert.equal((await post('/api/pay/checkout', { kind: 'lifetime', id: 'lifetime' })).body.code, 'has_plan');
  assert.equal((await post('/api/pay/checkout', { kind: 'topup', id: 'topup15' })).status, 200, 'Lifetime can buy top-ups');
}));
