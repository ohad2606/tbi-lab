#!/usr/bin/env node
/**
 * Release check of the built TBI Admin app (admin app design §3, packaging gates G2/G3), run by
 * build-package.sh for a profile with the dedicated admin service. The admin app is static files
 * served by its own gate (admin-lab) under a strict CSP (`default-src 'self'`):
 *
 *   check-admin-app.mjs <dist>
 *
 * - index.html, manifest.webmanifest and its two icons are present; the manifest names them.
 * - Nothing is loaded from another origin: index.html references only same-origin paths.
 * - No service worker (the app must never show stale data), and no registration of one.
 * - No source maps and no VITE_* reference left (the app reads no build setting).
 * - Every file is a regular file of a known static type (nothing executable on the server).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const STATIC = /\.(html|js|css|png|webmanifest|svg|ico|woff2?)$/;

function files(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out;
}

export function checkAdminApp(dist) {
  const errors = [];
  let all;
  try {
    all = files(dist);
  } catch (e) {
    return { errors: [`cannot read ${dist}: ${e.message}`], files: 0 };
  }
  for (const need of ['index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'])
    if (!all.includes(need)) errors.push(`missing ${need}`);
  for (const f of all) {
    if (!STATIC.test(f)) errors.push(`${f}: not a static asset type`);
    if (f.endsWith('.map')) errors.push(`${f}: source map (the admin app ships none)`);
    if (/(^|\/)(sw|service-worker)[^/]*\.js$/.test(f)) errors.push(`${f}: a service worker`);
  }
  if (all.includes('manifest.webmanifest')) {
    try {
      const m = JSON.parse(readFileSync(join(dist, 'manifest.webmanifest'), 'utf8'));
      const icons = (m.icons ?? []).map((i) => i.src).sort();
      if (icons.join() !== '/icon-192.png,/icon-512.png')
        errors.push(`manifest icons are ${icons.join(', ') || 'none'}`);
      if (m.start_url !== '/' || m.scope !== '/') errors.push('manifest start_url/scope must be /');
    } catch {
      errors.push('manifest.webmanifest is not JSON');
    }
  }
  if (all.includes('index.html')) {
    const html = readFileSync(join(dist, 'index.html'), 'utf8');
    for (const m of html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/g))
      if (!/^\/(?!\/)/.test(m[1])) errors.push(`index.html references ${m[1]} (same origin only)`);
  }
  for (const f of all.filter((f) => f.endsWith('.js') || f.endsWith('.html'))) {
    const text = readFileSync(join(dist, f), 'utf8');
    if (/serviceWorker\s*\.\s*register/.test(text)) errors.push(`${f}: registers a service worker`);
    const left = new Set(text.match(/\bVITE_[A-Z0-9_]+\b/g) ?? []);
    for (const name of left) errors.push(`${f}: ${name} was not compiled to a value`);
  }
  return { errors, files: all.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dist] = process.argv.slice(2);
  const { errors, files: n } = checkAdminApp(dist);
  for (const e of errors) console.error(`check-admin-app: ${e}`);
  if (errors.length) process.exitCode = 1;
  else console.log(`check-admin-app: ${n} files confirmed`);
}
