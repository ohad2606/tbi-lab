/** BETA-G1 S5: parsing of the email verification states and the screen's logic for them. */
import { describe, expect, it } from 'vitest';
import {
  VERIFICATION_STATES,
  loadAllSignups,
  loadOpenSignups,
  parseAutoApproveStatus,
  type SignupRecord,
} from '@tbi-lab/admin-client';
import { LOCALES, isMessageKey } from '../src/i18n.js';
import {
  approveWarningKey,
  isAutoApproved,
  isUnconfirmedRow,
  signupStatusKey,
  verificationKey,
} from '../src/views.js';

const AT = '2026-11-23T10:00:00.000Z';
const m = (c: string) => LOCALES.find((l) => l.code === c)!.messages as Record<string, string>;
const wire = (extra: object = {}) => ({
  id: 'a1',
  name: 'Dana Example',
  email: 'dana@example.invalid',
  status: 'pending',
  accountAdded: false,
  lastError: null,
  origin: 'web',
  createdAt: AT,
  ...extra,
});

const answer = (body: object) => async () => new Response(JSON.stringify(body), { status: 200 });

async function parse(row: object, envelope: object = { rowStates: 1 }): Promise<SignupRecord> {
  const body = { signups: [row], ...envelope };
  const open = await loadOpenSignups(answer(body));
  const all = await loadAllSignups(answer(body));
  expect(all).toEqual(open);
  if (!open.ok || !open.value[0]) throw new Error('row dropped');
  return open.value[0];
}

describe('row verification', () => {
  it('copies the closed state and a strict time only', async () => {
    const r = await parse(wire({ verification: { state: 'sent', sentAt: AT, hash: 'x' } }));
    expect(r.verification).toEqual({ state: 'sent', sentAt: AT });
    for (const state of VERIFICATION_STATES.filter((s) => s !== 'sent'))
      expect((await parse(wire({ verification: { state, sentAt: AT } }))).verification).toEqual({
        state,
        sentAt: null,
      });
  });

  it('malformed is unknown and never drops the row', async () => {
    for (const verification of [
      null,
      'sent',
      [],
      { state: 'confirmed' },
      { state: 'sent' },
      { state: 'sent', sentAt: '2026-11-23' },
      { state: 'sent', sentAt: '2026-13-99T10:00:00Z' },
      { state: 'sent', sentAt: `${AT}${'0'.repeat(999)}` },
    ])
      expect((await parse(wire({ verification }))).verification).toEqual({
        state: 'unknown',
        sentAt: null,
      });
  });

  it('absent, or without the envelope mark (old server, stored key) = feature off', async () => {
    expect(await parse(wire())).not.toHaveProperty('verification');
    const forged = wire({ verification: { state: 'approved_auto' } });
    expect(await parse(forged, {})).not.toHaveProperty('verification');
    expect(await parse(forged, { rowStates: '1' })).not.toHaveProperty('verification');
  });

  it('with the feature on, "approved automatically" needs the account', async () => {
    expect((await parse(wire({ autoApprovedAt: AT }))).autoApprovedAt).toBeNull();
    const done = { autoApprovedAt: AT, accountAdded: true, status: 'approved' };
    expect((await parse(wire(done))).autoApprovedAt).toBe(AT);
    expect((await parse(wire({ autoApprovedAt: AT }), {})).autoApprovedAt).toBe(AT);
  });

  it('a forged pending record with the auto mark stays folded and still warns', async () => {
    const r = await parse(
      wire({
        status: 'pending',
        accountAdded: true,
        autoApprovedAt: AT,
        verification: { state: 'not_sent' },
      }),
    );
    expect(r.autoApprovedAt).toBeNull();
    expect(isUnconfirmedRow(r)).toBe(true);
    expect(approveWarningKey(r)).toBe('console.signups.confirmApprove.unconfirmed');
  });

  it('folds only proven web, pending, unapproved, unfailed, unverified rows', async () => {
    const row = async (extra: object, state: string = 'not_sent') =>
      parse(wire({ verification: { state, sentAt: AT }, ...extra }));
    expect(isUnconfirmedRow(await row({}))).toBe(true);
    expect(isUnconfirmedRow(await row({}, 'sent'))).toBe(true);
    for (const s of VERIFICATION_STATES.filter((x) => x !== 'sent' && x !== 'not_sent'))
      expect(isUnconfirmedRow(await row({}, s))).toBe(false);
    for (const extra of [
      { origin: undefined },
      { status: 'approved' },
      { status: 'email_failed' },
      { lastError: 'account_error' },
    ])
      expect(isUnconfirmedRow(await row(extra))).toBe(false);
    expect(isUnconfirmedRow(await parse(wire()))).toBe(false);
  });

  it('every state has a text; approve warns unless confirmed, in both languages', async () => {
    for (const state of VERIFICATION_STATES) {
      const r = await parse(wire({ verification: { state, sentAt: AT } }));
      const key = verificationKey(r);
      expect(key === null).toBe(state === 'approved_auto');
      if (key) expect(isMessageKey(key)).toBe(true);
      const warn = approveWarningKey(r);
      expect(warn !== null).toBe(
        ['not_sent', 'sent', 'address_changed', 'unknown'].includes(state),
      );
      if (warn) expect(isMessageKey(warn)).toBe(true);
    }
    expect(approveWarningKey(await parse(wire()))).toBeNull();
  });
});

describe('row status badge', () => {
  const AUTO = 'console.signups.status.autoWait';
  const OWN = 'console.signups.status.pending';
  const row = (state: string, extra: object = {}, envelope?: object) =>
    parse(wire({ verification: { state, sentAt: AT }, ...extra }), envelope);

  it('says "waiting for automatic approval" only for the two states that promise it', async () => {
    const auto = ['confirmed_queued', 'confirmed_waiting_limit'];
    for (const state of [...VERIFICATION_STATES, 'not_a_state'])
      expect(signupStatusKey(await row(state)), state).toBe(auto.includes(state) ? AUTO : OWN);
    expect(signupStatusKey(await parse(wire()))).toBe(OWN);
    expect(signupStatusKey(await row('confirmed_queued', {}, {}))).toBe(OWN);
    expect(isMessageKey(AUTO)).toBe(true);
  });

  it('keeps the owner on a failed, claimed, unknown-status or acted-on row', async () => {
    for (const state of ['confirmed_queued', 'confirmed_waiting_limit']) {
      expect(signupStatusKey(await row(state, { lastError: 'account_error' }))).toBe(OWN);
      expect(signupStatusKey(await row(state, { status: 'something_new' }))).toBe(OWN);
      const r = await row(state);
      expect(signupStatusKey({ ...r, autoApprovedAt: AT })).toBe(OWN);
      // An action's answer on this screen is newer than the loaded state.
      expect(signupStatusKey(r, true)).toBe(OWN);
      expect(signupStatusKey(await row(state, { status: 'email_failed' }))).toBe(
        'console.signups.status.emailFailed',
      );
    }
  });

  it('"approved automatically" needs an added account and a decided row, also with verification off', async () => {
    for (const envelope of [{}, { rowStates: 1 }]) {
      const mark = async (extra: object) =>
        isAutoApproved(await parse(wire({ autoApprovedAt: AT, ...extra }), envelope));
      expect(await mark({})).toBe(false);
      expect(await mark({ accountAdded: true })).toBe(false);
      expect(await mark({ status: 'approved' })).toBe(false);
      for (const status of ['approved', 'email_queued', 'email_failed'])
        expect(await mark({ status, accountAdded: true }), status).toBe(true);
      // BETA-G1: the owner added the account after a failed automatic attempt: never automatic.
      for (const status of ['approved', 'email_queued', 'email_sent'])
        expect(await mark({ status, accountAdded: true, approvedBy: 'owner' }), status).toBe(false);
      // Tolerant parse: only the exact tag counts.
      for (const approvedBy of ['Owner', 'auto', 1, null, ''])
        expect(await mark({ status: 'approved', accountAdded: true, approvedBy })).toBe(true);
    }
  });
});

describe('row verification line', () => {
  const CONFIRMED = 'console.signups.verify.confirmed';
  const PROMISES = ['confirmed_queued', 'confirmed_waiting_limit'];
  const row = (state: string) => parse(wire({ verification: { state, sentAt: AT } }));

  it('names the automatic approval only while the badge does', async () => {
    for (const state of PROMISES) {
      const r = await row(state);
      expect(verificationKey(r)).toBe(`console.signups.verify.${state}`);
      for (const [rec, acted] of [
        [r, true],
        [{ ...r, lastError: 'account_error' }, false],
        [{ ...r, autoApprovedAt: AT }, false],
        [{ ...r, status: 'approved', accountAdded: true }, false],
        [{ ...r, status: 'email_failed', accountAdded: true }, false],
        [{ ...r, status: 'email_queued', accountAdded: true }, false],
        [{ ...r, status: 'something_new' }, false],
      ] as const) {
        const label = `${state} ${JSON.stringify([rec.status, rec.lastError, acted])}`;
        expect(signupStatusKey(rec, acted), label).not.toBe('console.signups.status.autoWait');
        expect(verificationKey(rec, acted), label).toBe(CONFIRMED);
      }
    }
    expect(isMessageKey(CONFIRMED)).toBe(true);
    expect(m('en')[CONFIRMED]).toBe('Email confirmed');
    expect(m('he')[CONFIRMED]).toBe('כתובת המייל אומתה');
  });

  it('keeps the other states after an action', async () => {
    for (const state of VERIFICATION_STATES.filter((s) => !PROMISES.includes(s))) {
      const r = await row(state);
      expect(verificationKey({ ...r, lastError: 'account_error' }, true)).toBe(verificationKey(r));
    }
    expect(verificationKey(await parse(wire()), true)).toBeNull();
  });

  it('says in Hebrew that a later automatic approval is possible, not promised', () => {
    expect(m('he')['console.signups.verify.confirmed_waiting_limit']).toBe(
      'כתובת המייל אומתה. במכסת האישורים האוטומטיים של היום לא נשאר מקום לבקשה הזאת. אפשר שהיא תאושר אוטומטית באחד הימים הבאים, ואפשר גם לאשר אותה כבר עכשיו.',
    );
  });
});

describe('safeguard status', () => {
  const guard = (safeguards: unknown) =>
    parseAutoApproveStatus({ enabled: false, safeguards })!.safeguards;

  it('absent = off', () => {
    expect(parseAutoApproveStatus({ enabled: false })).not.toHaveProperty('safeguards');
  });

  it('copies named non-negative safe integers; anything else is unknown, never 0', () => {
    expect(
      guard({
        paused: false,
        extra: 'x',
        verify: { today: 2, limit: 50, waiting: -1, hash: 'x' },
        mail: { day: 1.5, dayLimit: 95, d30: '3', d30Limit: 2 ** 60 },
      }),
    ).toEqual({
      paused: false,
      verify: { today: 2, limit: 50, waiting: 'unknown' },
      mail: { day: 'unknown', dayLimit: 95, d30: 'unknown', d30Limit: 'unknown' },
    });
    expect(guard('x')).toEqual({ paused: 'unknown' });
    expect(guard({ paused: 'no', mail: null })).toEqual({
      paused: 'unknown',
      mail: { day: 'unknown', dayLimit: 'unknown', d30: 'unknown', d30Limit: 'unknown' },
    });
  });
});
