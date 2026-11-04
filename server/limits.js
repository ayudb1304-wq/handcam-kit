// A tiny in-memory rate limiter (per key, sliding hour) and the visitor's IP behind cloudflared or Render.
export function rateLimit({ perHour }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now(), list = (hits.get(key) || []).filter((t) => now - t < 3600_000);
    if (list.length >= perHour) { hits.set(key, list); return false; }
    list.push(now); hits.set(key, list);
    if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some((t) => now - t < 3600_000)) hits.delete(k);
    return true;
  };
}
export const clientIp = (req) => String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
