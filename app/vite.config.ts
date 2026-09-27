import { defineConfig } from 'vite';

/**
 * `/runtime` is the R2 Session Host API, same-origin (Sprint 6). In production the deployment's
 * authenticating reverse proxy routes it; for local development and tests Vite proxies it to a
 * Session Host on loopback (TBI_RUNTIME_PROXY, default http://127.0.0.1:7400). The event stream
 * is proxied unbuffered.
 *
 * `/build` is the build service (Sprint 7), likewise same-origin: TBI_BUILD_PROXY, default
 * http://127.0.0.1:7420.
 */
const runtimeProxy = {
  '/runtime': {
    target: process.env.TBI_RUNTIME_PROXY ?? 'http://127.0.0.1:7400',
    changeOrigin: false,
    rewrite: (path: string) => path.replace(/^\/runtime/, ''),
  },
  '/build': {
    target: process.env.TBI_BUILD_PROXY ?? 'http://127.0.0.1:7420',
    changeOrigin: false,
    rewrite: (path: string) => path.replace(/^\/build/, ''),
  },
};

export default defineConfig({
  // Preact via the automatic JSX runtime; no framework preset or Babel needed.
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: { target: 'es2022', sourcemap: true },
  preview: { port: 4173, strictPort: true, proxy: runtimeProxy },
  server: { port: 5173, proxy: runtimeProxy },
});
