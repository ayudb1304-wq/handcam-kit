import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSupabase } from './supa.js';
import { makeAccounts } from './accounts.js';
import { loadPricing } from './billing.js';

const pricing = loadPricing(fileURLToPath(new URL('../config/pricing.json', import.meta.url)));

/** A fake Supabase: REST tables in memory, and /auth/v1/user for two tokens. */
const table_ok = (u) => ['handcam_accounts', 'handcam_payments'].includes(u.pathname.split('/').pop());
function fakeSupabase() {
  const tables = { handcam_accounts: new Map(), handcam_payments: new Map() }, calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url), method = init.method || 'GET';
    calls.push({ method, path: u.pathname, headers: init.headers });
    const ok = (body, status = 200) => ({ ok: true, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (method === 'POST' && u.pathname.startsWith('/rest/') && !table_ok(u)) throw new Error('unknown table');
    if (u.pathname === '/auth/v1/user') {
      const t = init.headers.Authorization;
      if (t === 'Bearer good') return ok({ id: '11111111-1111-1111-1111-111111111111', email: 'Pat@Example.com', email_confirmed_at: '2026-11-09', user_metadata: { full_name: 'Pat' }, app_metadata: { provider: 'google', providers: ['google'] } });
      if (t === 'Bearer password') return ok({ id: '55555555-5555-5555-5555-555555555555', email: 'temp@mail.test', email_confirmed_at: '2026-11-09', user_metadata: {}, app_metadata: { provider: 'email', providers: ['email'] }, identities: [{ provider: 'email' }] });
      if (t === 'Bearer unconfirmed') return ok({ id: '22222222-2222-2222-2222-222222222222', email: 'new@example.com', user_metadata: {} });
      return { ok: false, status: 401, json: async () => ({}), text: async () => 'no' };
    }
    const table = tables[u.pathname.split('/').pop()];
    if (method === 'GET') return ok([...table.values()].slice(Number(u.searchParams.get('offset') || 0), Number(u.searchParams.get('offset') || 0) + 1000));
    for (const row of JSON.parse(init.body)) table.set(row.id, row);
    // like the real thing: 201 with an EMPTY body (json() would throw)
    return { ok: true, status: 201, json: async () => JSON.parse(''), text: async () => '' };
  };
  return { tables, calls, supa: makeSupabase({ url: 'https://x.supabase.co/', publishableKey: 'sb_publishable_x', secretKey: 'sb_secret_y', fetchImpl }) };
}

test('tokens: Supabase vouches → user with verified and google flags; a bad token → null; secret key only on the apikey header', async () => {
  const { supa, calls } = fakeSupabase();
  assert.deepEqual(await supa.userFromToken('good'), { id: '11111111-1111-1111-1111-111111111111', email: 'Pat@Example.com', name: 'Pat', verified: true, google: true });
  assert.equal((await supa.userFromToken('password')).google, false, 'an email + password user has no Google identity: index.js refuses it');
  assert.equal((await supa.userFromToken('unconfirmed')).verified, false);
  assert.equal(await supa.userFromToken('bad'), null);
  assert.deepEqual(supa.publicConfig(), { url: 'https://x.supabase.co', publishableKey: 'sb_publishable_x' });
  await supa.store.load();
  const rest = calls.find((c) => c.path.startsWith('/rest/'));
  assert.equal(rest.headers.apikey, 'sb_secret_y');
  assert.equal(rest.headers.Authorization, undefined, 'secret keys go on apikey only');
});

test('accounts on Supabase: file accounts move over once; only changed rows are written; sign-in links by email', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'supa-'));
  try {
    // an account made before Supabase, in the file
    const legacy = { id: 'legacy01', email: 'pat@example.com', hash: 'aa', salt: 'bb', created: '2026-11-01T00:00:00.000Z', trial: 2, topup: 0, ledger: [] };
    await writeFile(join(dir, 'accounts.json'), JSON.stringify({ users: { [legacy.id]: legacy }, payments: {} }));
    const { supa, tables, calls } = fakeSupabase();
    const warnings = [], quiet = { log() {}, warn: (...a) => warnings.push(a.join(' ')) };
    const a = await makeAccounts({ dir, pricing, store: supa.store, log: quiet });
    assert.equal(tables.handcam_accounts.size, 1, 'moved to the database on first start');
    assert.equal(tables.handcam_accounts.get(legacy.id).data.hash, undefined, 'old password hashes are dropped');
    // Google for the same address: the same account, now linked
    const { user, created } = await a.fromAuth({ authId: '11111111-1111-1111-1111-111111111111', email: 'Pat@Example.com', name: 'Pat' });
    assert.equal(created, false);
    assert.equal(user.id, legacy.id);
    assert.equal(tables.handcam_accounts.get(legacy.id).auth_id, '11111111-1111-1111-1111-111111111111');
    // a brand-new person gets a Free account with the trial videos
    const fresh = await a.fromAuth({ authId: '33333333-3333-3333-3333-333333333333', email: 'sam@example.com' });
    assert.equal(fresh.created, true);
    assert.equal(fresh.user.trial, pricing.trial.videos);
    // a save with nothing changed writes nothing
    const before = calls.filter((c) => c.method === 'POST').length;
    await a.flush(); await a.adjust?.call; // no-op
    assert.equal(calls.filter((c) => c.method === 'POST').length, before);
    // the database is the source of truth on the next start
    const again = await makeAccounts({ dir, pricing, store: supa.store, log: quiet });
    assert.equal(again.byEmail('sam@example.com').authId, '33333333-3333-3333-3333-333333333333');
    // an account linked to another sign-in can't be taken over by a different one with the same email
    await assert.rejects(again.fromAuth({ authId: '44444444-4444-4444-4444-444444444444', email: 'sam@example.com' }), /different sign-in/);
    // every save went through (a save that fails is only logged, so check the log)
    await again.flush();
    assert.deepEqual(warnings, []);
  } finally { await rm(dir, { recursive: true }); }
});

test('one free trial per device and per network: a second Google account there starts with no free videos', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trial-'));
  try {
    const clock = { t: new Date('2026-11-10T12:00:00Z') };
    const a = await makeAccounts({ dir, pricing, now: () => clock.t, adminEmails: ['boss@x.com'] });
    const first = await a.fromAuth({ authId: 'g1', email: 'one@gmail.com', device: 'devA', network: '203.0.113.7' });
    assert.deepEqual([first.trial, first.user.trial], [true, 2]);
    assert.notEqual(first.user.origin.net, '203.0.113.7', 'the address is kept only as a keyed hash');
    const sameDevice = await a.fromAuth({ authId: 'g2', email: 'two@gmail.com', device: 'devA', network: '198.51.100.9' });
    assert.deepEqual([sameDevice.created, sameDevice.trial, sameDevice.user.trial], [true, false, 0], 'same browser, another network');
    const sameNetwork = await a.fromAuth({ authId: 'g3', email: 'three@gmail.com', device: 'devB', network: '203.0.113.7' });
    assert.equal(sameNetwork.user.trial, 0, 'cookies cleared, same network');
    const elsewhere = await a.fromAuth({ authId: 'g4', email: 'four@gmail.com', device: 'devC', network: '192.0.2.44' });
    assert.equal(elsewhere.user.trial, 2, 'someone else, somewhere else');
    assert.equal((await a.fromAuth({ authId: 'g1', email: 'one@gmail.com', device: 'devZ', network: '192.0.2.99' })).user.trial, 2, 'signing in again changes nothing');
    assert.equal((await a.fromAuth({ authId: 'g5', email: 'boss@x.com', device: 'devA', network: '203.0.113.7' })).user.trial, 2, 'the founder can always test');
    clock.t = new Date('2026-12-20T12:00:00Z');
    assert.equal((await a.fromAuth({ authId: 'g6', email: 'six@gmail.com', device: 'devD', network: '203.0.113.7' })).user.trial, 2, 'the network rule lapses after 30 days (addresses get reused)');
    assert.equal((await a.fromAuth({ authId: 'g7', email: 'seven@gmail.com', device: 'devA', network: '192.0.2.200' })).user.trial, 0, 'the device rule does not');
    // the device cookie is signed
    const dev = a.newDevice(), cookie = a.deviceCookie(dev, { secure: true }).split(';')[0];
    assert.equal(a.deviceFrom({ headers: { cookie } }), dev);
    assert.equal(a.deviceFrom({ headers: { cookie: `hc_dev=${dev}.forged` } }), null);
    // an account from before origins were kept counts from its next sign-in
    const b = await makeAccounts({ dir: join(dir, 'b'), pricing });
    const { user: old } = await b.fromAuth({ authId: 'o1', email: 'old@gmail.com' });
    assert.equal(old.origin.device, null);
    delete old.origin;
    await b.fromAuth({ authId: 'o1', email: 'old@gmail.com', device: 'devQ', network: '203.0.113.50' });
    assert.equal((await b.fromAuth({ authId: 'o2', email: 'new@gmail.com', device: 'devQ', network: '192.0.2.1' })).user.trial, 0);
  } finally { await rm(dir, { recursive: true }); }
});

test('deleting an account removes its row from memory, the file and the database; what it paid stays', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'del-'));
  try {
    const { supa, tables } = fakeSupabase();
    const removed = [];
    const store = { ...supa.store, removeUser: async (id) => { removed.push(id); tables.handcam_accounts.delete(id); } };
    const a = await makeAccounts({ dir, pricing, store, log: { log() {}, warn() {} } });
    const { user } = await a.fromAuth({ authId: 'g-del', email: 'gone@example.com' });
    await a.recordPayment('pay_1', { kind: 'topup', userId: user.id, videos: 5, itemId: 'topup5', amount: 1500, currency: 'USD' });
    assert.deepEqual(a.paymentsOf(user.id).map((p) => [p.id, p.item]), [['pay_1', 'topup5']]);
    assert.equal(await a.remove(user.id), true);
    assert.deepEqual([a.get(user.id), a.byEmail('gone@example.com'), removed, tables.handcam_accounts.has(user.id)], [null, null, [user.id], false]);
    assert.ok(a.payment('pay_1'), 'the record of the payment is kept');
    const again = await makeAccounts({ dir, pricing, store, log: { log() {}, warn() {} } });
    assert.equal(again.byEmail('gone@example.com'), null, 'and it stays gone after a restart');
    assert.equal(await a.remove('nobody'), false);
  } finally { await rm(dir, { recursive: true }); }
});
