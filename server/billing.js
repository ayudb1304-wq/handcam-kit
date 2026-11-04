// What Make video costs a customer, in videos (Phase 5). Prices live in config/pricing.json (placeholders until the
// pricing research is back). Customers never see our AI cost in dollars (PLAN Phase 5, DECISIONS §30).
import { readFileSync } from 'node:fs';

export function loadPricing(path) {
  const p = JSON.parse(readFileSync(path, 'utf8'));
  if (!p.qualityUnits || !Array.isArray(p.packs)) throw new Error(`${path}: needs qualityUnits and packs`);
  return p;
}

/** Videos one version costs: by quality, doubled for long takes. Practice is free unless chargePractice (testing). */
export function unitsPerVersion(pricing, { provider, resolution, durationS }, { chargePractice = false } = {}) {
  if (provider === 'mock' && !chargePractice) return 0;
  const q = pricing.qualityUnits[resolution] ?? pricing.qualityUnits[Object.keys(pricing.qualityUnits)[0]] ?? 1;
  return q * (durationS > (pricing.longTakeSeconds ?? 8) ? 2 : 1);
}

/**
 * Settle a job against what was reserved: the customer pays only for versions at or above the move-match line
 * (job.billing.charged); free and failed versions come back. → videos to refund now (≥ 0).
 */
export function refundDue(job) {
  if (!job.charge) return 0;
  const owed = job.status === 'failed' ? 0 : (job.billing?.charged ?? 0) * job.charge.unit;
  return Math.max(0, job.charge.reserved - job.charge.refunded - owed);
}
