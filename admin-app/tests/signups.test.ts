/** TBI-022 slice D: the sign-up screen's logic without the DOM; texts exist in both locales. */
import { describe, expect, it } from 'vitest';
import {
  SIGNUP_ERRORS,
  interpretSignup,
  type AutoApproveStatus,
  type SignupRecord,
} from '@tbi-lab/admin-client';
import { LOCALES, isMessageKey } from '../src/i18n.js';
import {
  autoApproveView,
  canResend,
  focusAfterRemoval,
  isAutoApproved,
  isOpenSignup,
  signupRowKind,
  signupCountKey,
  parseRoute,
  section,
  signupOutcomeView,
  tab,
} from '../src/views.js';

const rec = (status: string, accountAdded = false): SignupRecord => ({
  id: 'a1',
  name: 'Dana Example',
  email: 'dana@example.invalid',
  role: 'teacher',
  lang: 'he',
  status,
  accountAdded,
  emailAttempts: 0,
  lastError: null,
  emailSendAfter: null,
  autoApprovedAt: null,
  createdAt: '2026-11-01T10:00:00Z',
});

describe('automatic approval flag', () => {
  const body = { id: 'a1', status: 'approved', accountAdded: true };
  const parse = (extra: object) => {
    const o = interpretSignup(200, { record: { ...body, ...extra }, note: null });
    return o.kind === 'done' ? o.record : null;
  };
  it('the client keeps autoApprovedAt when it is a non-empty string, else null', () => {
    expect(parse({ autoApprovedAt: '2026-11-23T10:00:00.000Z' })?.autoApprovedAt).toBe(
      '2026-11-23T10:00:00.000Z',
    );
    for (const bad of [undefined, null, '', 5, true, {}])
      expect(parse({ autoApprovedAt: bad })?.autoApprovedAt, String(bad)).toBeNull();
  });
  it('isAutoApproved is true only for a record that carries the mark', () => {
    expect(
      isAutoApproved({ ...rec('approved', true), autoApprovedAt: '2026-11-23T10:00:00Z' }),
    ).toBe(true);
    expect(isAutoApproved(rec('approved', true))).toBe(false);
    expect(isAutoApproved(rec('pending'))).toBe(false);
  });
  it('the badge text exists in both locales', () => {
    for (const l of LOCALES)
      expect(l.messages['console.signups.autoApproved'], l.code).toBeTruthy();
  });
});

describe('sign-up requests view logic', () => {
  it('routes: #/signups is a section under the phone More tab', () => {
    expect(parseRoute('#/signups')).toEqual({ name: 'signups' });
    expect(section({ name: 'signups' })).toBe('signups');
    expect(tab({ name: 'signups' })).toBe('more');
  });
  it('Resend only when the email failed for an added account', () => {
    expect(canResend(rec('pending'))).toBe(false);
    expect(canResend(rec('email_failed', true))).toBe(true);
    expect(canResend(rec('approved', true))).toBe(true);
    expect(canResend(rec('approved', false))).toBe(false);
  });
  it('row kinds: decide, retry the account step, resend, queued (no action)', () => {
    expect(signupRowKind(rec('pending'))).toBe('decide');
    expect(signupRowKind(rec('approved', false))).toBe('retry');
    expect(signupRowKind(rec('approved', true))).toBe('resend');
    expect(signupRowKind(rec('email_failed', true))).toBe('resend');
    expect(signupRowKind(rec('email_queued', true))).toBe('queued');
    for (const st of ['pending', 'approved', 'email_queued', 'email_failed'])
      expect(isOpenSignup(rec(st, true)), st).toBe(true);
    for (const st of ['email_sent', 'rejected', ''])
      expect(isOpenSignup(rec(st, true)), st).toBe(false);
    for (const l of LOCALES)
      for (const k of [
        'console.signups.status.pending',
        'console.signups.status.accountPending',
        'console.signups.status.emailFailed',
        'console.signups.status.emailQueued',
        'console.signups.sendAfter',
      ])
        expect(l.messages[k as keyof typeof l.messages], `${l.code} ${k}`).toBeTruthy();
  });
  it('the unused status label key is gone', () => {
    expect(isMessageKey('console.signups.status.label')).toBe(false);
  });
  it('a done outcome whose request is still open keeps the row, updated', () => {
    const queued = interpretSignup(200, {
      record: rec('email_queued', true),
      note: 'email_queued',
    });
    expect(signupOutcomeView(queued, 'approve')).toMatchObject({
      key: 'console.signups.done.approve.email_queued',
      removed: false,
      ok: true,
      record: { status: 'email_queued' },
    });
    const unknown = interpretSignup(200, {
      record: rec('approved', true),
      note: 'email_not_resent',
    });
    const u = signupOutcomeView(unknown, 'approve');
    expect(u.removed).toBe(false);
    expect(u.record && signupRowKind(u.record)).toBe('resend');
    const sent = interpretSignup(200, { record: rec('email_sent', true) });
    expect(signupOutcomeView(sent, 'resend')).toMatchObject({ removed: true, record: null });
  });
  it('count message: singular for one, plural otherwise, in both locales', () => {
    expect(signupCountKey(1)).toBe('console.signups.count.one');
    expect(signupCountKey(0)).toBe('console.signups.count.other');
    expect(signupCountKey(2)).toBe('console.signups.count.other');
    for (const l of LOCALES) {
      expect(l.messages['console.signups.count.one']).not.toContain('{count}');
      expect(l.messages['console.signups.count.other']).toContain('{count}');
    }
  });
  it('focus after removal: next row, else previous, else none', () => {
    expect(focusAfterRemoval(['a', 'b', 'c'], 'b')).toBe('c');
    expect(focusAfterRemoval(['a', 'b', 'c'], 'c')).toBe('b');
    expect(focusAfterRemoval(['a'], 'a')).toBeNull();
    expect(focusAfterRemoval(['a'], 'zz')).toBeNull();
  });
  it('outcomes: which rows leave, which keep a resendable record', () => {
    const done = interpretSignup(200, { record: rec('email_sent', true), note: 'already_done' });
    expect(signupOutcomeView(done, 'approve')).toMatchObject({
      key: 'console.signups.done.approve.already_done',
      removed: true,
      ok: true,
    });
    expect(signupOutcomeView(done, 'resend').key).toBe('console.signups.done.resend');
    const failed = interpretSignup(502, {
      error: 'email_failed',
      record: rec('email_failed', true),
    });
    const v = signupOutcomeView(failed, 'approve');
    expect(v.removed).toBe(false);
    expect(v.record && canResend(v.record)).toBe(true);
    expect(signupOutcomeView(interpretSignup(404, { error: 'not_found' }), 'approve').removed).toBe(
      true,
    );
    expect(
      signupOutcomeView(interpretSignup(202, { error: 'account_pending' }), 'approve'),
    ).toMatchObject({
      key: 'console.signups.err.account_pending',
      removed: false,
    });
    expect(signupOutcomeView(interpretSignup(409, { error: 'bad_state' }), 'reject').removed).toBe(
      false,
    );
  });
  it('a queued email reads as scheduled, never as sent (approve and resend)', () => {
    const o = interpretSignup(200, { record: null, note: 'email_queued' });
    expect(signupOutcomeView(o, 'approve').key).toBe('console.signups.done.approve.email_queued');
    expect(signupOutcomeView(o, 'resend').key).toBe('console.signups.done.resend.email_queued');
  });
  it('every outcome key has a text in Hebrew and English (no raw keys)', () => {
    const keys = [
      ...SIGNUP_ERRORS.map((e) => `console.signups.err.${e}`),
      'console.signups.err.account_pending',
      'console.signups.done.approve',
      'console.signups.done.approve.already_done',
      'console.signups.done.approve.email_not_resent',
      'console.signups.done.approve.email_queued',
      'console.signups.done.resend.email_queued',
      'console.signups.done.reject',
      'console.signups.done.resend',
      'console.nav.signups',
    ];
    for (const k of keys) {
      expect(isMessageKey(k), k).toBe(true);
      for (const l of LOCALES) expect(l.messages[k as keyof typeof l.messages], k).toBeTruthy();
    }
    const he = LOCALES.find((l) => l.code === 'he')!;
    expect(he.messages['console.signups.confirm.body' as keyof typeof he.messages]).toBeTruthy();
  });
});

const AUTO_KEYS = [
  'console.signups.auto.heading',
  'console.signups.auto.off',
  'console.signups.auto.unknown',
  'console.signups.auto.unavailable',
  'console.signups.auto.today',
  'console.signups.auto.capReached',
  'console.signups.auto.state.label',
  'console.signups.auto.state.running',
  'console.signups.auto.state.paused',
  'console.signups.auto.state.notRunning',
  'console.signups.auto.state.unknown',
  'console.signups.auto.reason',
  'console.signups.auto.backlog',
  'console.signups.auto.value.unknown',
];
describe('autoApproveView', () => {
  const ok: AutoApproveStatus = {
    enabled: true,
    running: true,
    paused: false,
    capReached: false,
    count: 3,
    dailyCap: 20,
    waitingBacklog: 4,
    stateDir: 'ok',
    stateDirReason: null,
  };
  const state = (x: Partial<AutoApproveStatus>) => {
    const v = autoApproveView({ ...ok, ...x });
    return v.mode === 'on' ? v.state : v.mode;
  };
  it('off and unreadable-enabled are their own modes', () => {
    expect(state({ enabled: false })).toBe('off');
    expect(state({ enabled: 'unknown' })).toBe('unknown');
  });
  it('running only when running, not paused and the directory is safe are all known', () => {
    expect(state({})).toBe('running');
    expect(state({ paused: true })).toBe('paused');
    expect(state({ paused: 'unknown' })).toBe('unknown');
    expect(state({ running: 'unknown' })).toBe('unknown');
    expect(state({ stateDir: 'unknown' })).toBe('unknown');
  });
  it('not running wins over paused (stopped sweep or unsafe directory)', () => {
    expect(state({ running: false, paused: true })).toBe('notRunning');
    expect(state({ stateDir: 'unsafe', paused: true, stateDirReason: 'ancestor_mode' })).toBe(
      'notRunning',
    );
    expect(state({ running: 'unknown', stateDir: 'unsafe' })).toBe('notRunning');
  });
  it('keeps unknown numbers unknown and carries the reason only when unsafe', () => {
    const v = autoApproveView({
      ...ok,
      count: 'unknown',
      stateDir: 'unsafe',
      stateDirReason: 'x_y',
    });
    expect(v).toMatchObject({ count: 'unknown', reason: 'x_y', dailyCap: 20 });
    expect(autoApproveView({ ...ok, stateDirReason: 'x_y' })).toMatchObject({ reason: null });
    expect(autoApproveView({ ...ok, capReached: 'unknown' })).toMatchObject({ capReached: false });
  });
  it('has HE and EN texts for every key', () => {
    for (const l of LOCALES)
      for (const k of AUTO_KEYS) expect(l.messages[k as never], k).toBeTruthy();
  });
});
