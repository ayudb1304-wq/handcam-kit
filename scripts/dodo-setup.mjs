// npm run dodo:setup — make sure every pack in config/pricing.json exists as a one-time product in Dodo (test mode
// unless DODO_MODE=live), and write their ids to config/dodo-products.<mode>.json. Safe to run again: existing
// products (matched by metadata.handcam_pack) are reused, never duplicated.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { makeDodo } from '../server/payments.js';
import { loadPricing } from '../server/billing.js';

if (existsSync('.env') && process.loadEnvFile) process.loadEnvFile('.env');
const mode = process.env.DODO_MODE === 'live' ? 'live' : 'test';
const key = process.env.DODO_PAYMENTS_API_KEY;
if (!key) { console.error('Put DODO_PAYMENTS_API_KEY=… in .env first (Dodo dashboard → Developer → API Keys, in Test mode).'); process.exit(1); }
if (mode === 'test' && !key.startsWith('dodo_test_') && !/test/i.test(key.slice(0, 12))) console.warn('Note: this key does not look like a test key; Dodo will refuse it on the test host if it is live.');

const dodo = makeDodo({ apiKey: key, mode });
const pricing = loadPricing('config/pricing.json');
const out = `config/dodo-products.${mode}.json`;
const ids = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
const existing = (await dodo.listProducts()).items || [];
for (const pack of pricing.packs) {
  const found = existing.find((p) => p.metadata?.handcam_pack === pack.id);
  if (found) { ids[pack.id] = found.product_id; console.log(`${pack.id}: exists (${found.product_id})`); continue; }
  const made = await dodo.createProduct({
    name: `HandCam: ${pack.name}`, description: `${pack.videos} HandCam videos (move-checked AI video from your hand-shot camera move).`,
    tax_category: 'saas', price: { type: 'one_time_price', price: Math.round(pack.usd * 100), currency: pricing.currency || 'USD', discount_bps: 0, purchasing_power_parity: false },
    metadata: { handcam_pack: pack.id, videos: pack.videos },
  });
  ids[pack.id] = made.product_id;
  console.log(`${pack.id}: created (${made.product_id}) at $${pack.usd}`);
}
writeFileSync(out, JSON.stringify(ids, null, 2) + '\n');
console.log(`saved ${out} (${mode} mode). Restart the server to use it.`);
