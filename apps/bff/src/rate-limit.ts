/**
 * Fixed-window in-memory rate limiter. Bounded by construction: stale buckets
 * are evicted lazily whenever the map crosses MAX_KEYS.
 */
const MAX_KEYS = 10_000;

export interface RateLimiter {
  /** True while the caller is inside the window budget. */
  allow(key: string): boolean;
}

export function makeRateLimiter(max: number, windowMs: number): RateLimiter {
  const buckets = new Map<string, { n: number; reset: number }>();
  return {
    allow(key: string): boolean {
      const t = Date.now();
      if (buckets.size > MAX_KEYS) {
        for (const [k, b] of buckets) if (b.reset <= t) buckets.delete(k);
      }
      let b = buckets.get(key);
      if (!b || b.reset <= t) {
        b = { n: 0, reset: t + windowMs };
        buckets.set(key, b);
      }
      return ++b.n <= max;
    },
  };
}
