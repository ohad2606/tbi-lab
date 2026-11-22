/**
 * ARC-PKG: build-package.sh bundles the public sign-up intake next to the admin service and copies it into
 * services/ only for profiles that carry the admin bundle. Static check of the script, the profiles and the
 * npm script; the bundle itself is built for real into a temp dir.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../', import.meta.url).pathname;
const SCRIPT = readFileSync(join(ROOT, 'deploy/release/build-package.sh'), 'utf8');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const profile = (n) =>
  JSON.parse(readFileSync(join(ROOT, `deploy/release/${n}.release.json`), 'utf8'));

describe('signup-intake packaging', () => {
  it('builds the bundle inside the admin_bundle branch only', () => {
    const m = SCRIPT.match(/if \[ "\$admin_bundle" = 1 \]; then\n([\s\S]*?)\nfi\n/);
    expect(m).not.toBeNull();
    expect(m[1]).toContain('runtime/admin/signup/intake-main.ts');
    expect(m[1]).toContain('--outfile=runtime/admin/dist/signup-intake.mjs');
    expect(SCRIPT.match(/intake-main\.ts/g)).toHaveLength(1);
  });

  it('copies signup-intake.mjs to services/ only when admin_bundle is set', () => {
    const line = SCRIPT.split('\n').find((l) => l.includes('signup-intake.mjs "$out/services/"'));
    expect(line).toBeDefined();
    expect(line.startsWith('[ "$admin_bundle" = 0 ] || cp ')).toBe(true);
    expect(line).toContain('runtime/admin/dist/admin-service.mjs');
    // the unconditional cp of the always-present services must not carry it
    const unconditional = SCRIPT.split('\n').filter(
      (l) => l.includes('"$out/services/"') && !l.startsWith('[ "$admin_bundle"'),
    );
    expect(unconditional.join('\n')).not.toContain('signup-intake');
  });

  it('admin_bundle is derived from the profile admin key (admin profiles yes, others no)', () => {
    expect(SCRIPT).toContain('.admin ? 0 : 1');
    expect(profile('rc6-admin').admin).toBeTruthy();
    expect(profile('rc4-s23-admin').admin).toBeTruthy();
    expect(profile('rc4').admin).toBeFalsy();
    expect(profile('rc6-feedback').admin).toBeFalsy();
  });

  it('has a signup:build npm script producing the same artifact', () => {
    expect(PKG.scripts['signup:build']).toContain('runtime/admin/signup/intake-main.ts');
    expect(PKG.scripts['signup:build']).toContain('--outfile=runtime/admin/dist/signup-intake.mjs');
  });

  it('the entry point bundles for real', () => {
    const d = mkdtempSync(join(tmpdir(), 'tbi-signup-'));
    try {
      const out = join(d, 'signup-intake.mjs');
      execFileSync(
        join(ROOT, 'node_modules/.bin/esbuild'),
        [
          'runtime/admin/signup/intake-main.ts',
          '--bundle',
          '--platform=node',
          '--format=esm',
          '--target=node22',
          `--outfile=${out}`,
          '--log-level=warning',
        ],
        { cwd: ROOT },
      );
      expect(existsSync(out) && statSync(out).size > 0).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
