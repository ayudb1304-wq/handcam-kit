// Higgsfield API (https://docs.higgsfield.ai): upload media, submit a generation, poll it, download the output.
// Credentials stay on the server: HF_API_KEY_ID and HF_API_KEY_SECRET in .env (never in the browser, never in git).
import { readFile, writeFile } from 'node:fs/promises';

const BASE = 'https://api.higgsfield.ai';

export function higgsfieldReady(env = process.env) {
  return Boolean(env.HF_API_KEY_ID && env.HF_API_KEY_SECRET);
}

export function makeHiggsfield({ env = process.env, fetchImpl = fetch } = {}) {
  const auth = () => {
    if (!higgsfieldReady(env)) throw new Error('Higgsfield is not set up: add HF_API_KEY_ID and HF_API_KEY_SECRET to .env');
    return { Authorization: `Key ${env.HF_API_KEY_ID}:${env.HF_API_KEY_SECRET}` };
  };
  async function call(method, path, body, headers = {}) {
    const r = await fetchImpl(`${BASE}${path}`, {
      method,
      headers: { ...auth(), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = { detail: text.slice(0, 300) }; }
    if (!r.ok) {
      const msg = typeof json.detail === 'string' ? json.detail : JSON.stringify(json.detail ?? json).slice(0, 300);
      const err = new Error(`Higgsfield ${r.status}: ${msg}`);
      err.status = r.status;
      err.retryable = r.status >= 500 || r.status === 429;
      throw err;
    }
    return json;
  }
  return {
    name: 'higgsfield',
    /** Upload a local file; returns a public URL the models can read. */
    async upload(file, contentType) {
      const u = await call('POST', '/files/generate-upload-url', { content_type: contentType });
      const put = await fetchImpl(u.upload_url, { method: 'PUT', headers: u.upload_headers || { 'Content-Type': contentType }, body: await readFile(file) });
      if (!put.ok) throw new Error(`upload failed (${put.status})`);
      return u.public_url;
    },
    /** Start a generation. The idempotency key makes a retried submit return the same request, never a second charge. */
    async submit(endpoint, input, idempotencyKey) {
      const r = await call('POST', `/${endpoint}`, input, { 'Idempotency-Key': idempotencyKey });
      return { requestId: r.request_id };
    },
    /** { status: queued|in_progress|completed|failed|nsfw|canceled, result, error } */
    async status(requestId) {
      const r = await call('GET', `/requests/${encodeURIComponent(requestId)}/status`);
      return { status: r.status, result: r, error: r.error };
    },
    async download(url, file) {
      const r = await fetchImpl(url);
      if (!r.ok) throw new Error(`download failed (${r.status})`);
      await writeFile(file, Buffer.from(await r.arrayBuffer()));
    },
  };
}
