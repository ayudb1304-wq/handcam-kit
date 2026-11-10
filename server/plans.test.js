import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addMonths, cycleOf, entitlements, splitSpend, splitRefund, planDirection, subscriptionState, checkPricing, publicCatalogue } from './plans.js';
import { loadPricing } from './billing.js';
import { makeAccounts } from './accounts.js';

const pricing = loadPricing(fileURLToPath(new URL('../config/pricing.json', import.meta.url)));
const day = (s) => new Date(`${s}T12:00:00Z`);
const sub = (o = {}) => ({ id: 'sub_1', plan: 'creator', interval: 'month', status: 'active', anchor: '2026-11-05T12:00:00.000Z', paidThrough: '2026-12-05T12:00:00.000Z', cancelAtPeriodEnd: false, ...o });

test('the shipped pricing is complete, and the browser copy has no costs', () => {
  assert.deepEqual(checkPricing(pricing), []);
  const pub = JSON.stringify(publicCatalogue(pricing));
  assert.doesNotMatch(pub, /_note|apiUsd|cost/);
  assert.ok(checkPricing({ ...pricing, plans: pricing.plans.filter((p) => p.id !== 'free') }).length);
});

test('months: same day each month, clamped at month end, yearly plans reset monthly too', () => {
  assert.equal(addMonths('2026-01-31T00:00:00Z', 1).toISOString(), '2026-02-28T00:00:00.000Z');
  assert.equal(addMonths('2026-01-31T00:00:00Z', 2).toISOString(), '2026-03-31T00:00:00.000Z');
  const a = '2026-11-05T12:00:00.000Z';
  assert.equal(cycleOf(a, day('2026-11-20')).start.toISOString(), a);
  assert.equal(cycleOf(a, day('2026-12-05')).start.toISOString(), '2026-12-05T12:00:00.000Z');
  assert.equal(cycleOf(a, day('2027-03-01')).start.toISOString(), '2027-02-05T12:00:00.000Z');
  assert.equal(cycleOf(a, day('2027-03-01')).end.toISOString(), '2027-03-05T12:00:00.000Z');
});

test('entitlements: free has trial videos and no data export; a plan has its videos and features', () => {
  const free = entitlements({ trial: 2, topup: 0 }, pricing, { now: day('2026-11-10') });
  assert.equal(free.plan, 'free');
  assert.equal(free.videos.total, 2);
  assert.equal(free.features.exportData, false);
  assert.equal(free.features.topups, false);
  const c = entitlements({ trial: 0, topup: 3, sub: sub(), allowance: { cycle: '2026-11-05T12:00:00.000Z', used: 4 } }, pricing, { now: day('2026-11-10') });
  assert.deepEqual([c.plan, c.status, c.videos.left, c.videos.topup, c.videos.total], ['creator', 'active', 11, 3, 14]);
  assert.equal(c.features.exportData, true);
  assert.equal(c.features.priority, 1);
  assert.equal(c.videos.resetsAt, '2026-12-05T12:00:00.000Z');
});

test('monthly reset: unused plan videos do not roll over; used ones from last month do not count', () => {
  const u = { sub: sub(), allowance: { cycle: '2026-11-05T12:00:00.000Z', used: 15 } };
  assert.equal(entitlements(u, pricing, { now: day('2026-11-30') }).videos.left, 0);
  assert.equal(entitlements(u, pricing, { now: day('2026-12-06') }).videos.left, 15);
});

test('card failed (on hold): features stay, plan videos pause, top-ups still work', () => {
  const e = entitlements({ topup: 2, sub: sub({ status: 'on_hold' }) }, pricing, { now: day('2026-12-07') });
  assert.equal(e.status, 'on_hold');
  assert.equal(e.features.exportData, true);
  assert.equal(e.videos.left, 0);
  assert.equal(e.videos.total, 2);
});

test('cancelled: keeps the plan until the paid-through date, then Free (top-ups stay)', () => {
  const u = { topup: 4, trial: 0, sub: sub({ cancelAtPeriodEnd: true }) };
  assert.equal(entitlements(u, pricing, { now: day('2026-11-20') }).status, 'ending');
  assert.equal(entitlements(u, pricing, { now: day('2026-11-20') }).videos.left, 15);
  const ended = { ...u, sub: sub({ status: 'cancelled', cancelAtPeriodEnd: true }) };
  assert.equal(entitlements(ended, pricing, { now: day('2026-11-20') }).plan, 'creator', 'cancelled but still paid for');
  const after = entitlements(ended, pricing, { now: day('2026-12-06') });
  assert.deepEqual([after.plan, after.videos.total, after.features.exportData], ['free', 4, false]);
  assert.equal(subscriptionState(sub({ status: 'expired' }), day('2026-11-20')), null);
  assert.equal(subscriptionState(sub({ status: 'failed' }), day('2026-11-20')), null);
});

test('lifetime: features forever, no monthly videos, can still subscribe for videos; the founder has no gates', () => {
  const l = entitlements({ lifetime: { at: 'x' }, topup: 0 }, pricing, { now: day('2030-01-01') });
  assert.deepEqual([l.plan, l.features.exportData, l.features.byok, l.features.topups, l.videos.total], ['lifetime', true, true, true, 0]);
  const both = entitlements({ lifetime: { at: 'x' }, sub: sub({ plan: 'indie' }) }, pricing, { now: day('2026-11-10') });
  assert.deepEqual([both.plan, both.videos.left], ['indie', 5]);
  const f = entitlements(null, pricing, { admin: true });
  assert.equal(f.videos.unlimited, true);
  assert.equal(f.features.exportData, true);
  assert.equal(entitlements(null, pricing).plan, null, 'not signed in');
});

test('a chargeback hold pauses every video source', () => {
  const e = entitlements({ topup: 5, trial: 2, hold: { reason: 'dispute' }, sub: sub() }, pricing, { now: day('2026-11-10') });
  assert.equal(e.videos.total, 0);
  assert.equal(e.hold, true);
});

test('spend order: plan videos, then top-ups, then trial; refunds go back last-taken first', () => {
  assert.deepEqual(splitSpend({ left: 2, topup: 3, trial: 2 }, 4), { month: 2, topup: 2, trial: 0 });
  assert.deepEqual(splitSpend({ left: 0, topup: 1, trial: 2 }, 3), { month: 0, topup: 1, trial: 2 });
  assert.equal(splitSpend({ left: 1, topup: 0, trial: 0 }, 2), null);
  assert.deepEqual(splitRefund({ month: 2, topup: 2, trial: 1 }, 2), { trial: 1, topup: 1, month: 0 });
  assert.deepEqual(splitRefund({ month: 2, topup: 0, trial: 0 }, 5), { trial: 0, topup: 0, month: 2 }, 'never more than was taken');
});

test('plan direction: higher plan or monthly → yearly is an upgrade', () => {
  assert.equal(planDirection(pricing, { plan: 'indie', interval: 'month' }, { plan: 'creator', interval: 'month' }), 'upgrade');
  assert.equal(planDirection(pricing, { plan: 'creator', interval: 'month' }, { plan: 'creator', interval: 'year' }), 'upgrade');
  assert.equal(planDirection(pricing, { plan: 'studio', interval: 'year' }, { plan: 'creator', interval: 'year' }), 'downgrade');
  assert.equal(planDirection(pricing, { plan: 'creator', interval: 'year' }, { plan: 'creator', interval: 'month' }), 'downgrade');
  assert.equal(planDirection(pricing, { plan: 'creator', interval: 'year' }, { plan: 'creator', interval: 'year' }), 'same');
});

async function withAccounts(fn, clock = { t: day('2026-11-05') }) {
  const dir = await mkdtemp(join(tmpdir(), 'plans-'));
  try { await fn(await makeAccounts({ dir, pricing, now: () => clock.t }), dir, clock); } finally { await rm(dir, { recursive: true }); }
}

test('accounts: trial videos are 480p only; spending uses plan videos first and refunds return them', () => withAccounts(async (a) => {
  const { user: u } = await a.fromAuth({ authId: 'g-f', email: 'f@x.co' });
  assert.equal(a.pub(u).videos.trial, 2);
  await assert.rejects(a.spend(u.id, 2, { resolution: '720p' }), (e) => e.code === 'quality');
  await assert.rejects(a.spend(u.id, 3, { resolution: '480p' }), (e) => e.code === 'balance' && /Choose a plan/.test(e.message));
  const from = await a.spend(u.id, 2, { resolution: '480p' });
  assert.deepEqual([from.trial, a.get(u.id).trial], [2, 0]);
  await a.refund(u.id, from, 1);
  assert.equal(a.get(u.id).trial, 1, 'a failed version gives its trial video back');
}));

test('accounts: subscribe, use, upgrade keeps used videos and adds the difference, refund after the month becomes top-ups', () => withAccounts(async (a, dir, clock) => {
  const { user: u } = await a.fromAuth({ authId: 'g-c', email: 'c@x.co' });
  await a.syncSubscription(u.id, { id: 'sub_9', customerId: 'cus_1', plan: 'creator', interval: 'month', status: 'active', paidThrough: '2026-12-05T12:00:00.000Z', startedAt: '2026-11-05T12:00:00.000Z' });
  assert.equal(a.pub(a.get(u.id)).videos.left, 15);
  const from = await a.spend(u.id, 4, { resolution: '1080p' });
  assert.deepEqual([from.month, from.trial], [4, 0], 'plan videos before trial ones');
  await a.syncSubscription(u.id, { id: 'sub_9', plan: 'studio', interval: 'month', status: 'active', paidThrough: '2026-12-05T12:00:00.000Z' });
  assert.equal(a.pub(a.get(u.id)).videos.left, 36, 'Creator → Studio with 4 used: 40 − 4');
  assert.equal(a.get(u.id).sub.customerId, 'cus_1', 'kept from before');
  clock.t = day('2026-12-06');
  assert.equal(a.pub(a.get(u.id)).videos.left, 40, 'new month');
  await a.refund(u.id, from, 4);
  assert.equal(a.get(u.id).topup, 4, 'last month’s videos come back as top-ups');
  await a.syncSubscription(u.id, { id: 'sub_10', plan: 'indie', interval: 'month', status: 'failed' });
  assert.equal(a.get(u.id).sub.id, 'sub_9', 'a failed second checkout never replaces a live plan');
}));

test('accounts: payments count once, refunds take back only what is unspent, Lifetime can be refunded', () => withAccounts(async (a) => {
  const { user: u } = await a.fromAuth({ authId: 'g-p', email: 'p@x.co' });
  assert.equal(await a.recordPayment('pay_1', { kind: 'topup', userId: u.id, videos: 5, itemId: 'topup5' }), true);
  assert.equal(await a.recordPayment('pay_1', { kind: 'topup', userId: u.id, videos: 5, itemId: 'topup5' }), false);
  assert.equal(a.get(u.id).topup, 5);
  await a.spend(u.id, 3, {});
  await a.reversePayment('pay_1', { refundId: 'ref_1' });
  assert.equal(a.get(u.id).topup, 0, 'never below zero');
  assert.equal(await a.reversePayment('pay_1', { refundId: 'ref_1' }), false, 'once per refund');
  await a.recordPayment('pay_2', { kind: 'lifetime', userId: u.id });
  assert.equal(a.pub(a.get(u.id)).plan, 'lifetime');
  assert.equal(a.lifetimeCount(), 1);
  await a.reversePayment('pay_2', { refundId: 'ref_2' });
  assert.equal(a.pub(a.get(u.id)).plan, 'free');
  await a.setHold(u.id, 'dispute');
  await assert.rejects(a.spend(u.id, 1, {}), (e) => e.code === 'hold');
}));

test('accounts: the own AI key is encrypted at rest and never in the browser copy', () => withAccounts(async (a, dir) => {
  const { user: u } = await a.fromAuth({ authId: 'g-k', email: 'k@x.co' });
  await assert.rejects(a.setByok(u.id, { keyId: 'x', keySecret: '' }), /Higgsfield/);
  await a.setByok(u.id, { keyId: 'key-id-123', keySecret: 'super-secret-abcd' });
  assert.deepEqual(a.byokEnv(u.id), { HF_API_KEY_ID: 'key-id-123', HF_API_KEY_SECRET: 'super-secret-abcd' });
  assert.deepEqual(a.pub(a.get(u.id)).byok, { set: true, last4: 'abcd' });
  await a.flush();
  assert.doesNotMatch(await readFile(join(dir, 'accounts.json'), 'utf8'), /super-secret/);
  await a.clearByok(u.id);
  assert.equal(a.byokEnv(u.id), null);
}));

test('accounts from before plans keep their videos as top-ups', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mig-'));
  try {
    await writeFile(join(dir, 'accounts.json'), JSON.stringify({ users: { u1: { id: 'u1', email: 'old@x.co', videos: 7 } }, payments: {} }));
    await writeFile(join(dir, 'session.key'), 'k');
    const a = await makeAccounts({ dir, pricing });
    assert.deepEqual([a.get('u1').topup, a.get('u1').trial, 'videos' in a.get('u1')], [7, 0, false]);
  } finally { await rm(dir, { recursive: true }); }
});

test('a founder account that subscribed still sees its plan and subscription, with founder access', async () => {
  const { loadPricing } = await import('./billing.js');
  const pricing = loadPricing(fileURLToPath(new URL('../config/pricing.json', import.meta.url)));
  const now = new Date('2026-11-09T09:00:00Z');
  const user = { id: 'f', email: 'boss@x.com', trial: 0, topup: 0, sub: { id: 'sub_1', plan: 'creator', interval: 'month', status: 'active', anchor: '2026-11-09T08:30:00Z', paidThrough: '2026-12-09T08:30:00Z' }, allowance: null };
  const e = entitlements(user, pricing, { now, admin: true });
  assert.equal(e.plan, 'creator');
  assert.match(e.name, /Creator · founder/);
  assert.equal(e.sub.plan, 'creator');
  assert.equal(e.admin, true);
  assert.equal(e.videos.unlimited, true);
  const laptop = entitlements(null, pricing, { now, admin: true });
  assert.equal(laptop.plan, 'founder');
  assert.equal(laptop.sub, null);
});
