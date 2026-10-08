// In-memory token buckets for per-user limits (messages, typing, reactions…)
// that don't fit a plain per-IP HTTP limiter. Single process — no Redis.
import { tooMany } from "./errors";

interface Bucket {
  tokens: number;
  ts: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number
  ) {
    const t = setInterval(() => this.sweep(), 60_000);
    t.unref?.();
  }

  /** Returns 0 when allowed, otherwise the milliseconds until a token frees up. */
  take(key: string, cost = 1): number {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, ts: now };
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.ts) / 1000) * this.refillPerSec);
    b.ts = now;
    if (b.tokens >= cost) {
      b.tokens -= cost;
      this.buckets.set(key, b);
      return 0;
    }
    this.buckets.set(key, b);
    return Math.ceil(((cost - b.tokens) / this.refillPerSec) * 1000);
  }

  /** Throws a 429 ApiError when the bucket is empty. */
  consume(key: string, cost = 1) {
    const wait = this.take(key, cost);
    if (wait > 0) throw tooMany(wait);
  }

  private sweep() {
    const now = Date.now();
    for (const [k, b] of this.buckets) {
      if (b.tokens + ((now - b.ts) / 1000) * this.refillPerSec >= this.capacity) this.buckets.delete(k);
    }
  }
}

export const limits = {
  messages: new RateLimiter(8, 1.2), // burst 8, then ~1.2/s per user
  reactions: new RateLimiter(20, 4),
  typing: new RateLimiter(4, 0.5),
  uploads: new RateLimiter(20, 0.5),
  friendRequests: new RateLimiter(10, 0.05),
  voiceJoin: new RateLimiter(10, 0.5),
  presence: new RateLimiter(10, 0.5),
  search: new RateLimiter(10, 1),
  diag: new RateLimiter(6, 0.05),
};
