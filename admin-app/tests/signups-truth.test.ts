/** BETA-G1 truthful sign-up outcome texts (held by pause, quiet hours only when proven). */
import { describe, expect, it } from 'vitest';
import { interpretSignup, type SignupRecord } from '@tbi-lab/admin-client';
import { LOCALES } from '../src/i18n.js';
import { signupOutcomeView } from '../src/views.js';

const NOW = Date.parse('2026-11-01T22:00:00Z');
const FUTURE = '2026-11-02T06:00:00.000Z';
const rec = (o: Partial<SignupRecord>): Record<string, unknown> => ({
  id: 'a1',
  name: 'Dana Example',
  email: 'dana@example.invalid',
  role: 'teacher',
  lang: 'he',
  status: 'email_queued',
  accountAdded: true,
  emailAttempts: 0,
  lastError: null,
  emailSendAfter: FUTURE,
  autoApprovedAt: null,
  heardFrom: null,
  origin: null,
  createdAt: '2026-11-01T10:00:00Z',
  ...o,
});
const text = (key: string): [string, string] => {
  const of = (code: string) => {
    const l = LOCALES.find((x) => x.code === code);
    return (l?.messages as Record<string, string> | undefined)?.[key] ?? `MISSING ${code}`;
  };
  return [of('en'), of('he')];
};

describe('resend of a mail held by the pause', () => {
  it('the client keeps the email_held_paused note; the text names the pause, no auto-send promise', () => {
    const o = interpretSignup(200, { record: rec({}), note: 'email_held_paused' });
    const v = signupOutcomeView(o, 'resend', NOW);
    expect(v).toMatchObject({ key: 'console.signups.done.resend.email_held_paused', ok: true });
    const [en, he] = text(v.key);
    expect(en).toContain('paused');
    expect(en).toContain('"Resend email"');
    expect(he).toContain('"שליחת המייל שוב"');
    for (const t of [en, he]) {
      expect(t).not.toMatch(/will be sent automatically|quiet hours|יישלח אוטומטית|שעות השקט/);
      expect(t).toContain('{name}');
    }
  });
});
