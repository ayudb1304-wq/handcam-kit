import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPricing, unitsPerVersion, refundDue } from './billing.js';
import { makeAccounts } from './accounts.js';

const pricing = loadPricing(new URL('../config/pricing.json', import.meta.url).pathname);

test('units: by quality, doubled for long takes, practice free unless asked', () => {
  assert.equal(unitsPerVersion(pricing, { provider: 'higgsfield', resolution: '480p', durationS: 6 }), 1);
  assert.equal(unitsPerVersion(pricing, { provider: 'higgsfield', resolution: '1080p', durationS: 6 }), 5);
  assert.equal(unitsPerVersion(pricing, { provider: 'higgsfield', resolution: '720p', durationS: 12 }), 4);
  assert.equal(unitsPerVersion(pricing, { provider: 'mock', resolution: '480p', durationS: 6 }), 0);
  assert.equal(unitsPerVersion(pricing, { provider: 'mock', resolution: '480p', durationS: 6 }, { chargePractice: true }), 1);
});

test('refund: only versions at or above the line are paid; a failed job is fully refunded', () => {
  const job = { status: 'done', billing: { charged: 1 }, charge: { unit: 2, reserved: 6, refunded: 0 } };
  assert.equal(refundDue(job), 4);
  assert.equal(refundDue({ ...job, charge: { ...job.charge, refunded: 4 } }), 0, 'never twice');
  assert.equal(refundDue({ ...job, status: 'failed' }), 6);
  assert.equal(refundDue({ status: 'done' }), 0);
});

test('accounts: signup gives the free video, login checks the password, sessions are signed, balance never negative', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acct-'));
  try {
    const a = await makeAccounts({ dir, freeVideos: 1, adminEmails: ['boss@x.com'] });
    const u = await a.signup({ email: ' Friend@Example.com ', password: 'longenough', name: 'Fr' });
    assert.equal(u.email, 'friend@example.com');
    assert.equal(u.videos, 1);
    await assert.rejects(a.signup({ email: 'friend@example.com', password: 'longenough' }), /already/);
    await assert.rejects(a.signup({ email: 'x@y.z', password: 'short' }), /8 characters/);
    await assert.rejects(a.login({ email: 'friend@example.com', password: 'wrongwrong' }), /Wrong email or password/);
    assert.equal((await a.login({ email: 'FRIEND@example.com', password: 'longenough' })).id, u.id);
    const cookie = a.cookieFor(u, { secure: false }).split(';')[0];
    assert.equal(a.userFrom({ headers: { cookie } }).id, u.id);
    assert.equal(a.userFrom({ headers: { cookie: cookie.slice(0, -2) + 'xx' } }), null, 'a tampered cookie is refused');
    await assert.rejects(a.adjust(u.id, -2, 'too much'), (e) => e.status === 402);
    assert.equal(await a.adjust(u.id, -1, 'one video'), 0);
    assert.equal(await a.creditPayment('pay_1', { userId: u.id, videos: 10, packId: 'pack10' }), true);
    assert.equal(await a.creditPayment('pay_1', { userId: u.id, videos: 10, packId: 'pack10' }), false, 'credited once per payment');
    assert.equal(a.get(u.id).videos, 10);
    await a.flush();
    const again = await makeAccounts({ dir });
    assert.equal(again.get(u.id).videos, 10, 'saved to disk');
    assert.equal(again.userFrom({ headers: { cookie } }).id, u.id, 'the session key is kept');
  } finally { await rm(dir, { recursive: true }); }
});
