import { defineConfig } from 'vite';
import { identityGate } from '../scripts/vite-identity-gate.js';

/**
 * TBI Admin (admin app design §1). In production the app is static files behind its own gate
 * (admin-lab), and the same two same-origin prefixes as on the Lab reach the backends:
 * `/admin-api/*` the admin service, `/runtime/admin/*` the Session Host's owner routes (that prefix
 * only). For development and tests Vite proxies them to loopback: TBI_ADMIN_PROXY (default
 * http://127.0.0.1:7410) and TBI_RUNTIME_PROXY (default http://127.0.0.1:7400).
 *
 * Identity (scripts/vite-identity-gate.ts, shared with the Lab): the proxy always drops every
 * identity header the browser sent; only in test mode (TBI_TEST_GATE=1, set by
 * playwright.admin.config.ts) does it play the gate and assert the subject of the `tbi_test_user`
 * cookie (default `e2e-user`), and the `tbi_test_email` address when set.
 */
const gate = identityGate();

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
