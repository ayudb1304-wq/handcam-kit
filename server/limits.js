// A tiny in-memory rate limiter (per key, sliding window) and the visitor's IP behind cloudflared or Render.
/** → take(key, n = 1): true and counted when `n` more fit in the window, false (nothing counted) when they don't. */
export function rateLimit({ perHour, max = perHour, windowMs = 3600_000 }) {
  const hits = new Map();
  return (key, n = 1) => {
    const now = Date.now(), list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length + n > max) { hits.set(key, list); return false; }
    for (let i = 0; i < n; i++) list.push(now);
    hits.set(key, list);
    if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    return true;
  };
}
export const clientIp = (req) => String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();

/**
 * The network an address belongs to, for "one free trial per household": an IPv4 address as it is; an IPv6 address
 * cut to its /64, because every device on a home line gets its own (and changing) addresses inside one /64.
 */
export function networkOf(ip) {
  const s = String(ip || '').trim().toLowerCase().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
  if (!s.includes(':')) return s;
  const [head, tail = ''] = s.split('::');
  const a = head ? head.split(':') : [], b = tail ? tail.split(':') : [];
  const full = s.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return full.slice(0, 4).map((h) => h.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
