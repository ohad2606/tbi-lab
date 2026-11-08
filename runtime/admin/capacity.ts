/**
 * Sprint 23C: the live-session capacity the owner sees, for the admin service. Read on demand from
 * the Session Host's health-only socket (`TBI_RUNTIME_HEALTH`), which answers counts only (never an
 * identifier): `{"capacity":{"live":N,"max":M}}`. The admin service has no other route to the
 * Session Host. Unreachable, slow (2 s) or malformed: null (the API answers 503).
 */
import { request } from 'node:http';
import type { ListenSpec } from '../identity/listen.js';

export interface Capacity {
  live: number;
  max: number;
}

const count = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 100_000;

export function parseCapacity(text: string): Capacity | null {
  try {
    const c = (JSON.parse(text) as { capacity?: { live?: unknown; max?: unknown } }).capacity;
    return c && count(c.live) && count(c.max) ? { live: c.live, max: c.max } : null;
  } catch {
    return null;
  }
}

export function healthCapacity(
  where: ListenSpec,
  timeoutMs = 2000,
): () => Promise<Capacity | null> {
  return () =>
    new Promise((resolve) => {
      const req = request(
        {
          ...('unix' in where
            ? { socketPath: where.unix }
            : { host: where.host, port: where.port }),
          path: '/health',
          timeout: timeoutMs,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => {
            body += c;
            if (body.length > 64 * 1024) req.destroy();
          });
          res.on('end', () => resolve(res.statusCode === 200 ? parseCapacity(body) : null));
          res.on('error', () => resolve(null));
        },
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => req.destroy());
      req.end();
    });
}
