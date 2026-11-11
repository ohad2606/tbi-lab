import type { IncomingMessage } from 'node:http';
import { defineConfig, type ProxyOptions } from 'vite';

/**
 * TBI Admin (admin app design §1). In production the app is static files behind its own gate
 * (admin-lab), and the same two same-origin prefixes as on the Lab reach the backends:
 * `/admin-api/*` the admin service, `/runtime/admin/*` the Session Host's owner routes (that prefix
 * only). For development and tests Vite proxies them to loopback: TBI_ADMIN_PROXY (default
 * http://127.0.0.1:7410) and TBI_RUNTIME_PROXY (default http://127.0.0.1:7400).
 *
 * TEST ONLY (TBI_TEST_GATE=1, set by playwright.admin.config.ts): the proxy plays the gate, as in
 * app/vite.config.ts: it drops every identity header the browser sent and asserts the subject of
 * the `tbi_test_user` cookie (default `e2e-user`), and the `tbi_test_email` address when set.
 */
const testGate = process.env.TBI_TEST_GATE === '1';
type ProxyServer = Parameters<NonNullable<ProxyOptions['configure']>>[0];
function gate(proxy: ProxyServer): void {
  if (!testGate) return;
  proxy.on('proxyReq', (proxyReq, req: IncomingMessage) => {
    for (const name of proxyReq.getHeaderNames())
      if (name === 'x-forwarded-user' || name === 'x-forwarded-email' || name.startsWith('x-tbi-'))
        proxyReq.removeHeader(name);
    const cookie = /(?:^|;\s*)tbi_test_user=([A-Za-z0-9._-]{1,64})/.exec(req.headers.cookie ?? '');
    proxyReq.setHeader('x-forwarded-user', cookie?.[1] ?? 'e2e-user');
    const email = /(?:^|;\s*)tbi_test_email=([A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,64})/.exec(
      req.headers.cookie ?? '',
    );
    if (email) proxyReq.setHeader('x-forwarded-email', email[1]!);
  });
}

const proxy = {
  '/admin-api': {
    target: process.env.TBI_ADMIN_PROXY ?? 'http://127.0.0.1:7410',
    changeOrigin: false,
    rewrite: (path: string) => path.replace(/^\/admin-api/, ''),
    configure: gate,
  },
  // Only the owner routes of the Session Host, as on the admin-lab origin.
  '/runtime/admin': {
    target: process.env.TBI_RUNTIME_PROXY ?? 'http://127.0.0.1:7400',
    changeOrigin: false,
    rewrite: (path: string) => path.replace(/^\/runtime/, ''),
    configure: gate,
  },
};

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  // Reproducible (packaging gate G2): no build stamp, no source maps, content-hashed assets.
  build: { target: 'es2022', sourcemap: false },
  preview: { port: 4176, strictPort: true, proxy },
  server: { port: 5180, proxy },
});
