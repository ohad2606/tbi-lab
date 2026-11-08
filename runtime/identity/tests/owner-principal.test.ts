/**
 * Sprint 23C: scripts/owner-principal.mjs, the operator's tool for the owner reference file. It
 * derives exactly the principal the Session Host derives, and reads the subject from standard
 * input only.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { derivePrincipal, identityConfig } from '../principal.js';

const SCRIPT = new URL('../../../scripts/owner-principal.mjs', import.meta.url).pathname;
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function keyFile(key: Buffer): string {
  const d = mkdtempSync(join(tmpdir(), 'tbi-owner-key-'));
  dirs.push(d);
  writeFileSync(join(d, 'identity.key'), key, { mode: 0o600 });
  return join(d, 'identity.key');
}

const run = (args: string[], input: string) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8' });

describe('owner-principal.mjs', () => {
  it('prints the principal the Session Host derives for that Google sub (stdin only)', () => {
    const key = randomBytes(32);
    const file = keyFile(key);
    const sub = '104857600000000000001';
    for (const input of [sub, `${sub}\n`, `  ${sub}  \n\n`]) {
      const r = run([file], input);
      expect(r.status, JSON.stringify(input)).toBe(0);
      expect(r.stdout).toBe(`${derivePrincipal(identityConfig({ issuer: 'google', key }), sub)}\n`);
      expect(r.stdout).not.toContain(sub);
      expect(r.stderr).toBe('');
    }
    // Another issuer label, as TBI_IDENTITY_ISSUER would set it.
    const other = run([file, '--issuer', 'test'], 'e2e-owner');
    expect(other.stdout).toBe(
      `${derivePrincipal(identityConfig({ issuer: 'test', key }), 'e2e-owner')}\n`,
    );
  });

  it('refuses a subject on the command line, bad input and a short key, never echoing the sub', () => {
    const file = keyFile(randomBytes(32));
    // The sub as an extra argument: usage error, nothing derived.
    const argv = run([file, '104857600000000000001'], '');
    expect(argv.status).toBe(2);
    expect(argv.stdout).toBe('');
    for (const input of ['', '\n', '1\n2\n', 'owner@example.invalid', '12a34', '1 2'])
      expect(run([file], input).status, JSON.stringify(input)).toBe(1);
    const bad = run([file], 'not-a-sub-999');
    expect(bad.stderr).not.toContain('999');
    expect(run([keyFile(randomBytes(16))], '1234').stderr).toMatch(/at least 32 bytes/);
    expect(run([], '1234').status).toBe(2);
  });
});
