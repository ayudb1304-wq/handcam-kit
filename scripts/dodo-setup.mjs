// npm run dodo:setup — make sure everything sold in config/pricing.json exists as a Dodo product (test mode unless
// DODO_MODE=live): each paid plan monthly and yearly (subscriptions), the top-ups and Lifetime (one-time). Writes the
// ids to config/dodo-products.<mode>.json. Safe to run again: existing products (matched by metadata.handcam_item)
// are reused, never duplicated. A changed price needs a new plan id (subscribers keep the product they bought).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { makeDodo, catalogueItems } from '../server/payments.js';
import { loadPricing } from '../server/billing.js';

if (existsSync('.env') && process.loadEnvFile) process.loadEnvFile('.env');
const mode = process.env.DODO_MODE === 'live' ? 'live' : 'test';
const key = process.env.DODO_PAYMENTS_API_KEY;
if (!key) { console.error('Put DODO_PAYMENTS_API_KEY=… in .env first (Dodo dashboard → Developer → API Keys, in Test mode).'); process.exit(1); }
if (mode === 'test' && !key.startsWith('dodo_test_') && !/test/i.test(key.slice(0, 12))) console.warn('Note: this key does not look like a test key; Dodo will refuse it on the test host if it is live.');

const dodo = makeDodo({ apiKey: key, mode });
const pricing = loadPricing('config/pricing.json');
const currency = pricing.currency || 'USD';
const out = `config/dodo-products.${mode}.json`;
const ids = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
const existing = [...((await dodo.listProducts(false)).items || []), ...((await dodo.listProducts(true)).items || [])];

const describe = (item) => item.kind === 'plan'
  ? `${pricing.plans.find((p) => p.id === item.plan).videosPerMonth} move-checked AI videos a month, JSON and Blender export, your own AI key.`
  : item.kind === 'topup' ? `${item.videos} extra HandCam videos for your plan. They never expire.` : 'HandCam forever: JSON and Blender export, use your own AI key, top-ups.';

for (const [itemKey, item] of Object.entries(catalogueItems(pricing))) {
  const found = existing.find((p) => p.metadata?.handcam_item === itemKey);
  if (found) { ids[itemKey] = found.product_id; console.log(`${itemKey}: exists (${found.product_id})`); continue; }
  const price = item.kind === 'plan'
    ? { type: 'recurring_price', price: Math.round(item.usd * 100), currency, discount_bps: 0, purchasing_power_parity: false,
        payment_frequency_count: 1, payment_frequency_interval: item.interval === 'year' ? 'Year' : 'Month',
        subscription_period_count: 20, subscription_period_interval: 'Year', trial_period_days: 0 } // 20 years = until cancelled (Dodo's recommendation)
    : { type: 'one_time_price', price: Math.round(item.usd * 100), currency, discount_bps: 0, purchasing_power_parity: false };
  const made = await dodo.createProduct({ name: item.name, description: describe(item), tax_category: 'saas', price, metadata: { handcam_item: itemKey } });
  ids[itemKey] = made.product_id;
  console.log(`${itemKey}: created (${made.product_id}) at $${item.usd}${item.kind === 'plan' ? `/${item.interval}` : ''}`);
}
writeFileSync(out, JSON.stringify(ids, null, 2) + '\n');
console.log(`saved ${out} (${mode} mode). Restart the server to use it.`);
console.log('Webhook (Dodo → Developer → Webhooks): https://<your link>/api/pay/webhook, events subscription.*, payment.succeeded, refund.succeeded, dispute.*');
