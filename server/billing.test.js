import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPricing, unitsPerVersion, refundDue } from './billing.js';
import { makeAccounts } from './accounts.js';

const pricing = loadPricing(fileURLToPath(new URL('../config/pricing.json', import.meta.url)));

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

test('accounts: a Google sign-in makes the account, sessions are signed and survive a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acct-'));
  try {
    const a = await makeAccounts({ dir, pricing, adminEmails: ['boss@x.com'] });
    const { user: u, created } = await a.fromAuth({ authId: 'g-1', email: ' Friend@Example.com ', name: 'Fr' });
    assert.equal(created, true);
    assert.equal(u.email, 'friend@example.com');
    assert.equal(u.trial, pricing.trial.videos);
    assert.equal((await a.fromAuth({ authId: 'g-1', email: 'FRIEND@example.com' })).user.id, u.id, 'the same person signs in again');
    await assert.rejects(a.fromAuth({ authId: 'g-1', email: 'not an email' }), /email/);
    assert.equal(a.signup, undefined, 'no email + password accounts');
    assert.equal(a.login, undefined);
    const cookie = a.cookieFor(u, { secure: false }).split(';')[0];
    assert.equal(a.userFrom({ headers: { cookie } }).id, u.id);
    assert.equal(a.userFrom({ headers: { cookie: cookie.slice(0, -2) + 'xx' } }), null, 'a tampered cookie is refused');
    await a.addTopup(u.id, 10, 'test');
    await a.flush();
    const again = await makeAccounts({ dir, pricing });
    assert.equal(again.get(u.id).topup, 10, 'saved to disk');
    assert.equal(again.userFrom({ headers: { cookie } }).id, u.id, 'the session key is kept');
  } finally { await rm(dir, { recursive: true }); }
});
