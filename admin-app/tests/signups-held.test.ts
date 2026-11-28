/** BETA-G1: a held mail is named from the server's `mailHeld`; an unknown outcome is never ok. */
import { describe, expect, it } from 'vitest';
import { interpretSignup, type SignupRecord } from '@tbi-lab/admin-client';
import { LOCALES } from '../src/i18n.js';
import {
  signupCountView,
  signupOutcomeView,
  signupStatusKey,
  storedStatusKey,
} from '../src/views.js';

const NOW = Date.parse('2026-11-01T22:00:00Z');
const raw = (o: Record<string, unknown> = {}) => ({
  id: 'a1',
  name: 'Dana Example',
  email: 'dana@example.invalid',
  role: 'teacher',
  lang: 'he',
  status: 'email_queued',
  accountAdded: true,
  emailAttempts: 0,
  lastError: null,
  emailSendAfter: '2026-11-02T06:00:00.000Z',
  autoApprovedAt: '2026-11-01T21:00:00.000Z',
  createdAt: '2026-11-01T10:00:00Z',
  ...o,
});
const parsed = (o: Record<string, unknown> = {}): SignupRecord => {
  const r = interpretSignup(200, { record: raw(o) });
  if (r.kind !== 'done' || !r.record) throw new Error('no record');
  return r.record;
};
const texts = (key: string) =>
  LOCALES.map((l) => (l.messages as Record<string, string>)[key] ?? `MISSING ${l.code}`);
const PROMISE = /MISSING|queued|scheduled|later|will be sent|בתור|מתוזמן|בהמשך|יישלח/;

describe('mailHeld comes only from the server answer', () => {
  it('parses the exact mark on a queued record only', () => {
    expect(parsed({ mailHeld: true }).mailHeld).toBe(true);
    expect(parsed({ mailHeld: 'yes' }).mailHeld).toBeUndefined();
    expect(parsed({ mailHeld: true, status: 'email_sent' }).mailHeld).toBeUndefined();
    expect(parsed().mailHeld).toBeUndefined();
  });
  it('row and stored status say held, never queued or scheduled (HE + EN)', () => {
    for (const lastError of [null, 'mail_cap']) {
      const r = parsed({ mailHeld: true, lastError });
      expect(signupStatusKey(r)).toBe('console.signups.status.emailHeld');
    }
    expect(storedStatusKey('email_queued', true)).toBe('console.signups.all.status.email_held');
    expect(storedStatusKey('email_queued')).toBe('console.signups.all.status.email_queued');
    for (const k of [
      'console.signups.status.emailHeld',
      'console.signups.all.status.email_held',
      'console.signups.count.held',
    ])
      for (const t of texts(k)) expect(t).not.toMatch(PROMISE);
  });
  it('the count names held mails apart from scheduled ones', () => {
    const held = parsed({ mailHeld: true });
    expect(signupCountView([held])).toEqual({
      key: 'console.signups.count.noAction',
      count: 0,
      held: { key: 'console.signups.count.held', count: 1 },
    });
    expect(signupCountView([held, parsed()])).toMatchObject({
      key: 'console.signups.count.queuedOnly',
      count: 1,
      held: { count: 1 },
    });
  });
  it('over the mail limit while held: no "sent later"; really queued keeps it', () => {
    const o = (extra: object) =>
      signupOutcomeView(
        interpretSignup(409, {
          error: 'mail_cap',
          record: raw({ lastError: 'mail_cap', ...extra }),
        }),
        'resend',
        NOW,
      );
    expect(o({ mailHeld: true })).toMatchObject({
      key: 'console.signups.err.mail_cap.held',
      ok: false,
      removed: false,
    });
    expect(o({}).key).toBe('console.signups.err.mail_cap');
    for (const t of texts('console.signups.err.mail_cap.held')) {
      expect(t).not.toMatch(PROMISE);
      expect(t).toContain('{name}');
    }
  });
  it('a queued outcome on a held record uses the held text', () => {
    for (const action of ['approve', 'resend'] as const) {
      const v = signupOutcomeView(
        interpretSignup(200, { record: raw({ mailHeld: true }), note: 'email_queued' }),
        action,
        NOW,
      );
      expect(v.key).toBe(`console.signups.done.${action}.email_held_paused`);
    }
  });
});

describe('unknown outcome', () => {
  it('is never ok, whether the row stays or leaves', () => {
    for (const record of [null, raw()])
      for (const action of ['approve', 'reject', 'resend'] as const)
        expect(
          signupOutcomeView(interpretSignup(200, { record, note: 'newer' }), action, NOW),
        ).toMatchObject({ ok: false, removed: record === null });
  });
});
