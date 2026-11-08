/** Deployment configuration (not product logic): sign-out destination, preview identity. */
import { describe, expect, it } from 'vitest';
import {
  parseAdminUi,
  parsePreviewName,
  parseSignOutUrl,
  parseStorageNamespace,
  storageName,
} from '../src/deployment.js';

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

describe('preview deployment (Sprint 9 preview)', () => {
  it('a preview name is a short plain label; anything else means a regular deployment', () => {
    expect(parsePreviewName('Sprint 9')).toBe('Sprint 9');
    expect(parsePreviewName(' Sprint 9 ')).toBe('Sprint 9');
    for (const v of [undefined, '', '  ', 9, '<b>x</b>', 'a'.repeat(25), '-x'])
      expect(parsePreviewName(v)).toBeNull();
  });

  it('a storage namespace keeps databases and preference keys apart; none changes nothing', () => {
    expect(parseStorageNamespace('s9-preview')).toBe('s9-preview');
    for (const v of [undefined, '', 'S9', 'a/b', '../x', 'a'.repeat(33)])
      expect(parseStorageNamespace(v)).toBeNull();
    expect(storageName('tbi-lab', null)).toBe('tbi-lab');
    expect(storageName('tbi-lab.lastProject', null)).toBe('tbi-lab.lastProject');
    expect(storageName('tbi-lab', 's9-preview')).toBe('s9-preview/tbi-lab');
  });
});

describe('feedback form link (Sprint 13 H7: disabled unless configured)', () => {
  it('only an https address enables it; anything else keeps it off', async () => {
    const { parseFeedbackUrl, parseFeedbackParam, feedbackLink, FEEDBACK_URL } =
      await import('../src/deployment.js');
    // No build configures it today: external collection needs the owner's approval first.
    expect(FEEDBACK_URL).toBeNull();
    expect(parseFeedbackUrl(undefined)).toBeNull();
    expect(parseFeedbackUrl('')).toBeNull();
    expect(parseFeedbackUrl('http://forms.example/x')).toBeNull();
    expect(parseFeedbackUrl('javascript:alert(1)')).toBeNull();
    expect(parseFeedbackUrl('https://forms.example/f/abc')).toBe('https://forms.example/f/abc');
    expect(parseFeedbackParam('entry.123456')).toBe('entry.123456');
    expect(parseFeedbackParam('a b')).toBeNull();
    expect(
      feedbackLink('https://forms.example/f/abc?usp=pp_url', 'entry.1', 'v0.10-dev ba0f4a6'),
    ).toBe('https://forms.example/f/abc?usp=pp_url&entry.1=v0.10-dev+ba0f4a6');
    expect(feedbackLink('https://forms.example/f/abc', null, 'x')).toBe(
      'https://forms.example/f/abc',
    );
  });
});

describe('Sprint 23C: the administration switch (VITE_ADMIN_UI)', () => {
  it('off, reports or full; anything else, or unset, is off', () => {
    expect(parseAdminUi('full')).toBe('full');
    expect(parseAdminUi('reports')).toBe('reports');
    expect(parseAdminUi(' reports ')).toBe('reports');
    expect(parseAdminUi('off')).toBe('off');
    // The Sprint 23B value "1" is not silently promoted to the full administration.
    for (const v of [undefined, null, '', '1', '0', 'on', 'Full', 'REPORTS', 42, true])
      expect(parseAdminUi(v), String(v)).toBe('off');
  });
});
