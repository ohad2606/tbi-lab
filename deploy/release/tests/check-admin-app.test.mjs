/** Admin app design §3: the release check of the built TBI Admin app (check-admin-app.mjs). */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkAdminApp } from '../check-admin-app.mjs';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MANIFEST = {
  start_url: '/',
  scope: '/',
  icons: [
    { src: '/icon-192.png', sizes: '192x192' },
    { src: '/icon-512.png', sizes: '512x512' },
  ],
};

function dist(files = {}) {
  const d = mkdtempSync(join(tmpdir(), 'tbi-admin-app-dist-'));
  dirs.push(d);
  mkdirSync(join(d, 'assets'));
  const all = {
    'index.html':
      '<link rel="manifest" href="/manifest.webmanifest"><script type="module" src="/assets/index-a.js"></script>',
    'manifest.webmanifest': JSON.stringify(MANIFEST),
    'icon-192.png': 'png',
    'icon-512.png': 'png',
    'assets/index-a.js': 'console.log(1)',
    'assets/index-a.css': 'body{}',
    ...files,
  };
  for (const [p, text] of Object.entries(all)) if (text !== null) writeFileSync(join(d, p), text);
  return d;
}

describe('built admin app', () => {
  it('a clean build passes', () => {
    expect(checkAdminApp(dist()).errors).toEqual([]);
  });

  it('refuses missing files, maps, service workers, other origins and leftover settings', () => {
    expect(checkAdminApp(dist({ 'icon-512.png': null })).errors).toEqual(['missing icon-512.png']);
    expect(checkAdminApp(dist({ 'assets/index-a.js.map': '{}' })).errors).toEqual([
      'assets/index-a.js.map: not a static asset type',
      'assets/index-a.js.map: source map (the admin app ships none)',
    ]);
    expect(checkAdminApp(dist({ 'sw.js': '' })).errors).toEqual(['sw.js: a service worker']);
    expect(
      checkAdminApp(dist({ 'assets/index-a.js': 'navigator.serviceWorker.register("/x")' })).errors,
    ).toEqual(['assets/index-a.js: registers a service worker']);
    expect(
      checkAdminApp(
        dist({ 'index.html': '<script src="https://cdn.example.invalid/x.js"></script>' }),
      ).errors,
    ).toEqual(['index.html references https://cdn.example.invalid/x.js (same origin only)']);
    expect(checkAdminApp(dist({ 'index.html': '<img src="//x.invalid/a.png">' })).errors).toEqual([
      'index.html references //x.invalid/a.png (same origin only)',
    ]);
    expect(checkAdminApp(dist({ 'assets/index-a.js': 'x=VITE_SOMETHING' })).errors).toEqual([
      'assets/index-a.js: VITE_SOMETHING was not compiled to a value',
    ]);
    expect(
      checkAdminApp(dist({ 'manifest.webmanifest': JSON.stringify({ ...MANIFEST, icons: [] }) }))
        .errors,
    ).toEqual(['manifest icons are none']);
    expect(checkAdminApp(dist({ 'run.sh': '#!/bin/sh' })).errors).toEqual([
      'run.sh: not a static asset type',
    ]);
  });
});
