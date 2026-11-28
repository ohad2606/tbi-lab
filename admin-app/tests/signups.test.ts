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
  deleteAccountWarning,
  deleteOutcomeView,
  filterByEmail,
  storedStatusKey,
  focusAfterRemoval,
  isAutoApproved,
  signupSource,
  autoStateClass,
  isOpenSignup,
  signupRowKind,
  signupCountKey,
  signupCountView,
  signupStatusKey,
  parseRoute,
  section,
  signupBadgeOverride,
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
  heardFrom: null,
  origin: null,
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
        'console.signups.status.accountUnconfirmed',
        'console.signups.status.autoWait',
        'console.signups.err.unbound_state',
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
  it('exact HE/EN strings: count (waiting for you, plural) and neutral unknown state', () => {
    const m = (c: string) => LOCALES.find((l) => l.code === c)!.messages as Record<string, string>;
    expect(m('he')['console.signups.count.one']).toBe('בקשה אחת ממתינה לך');
    expect(m('he')['console.signups.count.other']).toBe('{count} בקשות ממתינות לך');
    expect(m('he')['console.signups.auto.backlog']).toBe('בקשות ישנות שממתינות לך: {count}');
    expect(m('he')['console.signups.auto.unknown']).toBe('מצב האישור האוטומטי אינו ידוע.');
    expect(m('he')['console.signups.auto.state.unknown']).toBe('לא ידוע');
    expect(m('en')['console.signups.count.one']).toBe('1 request waiting for you');
    expect(m('en')['console.signups.count.other']).toBe('{count} requests waiting for you');
    expect(m('en')['console.signups.auto.backlog']).toBe('Older requests waiting for you: {count}');
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
  it('count counts only rows that need the owner (decide/retry/resend), never queued emails', () => {
    const decide = rec('pending');
    const retry = rec('approved');
    const resend = rec('email_failed', true);
    const queued = rec('email_queued', true);
    expect([decide, retry, resend, queued].map(signupRowKind)).toEqual([
      'decide',
      'retry',
      'resend',
      'queued',
    ]);
    expect(signupCountView([decide, retry, resend, queued])).toEqual({
      key: 'console.signups.count.other',
      count: 3,
    });
    expect(signupCountView([queued, decide])).toEqual({
      key: 'console.signups.count.one',
      count: 1,
    });
    // Only queued rows: a neutral sentence (nothing to do), never "N waiting for you".
    expect(signupCountView([queued, queued])).toEqual({
      key: 'console.signups.count.queuedOnly',
      count: 2,
    });
    expect(signupCountView([])).toEqual({ key: 'console.signups.count.other', count: 0 });
    const m = (c: string) => LOCALES.find((l) => l.code === c)!.messages as Record<string, string>;
    expect(m('en')['console.signups.count.queuedOnly']).toBe(
      'No requests need your action. Scheduled emails: {count}',
    );
    expect(m('he')['console.signups.count.queuedOnly']).toBe(
      'אין בקשות שדורשות פעולה ממך. מיילים מתוזמנים: {count}',
    );
  });
  const autoRow = (id: string, state = 'confirmed_queued', extra: object = {}): SignupRecord => ({
    ...rec('pending'),
    id,
    lastError: null,
    autoApprovedAt: null,
    verification: { state } as SignupRecord['verification'],
    ...extra,
  });
  const auto = (count: number) => ({
    key: `console.signups.count.auto.${count === 1 ? 'one' : 'other'}`,
    count,
  });
  it('rows that wait for the automatic approval are not "waiting for you", but are named', () => {
    const a = autoRow('a');
    const b = autoRow('b', 'confirmed_waiting_limit');
    const decide = autoRow('c', 'confirmed_review');
    const queued = rec('email_queued', true);
    expect(signupCountView([a, decide])).toEqual({
      key: 'console.signups.count.one',
      count: 1,
      auto: auto(1),
    });
    expect(signupCountView([a, b, decide, rec('approved'), queued])).toEqual({
      key: 'console.signups.count.other',
      count: 2,
      auto: auto(2),
    });
    expect(signupCountView([a])).toEqual({
      key: 'console.signups.count.noAction',
      count: 0,
      auto: auto(1),
    });
    expect(signupCountView([a, b, queued])).toEqual({
      key: 'console.signups.count.queuedOnly',
      count: 1,
      auto: auto(2),
    });
  });
  it('the count excludes exactly the rows whose badge says automatic, answered ones included', () => {
    const rows = [
      autoRow('a'),
      autoRow('b', 'confirmed_waiting_limit'),
      autoRow('c', 'confirmed_queued', { lastError: 'account_error' }),
      autoRow('d', 'confirmed_queued', { autoApprovedAt: '2026-11-23T10:00:00.000Z' }),
      autoRow('e', 'unknown'),
    ];
    for (const answered of [new Set<string>(), new Set(['a']), new Set(['a', 'b'])]) {
      const waits = rows.filter(
        (r) => signupStatusKey(r, answered.has(r.id)) === 'console.signups.status.autoWait',
      ).length;
      const v = signupCountView(rows, (r) => answered.has(r.id));
      expect(v.count).toBe(rows.length - waits);
      expect(v.auto?.count ?? 0).toBe(waits);
    }
    expect(signupCountView(rows, () => true)).toEqual({
      key: 'console.signups.count.other',
      count: 5,
    });
  });
  it('exact HE/EN strings: automatic wait count, singular and plural', () => {
    const m = (c: string) => LOCALES.find((l) => l.code === c)!.messages as Record<string, string>;
    expect(m('en')['console.signups.count.noAction']).toBe('No requests need your action');
    expect(m('en')['console.signups.count.auto.one']).toBe(
      '1 request is waiting for automatic approval',
    );
    expect(m('en')['console.signups.count.auto.other']).toBe(
      '{count} requests are waiting for automatic approval',
    );
    expect(m('he')['console.signups.count.noAction']).toBe('אין בקשות שדורשות פעולה ממך');
    expect(m('he')['console.signups.count.auto.one']).toBe('בקשה אחת ממתינה לאישור אוטומטי');
    expect(m('he')['console.signups.count.auto.other']).toBe(
      '{count} בקשות ממתינות לאישור אוטומטי',
    );
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

describe('web intake source (BETA-G1 s10)', () => {
  const body = { id: 'a1', status: 'pending', accountAdded: false };
  const parse = (extra: object) => {
    const o = interpretSignup(200, { record: { ...body, ...extra }, note: null });
    return o.kind === 'done' ? o.record : null;
  };
  it('the client keeps heardFrom (trimmed text, <= 80) and origin web, else null', () => {
    const r = parse({ heardFrom: ' a friend ', origin: 'web' });
    expect(r?.heardFrom).toBe('a friend');
    expect(r?.origin).toBe('web');
    for (const bad of [undefined, null, '', '   ', 5, true, {}, 'x'.repeat(81)])
      expect(parse({ heardFrom: bad })?.heardFrom, String(bad)).toBeNull();
    for (const bad of [undefined, null, 'mail', 'WEB', 1, true])
      expect(parse({ origin: bad })?.origin, String(bad)).toBeNull();
  });
  it('signupSource: nothing for an old record, text only for heardFrom', () => {
    expect(signupSource(rec('pending'))).toEqual({ heardFrom: null, web: false });
    expect(
      signupSource({ ...rec('pending'), heardFrom: '<a href="x">x</a>', origin: 'web' }),
    ).toEqual({ heardFrom: '<a href="x">x</a>', web: true });
  });
  it('texts exist in both locales with the same keys', () => {
    for (const k of ['console.signups.heardFrom', 'console.signups.origin.web'])
      for (const l of LOCALES)
        expect(isMessageKey(k) && l.messages[k as never], l.code + k).toBeTruthy();
  });
  it('the unknown auto state has its own neutral class, not the off (danger) one', () => {
    expect(autoStateClass('unknown')).toBe('badge-unknown');
    expect(autoStateClass('notRunning')).toBe('badge-off');
    expect(autoStateClass('running')).toBe('badge-auto');
    expect(autoStateClass('paused')).toBe('badge-pending');
  });
  it('the Hebrew auto-approve count has no plural verb that disagrees with the number', () => {
    const he = LOCALES.find((l) => l.code === 'he')!;
    expect(he.messages['console.signups.auto.today' as never]).not.toMatch(/אושרו/);
  });
});

describe('stored requests: filter, warning, outcome (K12)', () => {
  const at = (email: string, id = 'a1') => ({ ...rec('pending'), id, email });
  const rows = [at('Dana@Example.invalid', 'a'), at('omer@example.invalid', 'b')];

  it('filters by address, trimmed and in any case', () => {
    expect(filterByEmail(rows, '  dANA@ex ').map((r) => r.id)).toEqual(['a']);
    expect(filterByEmail(rows, '   ')).toHaveLength(2);
    expect(filterByEmail(rows, 'nobody')).toEqual([]);
    // Only the address is searched, never the name.
    expect(filterByEmail(rows, 'Dana Example')).toEqual([]);
  });

  it('warns about an account that stays, or one that may still be added', () => {
    const none = new Set<string>();
    expect(deleteAccountWarning(rec('email_sent', true), none)).toBe('account');
    expect(deleteAccountWarning(rec('approved', false), none)).toBe('inFlight');
    expect(deleteAccountWarning(rec('pending'), new Set(['a1']))).toBe('inFlight');
    expect(deleteAccountWarning(rec('pending'), none)).toBeNull();
    expect(deleteAccountWarning(rec('rejected'), none)).toBeNull();
  });

  it('every status and outcome has a text in both languages', () => {
    const statuses = ['pending', 'approved', 'rejected', 'email_queued', 'email_sent'];
    for (const s of [...statuses, 'email_failed', '<b>'])
      expect(isMessageKey(storedStatusKey(s)), s).toBe(true);
    expect(storedStatusKey('<b>')).toBe('console.signups.all.status.other');
    const failed = [
      'csrf',
      'forbidden',
      'signed_out',
      'unavailable',
      'server',
      'network',
      'invalid_id',
    ] as const;
    const outcomes = [
      { kind: 'deleted' as const },
      { kind: 'already_deleted' as const },
      { kind: 'not_found' as const },
      { kind: 'rate_limited' as const, retryAfterS: null },
      { kind: 'rate_limited' as const, retryAfterS: 30 },
      ...failed.map((error) => ({ kind: 'failed' as const, error })),
    ];
    for (const o of outcomes) {
      const v = deleteOutcomeView(o);
      for (const l of LOCALES) {
        const text = l.messages[v.key as keyof typeof l.messages];
        expect(text, `${l.code} ${v.key}`).toBeTruthy();
        // An announcement names the request id and the outcome only.
        expect(text).toContain('{id}');
        expect(text).not.toMatch(/\{(name|email)\}/);
      }
    }
    expect(outcomes.filter((o) => deleteOutcomeView(o).gone)).toHaveLength(3);
    expect(deleteOutcomeView({ kind: 'rate_limited', retryAfterS: 30 }).seconds).toBe(30);
  });

  it('a not_found with sign-up administration off claims nothing about the request', () => {
    const off = deleteOutcomeView({ kind: 'not_found' }, 'off');
    expect(off).toEqual({ key: 'console.signups.delete.failed.off', gone: false });
    for (const l of LOCALES)
      expect(l.messages[off.key as keyof typeof l.messages]).toContain('{id}');
    expect(deleteOutcomeView({ kind: 'not_found' }).gone).toBe(true);
    const unsure = deleteOutcomeView({ kind: 'not_found' }, 'unconfirmed');
    expect(unsure).toEqual({ key: 'console.signups.delete.unconfirmed', gone: false });
    for (const l of LOCALES)
      expect(l.messages[unsure.key as keyof typeof l.messages]).toContain('{id}');
    // Only the service's audit log answers `already_deleted`: that stays true either way.
    expect(deleteOutcomeView({ kind: 'already_deleted' }, 'off').gone).toBe(true);
  });
});

describe('the badge of a row after unbound_state', () => {
  it('is replaced only for that outcome', () => {
    expect(signupBadgeOverride('console.signups.err.unbound_state')).toBe(
      'console.signups.status.accountUnconfirmed',
    );
    expect(signupBadgeOverride('console.signups.err.email_failed')).toBeNull();
    expect(signupBadgeOverride(undefined)).toBeNull();
  });
});
