/** BETA-G1 flip: the committed constant SIGNUP_VERIFY_ENABLED = true is the build default (simulated here). */
import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite } from '../build.mjs';

vi.mock('../content.mjs', async (original) => ({
  ...(await original()),
  SIGNUP_VERIFY_ENABLED: true,
}));

const dir = () => mkdtempSync(join(tmpdir(), 'tbi-vf-flip-'));

describe('SIGNUP_VERIFY_ENABLED = true', () => {
  it.each([{ signupEnabled: true }, { signupPreview: true }])(
    '%j: the confirm view is built by default',
    (o) => {
      const out = buildSite(dir(), o);
      for (const l of ['he', 'en'])
        expect(readFileSync(join(out, l, 'signup', 'index.html'), 'utf8')).toContain(
          '<div id="vf" hidden>',
        );
      expect(readFileSync(join(out, 'assets', 'signup.mjs'), 'utf8')).toContain('initVerify');
    },
  );
  it('refuses a default build while the sign-up page is disabled', () => {
    const out = join(dir(), 'dist');
    expect(() => buildSite(out)).toThrow(/SIGNUP_PAGE_ENABLED/);
    expect(existsSync(out)).toBe(false);
  });
});
