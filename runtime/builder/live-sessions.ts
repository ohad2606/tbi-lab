/**
 * How many runtime sessions are live on this host (Sprint 8 Phase 4 admission): the Session Host's
 * `/health` (counts by state, no identifiers), polled once a second over its socket. Unknown or
 * stale (the host is down) → null, and builds are not deferred.
 */
import { request } from 'node:http';
import type { ListenSpec } from '../identity/listen.js';

const LIVE = new Set(['creating', 'ready', 'running', 'stopping']);

export function watchLiveSessions(where: ListenSpec, everyMs = 1000): () => number | null {
  let value: number | null = null;
  let at = 0;
  const poll = () => {
    const req = request(
      {
        ...('unix' in where ? { socketPath: where.unix } : { host: where.host, port: where.port }),
        path: '/health',
        timeout: 2000,
      },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => {
          try {
            const sessions =
              (JSON.parse(body) as { sessions?: Record<string, number> }).sessions ?? {};
            value = Object.entries(sessions).reduce(
              (n, [state, k]) => n + (LIVE.has(state) ? k : 0),
              0,
            );
            at = Date.now();
          } catch {
            /* keep the last value; it goes stale */
          }
        });
      },
    );
    req.on('error', () => undefined);
    req.on('timeout', () => req.destroy());
    req.end();
  };
  poll();
  setInterval(poll, everyMs).unref();
  return () => (Date.now() - at < 5 * everyMs ? value : null);
}
