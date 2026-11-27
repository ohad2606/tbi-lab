/**
 * BETA-G1: the intake's public path constants, the proxy template's route regex and the proxy doc
 * name the same routes (static check; the behaviour is tested with real Caddy in
 * signup-proxy.test.mjs).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as http from '../../runtime/admin/signup/http.ts';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const paths = Object.entries(http)
  .filter(([name]) => name.endsWith('_PATH'))
  .map(([, value]) => value)
  .sort();
const named = (text) => [...new Set(text.match(/(?<=`)\/signup\/[a-z-]+(?=`)/g))].sort();

describe('public sign-up routes agree', () => {
  it('the intake has exactly the four public paths', () => {
    expect(paths).toEqual([
      '/signup/form-token',
      '/signup/resend',
      '/signup/verify',
      '/signup/web',
    ]);
  });

  it('the Caddy template routes exactly those paths', () => {
    const t = read('../deploy/Caddyfile.signup.template');
    const m = /\.matches\("\^\/signup\/\(([a-z|-]+)\)\(\[\?\]\.\*\)\?\$"\)/.exec(t);
    expect(
      m?.[1]
        .split('|')
        .map((p) => `/signup/${p}`)
        .sort(),
    ).toEqual(paths);
  });

  it('the proxy doc lists exactly those paths as routed, and never speaks of two', () => {
    const doc = read('../../docs/ops/G1-SIGNUP-PROXY.md');
    const row = doc.split('\n').find((l) => l.startsWith('| Routing |')) ?? '';
    expect(named(row.split('go to the intake')[0])).toEqual(paths);
    const killSwitch = doc.split('## Kill switch')[1].split('\n## ')[0];
    expect(named(killSwitch)).toEqual(paths);
    expect(doc).not.toMatch(/both (intake )?paths|two (proxied |intake )?paths/i);
  });
});
