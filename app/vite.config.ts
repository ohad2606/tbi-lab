import type { IncomingMessage } from 'node:http';
import { defineConfig, type ProxyOptions } from 'vite';

/**
 * `/runtime` is the R2 Session Host API, same-origin (Sprint 6). In production the deployment's
 * authenticating reverse proxy routes it; for local development and tests Vite proxies it to a
 * Session Host on loopback (TBI_RUNTIME_PROXY, default http://127.0.0.1:7400). The event stream
 * is proxied unbuffered.
 *
 * `/build` is the build service (Sprint 7), likewise same-origin: TBI_BUILD_PROXY, default
 * http://127.0.0.1:7420.
 */
/**
 * TEST ONLY (TBI_TEST_GATE=1, set by the Playwright configuration): the proxy plays the
 * deployment's authenticating gate (Sprint 8, D-S8-1). It removes every identity header the
 * browser sent and asserts the subject named by the `tbi_test_user` cookie (default `e2e-user`),
 * so tests can act as different users. Never enabled otherwise: without it the backends get no
 * identity and answer 401.
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
  });
}

const runtimeProxy = {
  '/runtime': {
    target: process.env.TBI_RUNTIME_PROXY ?? 'http://127.0.0.1:7400',
    changeOrigin: false,
    rewrite: (path: string) => path.replace(/^\/runtime/, ''),
    configure: gate,
  },
  '/build': {
    target: process.env.TBI_BUILD_PROXY ?? 'http://127.0.0.1:7420',
    changeOrigin: false,
    rewrite: (path: string) => path.replace(/^\/build/, ''),
    configure: gate,
  },
};

export default defineConfig({
  // Preact via the automatic JSX runtime; no framework preset or Babel needed.
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: { target: 'es2022', sourcemap: true },
  preview: { port: 4173, strictPort: true, proxy: runtimeProxy },
  server: { port: 5173, proxy: runtimeProxy },
});
