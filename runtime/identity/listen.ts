/**
 * Where a backend listens (Sprint 8, D-S8-1): a unix socket in deployment, so that only the
 * internal reverse proxy (the one process allowed into the socket's directory/group) can reach
 * it; TCP loopback remains for local development and tests.
 *
 *   `unix:/run/tbi-build/api.sock`   unix socket, mode 0660 (group from `socketGroupGid`)
 *   `127.0.0.1:7420`                 TCP (development and tests only)
 */
import { chmodSync, chownSync, lstatSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';

export type ListenSpec = { unix: string } | { host: string; port: number };

export function parseListen(spec: string): ListenSpec {
  if (spec.startsWith('unix:')) {
    const path = spec.slice(5);
    if (!path.startsWith('/')) throw new Error('unix socket path must be absolute');
    return { unix: path };
  }
  const m = /^(\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]|localhost):(\d{1,5})$/.exec(spec);
  if (!m) throw new Error(`bad listen address: ${spec}`);
  return { host: m[1]!.replace(/^\[|\]$/g, ''), port: Number(m[2]) };
}

export function listen(server: Server, spec: ListenSpec, socketGroupGid?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    if ('unix' in spec) {
      // A socket left by a previous run is replaced; anything else at that path is an error.
      try {
        if (lstatSync(spec.unix).isSocket()) rmSync(spec.unix);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return reject(e as Error);
      }
      server.listen(spec.unix, () => {
        try {
          if (socketGroupGid !== undefined) chownSync(spec.unix, -1, socketGroupGid);
          chmodSync(spec.unix, 0o660);
          resolve();
        } catch (e) {
          reject(e as Error);
        }
      });
    } else server.listen(spec.port, spec.host, () => resolve());
  });
}

export const describeListen = (spec: ListenSpec): string =>
  'unix' in spec ? `unix:${spec.unix}` : `${spec.host}:${spec.port}`;
