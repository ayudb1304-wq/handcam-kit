import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyWebhook, makeDodo, makePayRoutes } from './payments.js';
import { makeAccounts } from './accounts.js';
import { loadPricing } from './billing.js';

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

test('a confirmed payment credits its pack once, whoever reports it first; unpaid ones credit nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pay-'));
  try {
    const accounts = await makeAccounts({ dir, freeVideos: 1 });
    const u = await accounts.signup({ email: 'f@x.co', password: 'longenough' });
    const pricing = loadPricing(new URL('../config/pricing.json', import.meta.url).pathname);
    const { fulfil } = makePayRoutes({ dodo: {}, accounts, pricing, products: {}, publicBase: () => '' });
    const paid = { payment_id: 'pay_9', status: 'succeeded', total_amount: 2900, currency: 'USD', metadata: { userId: u.id, packId: 'pack10' } };
    assert.deepEqual(await fulfil({ ...paid, status: 'processing' }), { credited: false });
    assert.equal((await fulfil(paid)).credited, true);
    assert.equal((await fulfil(paid)).credited, false);
    assert.equal(accounts.get(u.id).videos, 11);
  } finally { await rm(dir, { recursive: true }); }
});
