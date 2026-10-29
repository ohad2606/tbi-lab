import type { IncomingMessage } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin, type ProxyOptions } from 'vite';
import { currentBuildInfo, versionJson } from './buildInfo.config.js';

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
    // Sprint 23B: oauth2-proxy also passes the session's address (tests: `tbi_test_email`).
    const email = /(?:^|;\s*)tbi_test_email=([A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,64})/.exec(
      req.headers.cookie ?? '',
    );
    if (email) proxyReq.setHeader('x-forwarded-email', email[1]!);
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

/** Build identity: one object, compiled in and emitted as /version.json (buildInfo.config.ts). */
const buildInfo = currentBuildInfo(new URL('../', import.meta.url));
const versionFile: Plugin = {
  name: 'tbi-version-json',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: versionJson(buildInfo) });
  },
};

/**
 * RC4 packaging gate G2 (reproducible builds): an imported asset (e.g. a brand PNG) is a module
 * whose source text is the bundler's internal placeholder `import.meta.ROLLDOWN_FILE_URL_<ref>`,
 * and the reference ids are assigned in a nondeterministic order: two clean builds swapped them in
 * the main bundle's source map (the executable code was identical). That placeholder is not
 * source anyone wrote, so its `sourcesContent` entry becomes null (allowed by the source map
 * format); `sources` and the mappings are unchanged.
 */
const PLACEHOLDER_SOURCE = /^export default import\.meta\.ROLLDOWN_FILE_URL_[A-Za-z0-9_-]+;?\s*$/;
const deterministicSourceMaps: Plugin = {
  name: 'tbi-deterministic-sourcemaps',
  apply: 'build',
  writeBundle(options, bundle) {
    for (const fileName of Object.keys(bundle)) {
      if (!fileName.endsWith('.map') || !options.dir) continue;
      const path = join(options.dir, fileName);
      const map = JSON.parse(readFileSync(path, 'utf8')) as { sourcesContent?: (string | null)[] };
      if (!map.sourcesContent?.some((c) => c !== null && PLACEHOLDER_SOURCE.test(c))) continue;
      map.sourcesContent = map.sourcesContent.map((c) =>
        c !== null && PLACEHOLDER_SOURCE.test(c) ? null : c,
      );
      writeFileSync(path, JSON.stringify(map));
    }
  },
};

export default defineConfig({
  define: { __TBI_BUILD__: JSON.stringify(buildInfo) },
  plugins: [versionFile, deterministicSourceMaps],
  // Preact via the automatic JSX runtime; no framework preset or Babel needed.
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: { target: 'es2022', sourcemap: true },
  preview: { port: 4173, strictPort: true, proxy: runtimeProxy },
  server: { port: 5173, proxy: runtimeProxy },
});
