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

    /** The accounts store for accounts.js: load everything once, then write only what changed. */
    store: dbReady ? {
      async load() {
        const [accounts, payments] = await Promise.all([all('handcam_accounts', 'id,data'), all('handcam_payments', 'id,data')]);
        const db = { users: {}, payments: {}, refunds: {} };
        for (const a of accounts) db.users[a.id] = a.data;
        for (const p of payments) {
          if (p.id.startsWith('refund:')) db.refunds[p.id.slice(7)] = p.data;
          else db.payments[p.id] = p.data;
        }
        return db;
      },
      async saveUsers(users) {
        if (!users.length) return;
        await rest('POST', 'handcam_accounts?on_conflict=id', users.map((u) => ({ id: u.id, auth_id: u.authId || null, email: u.email, data: u, updated_at: new Date().toISOString() })), 'resolution=merge-duplicates,return=minimal');
      },
      async savePayments(entries) {
        if (!entries.length) return;
        await rest('POST', 'handcam_payments?on_conflict=id', entries.map(([id, p]) => ({ id, account_id: p.userId || null, data: p })), 'resolution=merge-duplicates,return=minimal');
      },
    } : null,
  };
}
