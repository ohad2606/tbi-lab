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
    expect(en).toContain('nothing was sent');
    expect(en).toContain('only after automatic approval is resumed');
    expect(he).toContain('לא נשלח דבר');
    expect(he).toContain('רק אחרי שהאישור האוטומטי יחודש');
    // The queued row has no resend button, so the note names none.
    expect(en).not.toContain('Resend');
    expect(he).not.toContain('שליחת המייל שוב');
    for (const t of [en, he]) {
      expect(t).not.toMatch(/will be sent automatically|quiet hours|יישלח אוטומטית|שעות השקט/);
      expect(t).toContain('{name}');
    }
  });
});

describe('quiet hours only when the record proves it', () => {
  const view = (o: Partial<SignupRecord>, action: 'approve' | 'resend') =>
    signupOutcomeView(interpretSignup(200, { record: rec(o), note: 'email_queued' }), action, NOW)
      .key;
  it('never auto-approved, no error, send time ahead: quiet hours', () => {
    expect(view({}, 'resend')).toBe('console.signups.done.resend.email_queued');
    expect(view({}, 'approve')).toBe('console.signups.done.approve.email_queued');
  });
  it('auto-approved and taken over by an owner resend: the pause still holds it, no time', () => {
    const taken = { autoApprovedAt: '2026-11-01T21:00:00.000Z', approvedBy: 'owner' as const };
    for (const action of ['approve', 'resend'] as const)
      expect(view(taken, action)).toBe(`console.signups.done.${action}.email_queued_wait`);
  });
  it('auto-approved (possibly night-exempt) or a pause hold: neutral, no promised send time', () => {
    const auto = { autoApprovedAt: '2026-11-01T21:00:00.000Z', origin: 'web' as const };
    for (const action of ['approve', 'resend'] as const) {
      expect(view(auto, action)).toBe(`console.signups.done.${action}.email_queued_wait`);
      expect(view({ emailSendAfter: '2026-11-01T21:00:00.000Z' }, action)).toBe(
        `console.signups.done.${action}.email_queued_wait`,
      );
    }
  });
  it('neutral and row texts make no send promise; HE and EN alike', () => {
    for (const key of [
      'console.signups.done.approve.email_queued_wait',
      'console.signups.done.resend.email_queued_wait',
      'console.signups.status.emailQueued',
    ])
      for (const t of text(key))
        expect(t).not.toMatch(/will be sent|quiet hours|יישלח|שעות השקט|MISSING/);
  });
  it('delete failures name the refresh button verbatim', () => {
    for (const key of [
      'console.signups.delete.failed.server',
      'console.signups.delete.failed.network',
    ]) {
      const [en, he] = text(key);
      expect(en).toContain('"Refresh requests"');
      expect(he).toContain('„רענון הבקשות”');
    }
    const [en, he] = text('console.signups.refresh');
    expect([en, he]).toEqual(['Refresh requests', 'רענון הבקשות']);
  });
});
