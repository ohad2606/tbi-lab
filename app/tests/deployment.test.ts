/** Preview sign-out destination (deployment configuration, not product logic). */
import { describe, expect, it } from 'vitest';
import { parseSignOutUrl } from '../src/deployment.js';

describe('sign-out destination', () => {
  it('absent or empty configuration means no sign-out control', () => {
    for (const v of [undefined, null, '', '   ', 42, true]) expect(parseSignOutUrl(v)).toBeNull();
  });

  it('accepts a same-origin path or an http(s) URL, trimmed', () => {
    expect(parseSignOutUrl('/oauth2/sign_out')).toBe('/oauth2/sign_out');
    expect(parseSignOutUrl(' /oauth2/sign_out \n')).toBe('/oauth2/sign_out');
    expect(parseSignOutUrl('https://auth.example.test/logout?rd=%2F')).toBe(
      'https://auth.example.test/logout?rd=%2F',
    );
  });

  it('refuses anything that is not a navigation target', () => {
    for (const v of ['javascript:alert(1)', 'data:text/html,x', '//evil.test/x', 'oauth2/sign_out'])
      expect(parseSignOutUrl(v)).toBeNull();
  });
});
