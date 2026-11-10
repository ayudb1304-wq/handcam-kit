// Supabase (Phase 5d): sign-in (Google only: DECISIONS §49) and the accounts database. Plain fetch,
// no SDK on the server, no new dependency.
//  - Who someone is: the browser signs in with Supabase Auth and sends its access token once; we ask Supabase
//    (GET /auth/v1/user) whether it's real, then give them CineHand's own session cookie (accounts.js).
//  - Where accounts live: tables handcam_accounts / handcam_payments (RLS on, no policies: only the secret key on this
//    server can read or write them). Keys: the publishable key is public (it's sent to browsers); the secret key
//    (sb_secret_…) stays in the server's environment and goes on the `apikey` header only (Supabase docs).

export function makeSupabase({ url, publishableKey, secretKey, fetchImpl = fetch, log = console }) {
  const base = String(url || '').replace(/\/$/, '');
  const authReady = !!(base && publishableKey), dbReady = !!(base && secretKey);

  async function rest(method, path, body, prefer) {
    const r = await fetchImpl(`${base}/rest/v1/${path}`, {
      method,
      headers: { apikey: secretKey, 'Content-Type': 'application/json', ...(prefer && { Prefer: prefer }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]} ${r.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null; // an upsert with return=minimal answers 201 with an empty body
  }
  // Storage: one private bucket, reachable only with the secret key (the gateway turns `apikey` into the service role).
  const BUCKET = 'handcam-videos';
  async function object(method, key, { body, type, json } = {}) {
    const r = await fetchImpl(`${base}/storage/v1/object/${BUCKET}${key ? `/${key.split('/').map(encodeURIComponent).join('/')}` : ''}`, {
      method, headers: { apikey: secretKey, ...(type && { 'Content-Type': type }), ...(method === 'POST' && { 'x-upsert': 'true' }), ...(json && { 'Content-Type': 'application/json' }) },
      body: json ? JSON.stringify(json) : body,
    });
    if (r.status === 404 || (r.status === 400 && method === 'GET')) return null; // not there
    if (!r.ok) throw new Error(`Supabase storage ${method} ${key || ''} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r;
  }
  async function all(table, select) { // page through everything (a few thousand rows at most for now)
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const page = await rest('GET', `${table}?select=${select}&order=id&offset=${from}&limit=1000`);
      rows.push(...page);
      if (page.length < 1000) return rows;
    }
  }

  return {
    authReady, dbReady,
    /** What the browser needs to sign in: both values are public by design. */
    publicConfig: () => (authReady ? { url: base, publishableKey } : null),

    /** The Supabase user behind an access token, or null. → { id, email, name, verified, google } */
    async userFromToken(token) {
      if (!authReady || !token) return null;
      const r = await fetchImpl(`${base}/auth/v1/user`, { headers: { apikey: publishableKey, Authorization: `Bearer ${token}` } });
      if (!r.ok) return null;
      const u = await r.json();
      const meta = u.user_metadata || {};
      // google: this person has a Google identity. An email + password user made straight against Supabase's API has none.
      const providers = [u.app_metadata?.provider, ...(u.app_metadata?.providers || []), ...(u.identities || []).map((i) => i.provider)];
      return { id: u.id, email: u.email, name: meta.full_name || meta.name || '', verified: !!(u.email_confirmed_at || u.confirmed_at), google: providers.includes('google') };
    },

    /** Remove someone's sign-in from Supabase Auth (when they delete their account). Needs the secret key. */
    async deleteAuthUser(authId) {
      if (!dbReady || !authId) return;
      const r = await fetchImpl(`${base}/auth/v1/admin/users/${encodeURIComponent(authId)}`, { method: 'DELETE', headers: { apikey: secretKey } });
      if (!r.ok && r.status !== 404) throw new Error(`Supabase auth delete ${r.status}`);
    },

    /** The accounts store for accounts.js: load everything once, then write only what changed. */
    store: dbReady ? {
      async load() {
        const [accounts, payments] = await Promise.all([all('handcam_accounts', 'id,data'), all('handcam_payments', 'id,data')]);
        const db = { users: {}, payments: {}, refunds: {}, gone: {} };
        for (const a of accounts) db.users[a.id] = a.data;
        for (const p of payments) {
          if (p.id.startsWith('refund:')) db.refunds[p.id.slice(7)] = p.data;
          else if (p.id.startsWith('gone:')) db.gone[p.id.slice(5)] = p.data; // a deleted account's marker (accounts.js)
          else db.payments[p.id] = p.data;
        }
        return db;
      },
      async saveUsers(users) {
        if (!users.length) return;
        await rest('POST', 'handcam_accounts?on_conflict=id', users.map((u) => ({ id: u.id, auth_id: u.authId || null, email: u.email, data: u, updated_at: new Date().toISOString() })), 'resolution=merge-duplicates,return=minimal');
      },
      /** Sets and takes saved to the account (server/library.js). `deleted` rows are markers, with no data. */
      library: {
        async list(acct) {
          const rows = [];
          for (let from = 0; ; from += 1000) {
            const page = await rest('GET', `handcam_library?select=kind,id,v,deleted&account_id=eq.${encodeURIComponent(acct)}&order=id&offset=${from}&limit=1000`);
            rows.push(...page);
            if (page.length < 1000) break;
          }
          return rows.map((x) => ({ kind: x.kind, id: x.id, v: Number(x.v), gone: !!x.deleted }));
        },
        async get(acct, kind, id) {
          const rows = await rest('GET', `handcam_library?select=data&account_id=eq.${encodeURIComponent(acct)}&kind=eq.${kind}&id=eq.${encodeURIComponent(id)}&deleted=is.false`);
          return rows[0]?.data || null;
        },
        async put(acct, kind, id, data, v) {
          await rest('POST', 'handcam_library?on_conflict=account_id,kind,id', [{ account_id: acct, kind, id, v, deleted: data == null, data }], 'resolution=merge-duplicates,return=minimal');
        },
        async remove(acct, kind, id) { await rest('DELETE', `handcam_library?account_id=eq.${encodeURIComponent(acct)}&kind=eq.${kind}&id=eq.${encodeURIComponent(id)}`, null, 'return=minimal'); },
        async clear(acct) { await rest('DELETE', `handcam_library?account_id=eq.${encodeURIComponent(acct)}`, null, 'return=minimal'); },
      },
      async removeUser(id) { await rest('DELETE', `handcam_accounts?id=eq.${encodeURIComponent(id)}`, null, 'return=minimal'); },
      async removeGenerations(accountId) { await rest('DELETE', `handcam_generations?account_id=eq.${encodeURIComponent(accountId)}`, null, 'return=minimal'); },
      /** A customer's videos (server/make/keep.js): the job's record, and its files in the private bucket. */
      async saveVideo(row) {
        await rest('POST', 'handcam_videos?on_conflict=id', [{ ...row, updated_at: new Date().toISOString() }], 'resolution=merge-duplicates,return=minimal');
      },
      async loadVideos() { return all('handcam_videos', 'id,data'); },
      async removeVideo(id) { await rest('DELETE', `handcam_videos?id=eq.${encodeURIComponent(id)}`, null, 'return=minimal'); },
      files: {
        async put(key, buf, type) { await object('POST', key, { body: buf, type }); },
        async get(key) { const r = await object('GET', key); return r ? Buffer.from(await r.arrayBuffer()) : null; },
        async remove(keys) { if (keys.length) await object('DELETE', '', { json: { prefixes: keys } }); },
      },
      /** The recipe's memory (server/learn.js): one row per AI version. The same version saved again replaces itself. */
      async saveGenerations(rows) {
        if (!rows.length) return;
        await rest('POST', 'handcam_generations?on_conflict=id', rows.map((r) => ({ id: r.id, job_id: r.job_id, account_id: r.account_id, recipe_id: r.recipe_id, recipe_hash: r.recipe_hash, status: r.status, move_match: r.match, created_at: r.created_at, data: r })), 'resolution=merge-duplicates,return=minimal');
      },
      async loadGenerations() { return (await all('handcam_generations', 'id,data')).map((x) => x.data); },
      async savePayments(entries) {
        if (!entries.length) return;
        await rest('POST', 'handcam_payments?on_conflict=id', entries.map(([id, p]) => ({ id, account_id: p.userId || null, data: p })), 'resolution=merge-duplicates,return=minimal');
      },
    } : null,
  };
}
