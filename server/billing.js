// What Make video costs a customer, in videos. Prices and plans live in config/pricing.json (docs/PRICING-PLAN.md).
// Customers never see our AI cost in dollars (PLAN Phase 5, DECISIONS §30).
import { readFileSync } from 'node:fs';
import { checkPricing } from './plans.js';

export function loadPricing(path) {
  const p = JSON.parse(readFileSync(path, 'utf8'));
  const errors = checkPricing(p);
  if (errors.length) throw new Error(`${path}: ${errors.join('; ')}`);
  return p;
}

/** Videos one version costs: by quality, doubled for long takes. Practice is free unless chargePractice (testing). */
export function unitsPerVersion(pricing, { provider, resolution, durationS }, { chargePractice = false } = {}) {
  if (provider === 'mock' && !chargePractice) return 0;
  const q = pricing.qualityUnits[resolution] ?? pricing.qualityUnits[Object.keys(pricing.qualityUnits)[0]] ?? 1;
  return q * (durationS > (pricing.longTakeSeconds ?? 8) ? 2 : 1);
}

/**
 * Settle a job against what was reserved: the customer pays for every version made
 * (job.billing.charged); versions that failed to generate come back. → videos to refund now (≥ 0).
 */
export function refundDue(job) {
  if (!job.charge) return 0;
  const owed = job.status === 'failed' ? 0 : (job.billing?.charged ?? 0) * job.charge.unit;
  return Math.max(0, job.charge.reserved - job.charge.refunded - owed);
}
