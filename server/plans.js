// Plans and paywalls (Phase 5c, docs/PRICING-PLAN.md): what an account may do and how many videos it has, worked out
// from its stored state and the clock. Pure functions, no I/O: every rule in the plan doc is unit-tested here.
//
// Stored on an account (accounts.js):
//   sub       { id, customerId, plan, interval, status, anchor, paidThrough, cancelAtPeriodEnd, pending } | null
//   allowance { cycle, used }   this month's plan videos used (cycle = ISO start of the month it counts for)
//   topup     videos bought as top-ups (never expire)
//   trial     the sign-up videos (480p, watermarked)
//   lifetime  { at, paymentId } | null
//   hold      { reason, at } | null   a chargeback is open: no real AI until it's settled

export const INTERVALS = ['month', 'year'];
const FEATURE_KEYS = ['exportData', 'byok', 'topups', 'priority', 'commercial'];

/** Problems with config/pricing.json, as short strings. */
export function checkPricing(p) {
  const e = [];
  if (!p?.qualityUnits || typeof p.qualityUnits !== 'object') e.push('qualityUnits missing');
  if (!Array.isArray(p?.plans) || !p.plans.some((x) => x.id === 'free')) e.push('plans must include "free"');
  for (const x of p?.plans || []) {
    if (!x.id || !x.name || !Number.isInteger(x.rank)) e.push(`plan ${x.id || '?'}: id, name and rank needed`);
    if (!INTERVALS.every((i) => Number.isFinite(x.price?.[i]))) e.push(`plan ${x.id}: price.month and price.year needed`);
    if (!Number.isInteger(x.videosPerMonth) || x.videosPerMonth < 0) e.push(`plan ${x.id}: videosPerMonth must be a whole number`);
    if (!FEATURE_KEYS.every((k) => k in (x.features || {}))) e.push(`plan ${x.id}: features needs ${FEATURE_KEYS.join(', ')}`);
  }
  if (p?.lifetime && !(p.lifetime.id && Number.isFinite(p.lifetime.usd) && p.lifetime.features)) e.push('lifetime needs id, usd, features');
  for (const t of p?.topups || []) if (!t.id || !Number.isInteger(t.videos) || !Number.isFinite(t.usd)) e.push(`topup ${t.id || '?'}: id, videos, usd needed`);
  if (p?.trial && !(Number.isInteger(p.trial.videos) && p.trial.quality)) e.push('trial needs videos and quality');
  return e;
}

export const planById = (pricing, id) => pricing.plans.find((p) => p.id === id) || null;

/** n calendar months after a date, keeping the day where it exists (31 Jan + 1 = 28/29 Feb, + 2 = 31 Mar). */
export function addMonths(date, n) {
  const d = new Date(date), day = d.getUTCDate();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return t;
}

/** The month a plan's videos count for: starts on the subscription's start day, every month (yearly plans too). */
export function cycleOf(anchor, now = new Date()) {
  const a = new Date(anchor), t = new Date(now);
  if (!(t > a)) return { start: a, end: addMonths(a, 1) };
  let k = (t.getUTCFullYear() - a.getUTCFullYear()) * 12 + (t.getUTCMonth() - a.getUTCMonth());
  while (k > 0 && addMonths(a, k) > t) k--;
  return { start: addMonths(a, k), end: addMonths(a, k + 1) };
}

/**
 * Is the subscription giving its plan right now?
 *  'active'  paid and renewing · 'ending' cancelled, still paid for until paidThrough · 'on_hold' the card failed:
 *  features stay, plan videos pause · null: no plan from it (ended, expired, failed, not started).
 */
export function subscriptionState(sub, now = new Date()) {
  if (!sub) return null;
  if (sub.status === 'active') return sub.cancelAtPeriodEnd ? 'ending' : 'active';
  if (sub.status === 'on_hold') return 'on_hold';
  if (sub.status === 'cancelled' && sub.paidThrough && new Date(sub.paidThrough) > new Date(now)) return 'ending';
  return null;
}

const FOUNDER = Object.freeze({ exportData: true, byok: true, topups: true, priority: 9, commercial: true });

/** The better of several feature sets: any true wins, the highest priority wins. */
function bestFeatures(...sets) {
  const out = {};
  for (const k of FEATURE_KEYS) {
    const vals = sets.filter(Boolean).map((s) => s[k]);
    out[k] = k === 'priority' ? Math.max(0, ...vals.map(Number).filter(Number.isFinite)) : vals.some(Boolean);
  }
  return out;
}

/**
 * Everything the studio and the server need to decide what this account may do, now.
 * `admin`: the founder's laptop or an ADMIN_EMAILS account: no gates, no charges.
 */
export function entitlements(user, pricing, { now = new Date(), admin = false } = {}) {
  const free = planById(pricing, 'free');
  const none = { included: 0, used: 0, left: 0, topup: 0, trial: 0, total: 0, resetsAt: null };
  if (admin) return { plan: 'founder', name: 'Founder', status: 'active', admin: true, features: { ...FOUNDER }, videos: { ...none, unlimited: true }, trialQuality: null, sub: null, lifetime: false, hold: false };
  if (!user) return { plan: null, name: 'Not signed in', status: null, admin: false, features: { ...free.features }, videos: none, trialQuality: pricing.trial?.quality ?? null, sub: null, lifetime: false, hold: false };

  const state = subscriptionState(user.sub, now);
  const subPlan = state ? planById(pricing, user.sub.plan) : null;
  const life = user.lifetime ? pricing.lifetime : null;
  const hold = !!user.hold;
  const cycle = subPlan ? cycleOf(user.sub.anchor, now) : null;
  const included = subPlan?.videosPerMonth ?? 0;
  const used = cycle && user.allowance?.cycle === cycle.start.toISOString() ? user.allowance.used : 0;
  const left = state === 'on_hold' || hold ? 0 : Math.max(0, included - used);
  const topup = hold ? 0 : Math.max(0, user.topup || 0), trial = hold ? 0 : Math.max(0, user.trial || 0);
  const plan = subPlan || (life ? null : free);
  return {
    plan: subPlan ? subPlan.id : life ? life.id : 'free',
    name: subPlan ? subPlan.name : life ? life.name : free.name,
    status: state || (life ? 'lifetime' : 'free'),
    admin: false,
    features: bestFeatures(subPlan?.features, life?.features, plan?.features, free.features),
    videos: { included, used, left, topup, trial, total: left + topup + trial, resetsAt: cycle && state !== 'on_hold' ? cycle.end.toISOString() : null, cycle: cycle?.start.toISOString() ?? null },
    trialQuality: pricing.trial?.quality ?? '480p',
    sub: subPlan ? { plan: subPlan.id, interval: user.sub.interval, status: user.sub.status, paidThrough: user.sub.paidThrough || null, cancelAtPeriodEnd: !!user.sub.cancelAtPeriodEnd, pending: user.sub.pending || null } : null,
    lifetime: !!life,
    hold,
  };
}

/** Which sources pay for `need` videos: this month's plan videos, then top-ups, then trial. null if not enough. */
export function splitSpend(videos, need) {
  let rest = need;
  const take = (have) => { const n = Math.min(Math.max(0, have), rest); rest -= n; return n; };
  const from = { month: take(videos.left), topup: take(videos.topup), trial: take(videos.trial) };
  return rest > 0 ? null : from;
}

/** Give `amount` videos back to what a job took them from, last-taken first: trial, then top-ups, then plan videos. */
export function splitRefund(from, amount) {
  let rest = Math.max(0, amount);
  const give = (have) => { const n = Math.min(Math.max(0, have || 0), rest); rest -= n; return n; };
  const trial = give(from.trial), topup = give(from.topup), month = give(from.month);
  return { trial, topup, month };
}

/** Moving between plans: 'upgrade' (higher plan, or monthly to yearly of the same plan), 'downgrade', or 'same'. */
export function planDirection(pricing, from, to) {
  const a = planById(pricing, from.plan)?.rank ?? 0, b = planById(pricing, to.plan)?.rank ?? 0;
  if (b !== a) return b > a ? 'upgrade' : 'downgrade';
  if (from.interval === to.interval) return 'same';
  return to.interval === 'year' ? 'upgrade' : 'downgrade';
}

/** What the plan catalogue looks like to a browser: prices and what's included, never costs. */
export function publicCatalogue(pricing) {
  return {
    currency: pricing.currency || 'USD',
    qualityUnits: pricing.qualityUnits, longTakeSeconds: pricing.longTakeSeconds ?? 8,
    trial: pricing.trial || null,
    plans: pricing.plans.map(({ id, name, rank, tagline, price, videosPerMonth, features, popular, soon }) => ({ id, name, rank, tagline, price, videosPerMonth, features, popular: !!popular, soon: soon || [] })),
    lifetime: pricing.lifetime ? (({ id, name, usd, tagline, features, limit }) => ({ id, name, usd, tagline, features, limited: !!limit }))(pricing.lifetime) : null,
    topups: (pricing.topups || []).map(({ id, name, videos, usd }) => ({ id, name, videos, usd })),
  };
}
