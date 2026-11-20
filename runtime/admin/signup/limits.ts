/** TBI-022: body size cap and in-memory sliding-window rate limits for the public sign-up endpoint. */
import type { IncomingMessage } from 'node:http';

/** A sign-up is a few short fields; anything larger is refused. */
export const MAX_SIGNUP_BODY_BYTES = 4096;

export class BodyTooLarge extends Error {}

/** Reads at most `limit` bytes; rejects (and stops reading) beyond it, by header and by stream. */
export function readCappedBody(
  req: IncomingMessage,
  limit = MAX_SIGNUP_BODY_BYTES,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      return reject(new BodyTooLarge());
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        reject(new BodyTooLarge());
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => reject(new Error('request error')));
  });
}

export interface RateRule {
  count: number;
  windowMs: number;
}

/** Sliding window per key; the key table is bounded (a full table refuses new keys). */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly rule: RateRule,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  take(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const t = this.now();
    let list = this.hits.get(key);
    if (list) list = list.filter((x) => t - x < this.rule.windowMs);
    else {
      if (this.hits.size >= this.maxKeys) this.sweep(t);
      if (this.hits.size >= this.maxKeys) return { ok: false, retryAfterMs: this.rule.windowMs };
      list = [];
    }
    if (list.length >= this.rule.count) {
      this.hits.set(key, list);
      return { ok: false, retryAfterMs: Math.max(1, list[0]! + this.rule.windowMs - t) };
    }
    list.push(t);
    this.hits.set(key, list);
    return { ok: true };
  }

  private sweep(t: number): void {
    for (const [k, l] of this.hits)
      if (l.every((x) => t - x >= this.rule.windowMs)) this.hits.delete(k);
  }
}
