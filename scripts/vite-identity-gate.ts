import type { ClientRequest, IncomingMessage } from 'node:http';

/**
 * The identity handling of the Vite dev/preview proxies (app/vite.config.ts and
 * admin-app/vite.config.ts), in one place.
 *
 * ALWAYS: every identity header the browser sent is removed before a request reaches a backend
 * (the deployment's gate asserts identity; a browser never may). Without test mode the backends
 * therefore get no identity and answer 401.
 *
 * TEST ONLY (TBI_TEST_GATE=1, set by the Playwright configurations): the proxy then plays the
 * deployment's authenticating gate (Sprint 8, D-S8-1) and asserts the subject named by the
 * `tbi_test_user` cookie (default `e2e-user`), and (Sprint 23B: oauth2-proxy also passes the
 * session's address) the `tbi_test_email` address when that cookie is set.
 */
export const testGateEnabled = (env: NodeJS.ProcessEnv = process.env) => env.TBI_TEST_GATE === '1';

/** Headers only the gate may set: oauth2-proxy's identity headers and the services' own. */
export function isIdentityHeader(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n === 'x-forwarded-user' ||
    n === 'x-forwarded-email' ||
    n === 'x-forwarded-preferred-username' ||
    n === 'x-forwarded-groups' ||
    n === 'x-forwarded-access-token' ||
    n === 'gap-auth' ||
    n.startsWith('x-auth-request-') ||
    n.startsWith('x-tbi-')
  );
}

/**
 * The part of Vite's proxy server the hook uses (structural: the Lab and the admin app may resolve
 * different copies of Vite's types).
 */
interface ProxyServer {
  on(event: 'proxyReq', listener: (proxyReq: ClientRequest, req: IncomingMessage) => void): unknown;
}
const USER = /(?:^|;\s*)tbi_test_user=([A-Za-z0-9._-]{1,64})/;
const EMAIL = /(?:^|;\s*)tbi_test_email=([A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,64})/;

/** A proxy `configure` hook: strip identity always; assert the test identity in test mode only. */
export function identityGate(testMode = testGateEnabled()) {
  return (proxy: ProxyServer): void => {
    proxy.on('proxyReq', (proxyReq, req: IncomingMessage) => {
      for (const name of proxyReq.getHeaderNames())
        if (isIdentityHeader(name)) proxyReq.removeHeader(name);
      if (!testMode) return;
      const cookie = req.headers.cookie ?? '';
      proxyReq.setHeader('x-forwarded-user', USER.exec(cookie)?.[1] ?? 'e2e-user');
      const email = EMAIL.exec(cookie);
      if (email) proxyReq.setHeader('x-forwarded-email', email[1]!);
    });
  };
}
