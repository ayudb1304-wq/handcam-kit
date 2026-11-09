import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSupabase } from './supa.js';
import { makeAccounts } from './accounts.js';
import { loadPricing } from './billing.js';

const pricing = loadPricing(new URL('../config/pricing.json', import.meta.url).pathname);

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
      if (t === 'Bearer good') return ok({ id: '11111111-1111-1111-1111-111111111111', email: 'Pat@Example.com', email_confirmed_at: '2026-11-09', user_metadata: { full_name: 'Pat' } });
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

test('tokens: Supabase vouches → user with verified flag; a bad token → null; secret key only on the apikey header', async () => {
  const { supa, calls } = fakeSupabase();
  assert.deepEqual(await supa.userFromToken('good'), { id: '11111111-1111-1111-1111-111111111111', email: 'Pat@Example.com', name: 'Pat', verified: true });
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
    const old = await makeAccounts({ dir, pricing });
    const legacy = await old.signup({ email: 'pat@example.com', password: 'longenough' });
    await old.flush();
    const { supa, tables, calls } = fakeSupabase();
    const warnings = [], quiet = { log() {}, warn: (...a) => warnings.push(a.join(' ')) };
    const a = await makeAccounts({ dir, pricing, store: supa.store, log: quiet });
    assert.equal(tables.handcam_accounts.size, 1, 'moved to the database on first start');
    // Google / confirmed email for the same address: the same account, now linked
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
    // password login on an account that never had a password says how to sign in
    await assert.rejects(again.login({ email: 'sam@example.com', password: 'whatever1' }), /Google/);
  } finally { await rm(dir, { recursive: true }); }
});
