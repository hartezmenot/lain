// A fixed-window rate limiter for write routes (not yet wired in).

export function limiter({ windowMs = 60000, max = 30 } = {}) {
  const hits = new Map();
  return function allow(key, now = Date.now()) {
    const w = Math.floor(now / windowMs);
    const k = `${key}:${w}`;
    const n = (hits.get(k) || 0) + 1;
    hits.set(k, n);
    return n <= max;
  };
}
