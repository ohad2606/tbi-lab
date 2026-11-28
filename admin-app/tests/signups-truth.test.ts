/** BETA-G1 truthful sign-up outcome texts (held by pause, quiet hours only when proven). */
import { describe, expect, it } from 'vitest';
import { interpretSignup, type SignupRecord } from '@tbi-lab/admin-client';
import { LOCALES } from '../src/i18n.js';
import { signupOutcomeView, signupStatusKey } from '../src/views.js';

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
    expect(en).toContain('not sent yet');
    expect(en).not.toContain('nothing was sent');
    // Pause file, failed pause check or unsafe state dir: no claim that a pause file exists.
    expect(en).toContain('could not be checked safely');
    expect(he).toContain('לא ניתן היה לבדוק בבטחה');
    // Resuming alone does not release a mail held by an unsafe state dir or a failed check.
    expect(en).toContain('only when automatic approval is not paused and the pause check works');
    expect(en).not.toContain('resumed');
    expect(he).toContain('עדיין לא נשלח');
    expect(he).not.toContain('לא נשלח דבר');
    expect(he).toContain('רק כשהאישור האוטומטי אינו מושהה ובדיקת מצב ההשהיה פועלת');
    expect(he).not.toContain('יחודש');
    // The queued row has no resend button, so the note names none.
    expect(en).not.toContain('Resend');
    expect(he).not.toContain('שליחת המייל שוב');
    for (const t of [en, he]) {
      expect(t).not.toMatch(/will be sent automatically|quiet hours|יישלח אוטומטית|שעות השקט/);
      expect(t).toContain('{name}');
    }
  });
});

describe('owner approve of a queued mail held by the pause', () => {
  it('approve.email_held_paused exists in HE and EN with the same truth as resend', () => {
    const o = interpretSignup(200, { record: rec({}), note: 'email_held_paused' });
    const v = signupOutcomeView(o, 'approve', NOW);
    expect(v.key).toBe('console.signups.done.approve.email_held_paused');
    for (const t of text(v.key)) {
      expect(t).not.toMatch(/MISSING|was sent|quiet hours|שעות השקט|לא נשלח דבר/);
      expect(t).toMatch(/not sent yet|עדיין לא נשלח/);
      expect(t).toContain('{name}');
    }
  });
});

describe('stale tab: a note this client does not know', () => {
  it('maps to a neutral "changed, refresh" text, never "was sent"', () => {
    const o = interpretSignup(200, { record: rec({}), note: 'some_future_note' });
    expect(o).toMatchObject({ kind: 'done', note: 'unknown' });
    for (const action of ['approve', 'reject', 'resend'] as const) {
      const v = signupOutcomeView(o, action, NOW);
      expect(v.key).toBe(`console.signups.done.${action}.unknown`);
      const [en, he] = text(v.key);
      expect(en).toContain('"Refresh requests"');
      expect(he).toContain('„רענון הבקשות”');
      for (const t of [en, he]) expect(t).not.toMatch(/MISSING|sent|נשלח/);
    }
  });
  it('the notice heading asks for the same refresh', () => {
    expect(text('console.signups.reloadNeeded')).toEqual(['Refresh needed', 'נדרש רענון']);
  });
  it('no note at all keeps the plain outcome', () => {
    expect(interpretSignup(200, { record: rec({}) })).toMatchObject({ note: null });
  });
});

describe('auto-approved mail over the mail limit: no "sent later" promise', () => {
  it('outcome and row text are neutral for autoApprovedAt + mail_cap; owner-only keeps the cap text', () => {
    const auto = { autoApprovedAt: '2026-11-01T21:00:00.000Z', lastError: 'mail_cap' };
    for (const action of ['approve', 'resend'] as const) {
      const o = interpretSignup(200, { record: rec(auto), note: 'email_queued' });
      expect(signupOutcomeView(o, action, NOW).key).toBe(
        `console.signups.done.${action}.email_queued_wait`,
      );
      const cap = interpretSignup(200, {
        record: rec({ lastError: 'mail_cap' }),
        note: 'email_queued',
      });
      expect(signupOutcomeView(cap, action, NOW).key).toBe(
        `console.signups.done.${action}.email_queued_cap`,
      );
    }
    const r = interpretSignup(200, { record: rec(auto) });
    expect(r.kind === 'done' && r.record && signupStatusKey(r.record)).toBe(
      'console.signups.status.emailQueued',
    );
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
