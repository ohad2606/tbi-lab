/**
 * TBI-022 retention (owner directive 2026-11-21, the notice published in the sign-up form):
 * requests not approved are deleted within 90 days, all others are kept at most 12 months; both
 * counted from creation and configurable (validated) by environment. Unit; temp dirs only.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adminSignupConfigFromEnv,
  PURGE_INTERVAL_MS,
  wireSignupAdmin,
} from '../signup/admin-wiring.js';
import {
  DEFAULT_RETENTION,
  PendingStore,
  retentionFromEnv,
  type SignupStatus,
} from '../signup/store.js';

const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 1);
const PERSON = {
  name: 'Test Person',
  role: 'Teacher',
  lang: 'en' as const,
  consent: true as const,
};
const FLAG_ENV = {
  TBI_SIGNUP_ADMIN: '1',
  TBI_SIGNUP_DIR: '/x/p',
  TBI_SIGNUP_RESEND_KEY_FILE: '/x/k',
  TBI_SIGNUP_FROM: 'TBI Lab <support@example.com>',
  TBI_SIGNUP_LAB_URL: 'https://lab.example.invalid/',
};

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

async function storeAt(clock: { t: number }) {
  const root = mkdtempSync(join(tmpdir(), 'tbi-retention-'));
  roots.push(root);
  const store = new PendingStore(join(root, 'p'), { now: () => clock.t });
  await store.init();
  let n = 0;
  const make = async (status: SignupStatus) => {
    const r = await store.create({ ...PERSON, email: `p${n++}@example.com` });
    return status === 'pending' ? r : store.update(r.id, { status, accountAdded: true });
  };
  return { store, make, root };
}

describe('retention settings', () => {
  it('defaults are 90 days (not approved) and 365 days (everything)', () => {
    expect(DEFAULT_RETENTION).toEqual({ notApprovedMs: 90 * DAY, maxMs: 365 * DAY });
    expect(retentionFromEnv({})).toEqual(DEFAULT_RETENTION);
    expect(
      retentionFromEnv({
        TBI_SIGNUP_RETENTION_PENDING_DAYS: '',
        TBI_SIGNUP_RETENTION_MAX_DAYS: '',
      }),
    ).toEqual(DEFAULT_RETENTION);
  });

  it('accepts whole days 1..365 with pending <= max', () => {
    expect(
      retentionFromEnv({
        TBI_SIGNUP_RETENTION_PENDING_DAYS: '30',
        TBI_SIGNUP_RETENTION_MAX_DAYS: '180',
      }),
    ).toEqual({ notApprovedMs: 30 * DAY, maxMs: 180 * DAY });
    expect(
      retentionFromEnv({
        TBI_SIGNUP_RETENTION_PENDING_DAYS: '1',
        TBI_SIGNUP_RETENTION_MAX_DAYS: '1',
      }),
    ).toEqual({ notApprovedMs: DAY, maxMs: DAY });
    expect(retentionFromEnv({ TBI_SIGNUP_RETENTION_PENDING_DAYS: '365' })).toEqual({
      notApprovedMs: 365 * DAY,
      maxMs: 365 * DAY,
    });
  });

  it.each([
    [{ TBI_SIGNUP_RETENTION_PENDING_DAYS: '0' }],
    [{ TBI_SIGNUP_RETENTION_PENDING_DAYS: '366' }],
    [{ TBI_SIGNUP_RETENTION_MAX_DAYS: '366' }],
    [{ TBI_SIGNUP_RETENTION_MAX_DAYS: '0' }],
    [{ TBI_SIGNUP_RETENTION_MAX_DAYS: '1.5' }],
    [{ TBI_SIGNUP_RETENTION_MAX_DAYS: '-5' }],
    [{ TBI_SIGNUP_RETENTION_PENDING_DAYS: '90d' }],
    [{ TBI_SIGNUP_RETENTION_PENDING_DAYS: ' 90' }],
    [{ TBI_SIGNUP_RETENTION_PENDING_DAYS: '100', TBI_SIGNUP_RETENTION_MAX_DAYS: '99' }],
    [{ TBI_SIGNUP_RETENTION_MAX_DAYS: '60' }], // default pending 90 > 60
  ])('refuses %j (the sign-up feature stays off, with a reason)', (env) => {
    expect(() => retentionFromEnv(env)).toThrow(/TBI_SIGNUP_RETENTION_/);
    const c = adminSignupConfigFromEnv({ ...FLAG_ENV, ...env });
    expect(c).toMatchObject({ enabled: false, error: true });
    expect(c.reason).toMatch(/TBI_SIGNUP_RETENTION_/);
  });

  it('the admin config carries the parsed retention', () => {
    const c = adminSignupConfigFromEnv({
      ...FLAG_ENV,
      TBI_SIGNUP_RETENTION_PENDING_DAYS: '45',
      TBI_SIGNUP_RETENTION_MAX_DAYS: '200',
    });
    expect(c.enabled && c.config.retention).toEqual({ notApprovedMs: 45 * DAY, maxMs: 200 * DAY });
    const d = adminSignupConfigFromEnv(FLAG_ENV);
    expect(d.enabled && d.config.retention).toEqual(DEFAULT_RETENTION);
  });
});

describe('purge boundaries (default retention, no horizon)', () => {
  it.each(['pending', 'rejected'] as const)(
    '%s: kept 1 ms before 90 days, deleted at 90 days',
    async (status) => {
      const clock = { t: START };
      const { store, make } = await storeAt(clock);
      const r = await make(status);
      clock.t = START + 90 * DAY - 1;
      expect(await store.purge()).toEqual([]);
      clock.t = START + 90 * DAY;
      expect(await store.purge()).toEqual([r.id]);
    },
  );

  it.each(['approved', 'email_queued', 'email_failed', 'email_sent'] as const)(
    '%s: kept 1 ms before 365 days, deleted at 365 days',
    async (status) => {
      const clock = { t: START };
      const { store, make } = await storeAt(clock);
      const r = await make(status);
      clock.t = START + 365 * DAY - 1;
      expect(await store.purge()).toEqual([]);
      clock.t = START + 365 * DAY;
      expect(await store.purge()).toEqual([r.id]);
    },
  );

  it('the limit is absolute: a later update does not extend it', async () => {
    const clock = { t: START };
    const { store, make } = await storeAt(clock);
    const pending = await make('pending');
    const failed = await make('email_failed');
    clock.t = START + 89 * DAY;
    await store.update(pending.id, { lastError: 'cap_reached' });
    clock.t = START + 364 * DAY;
    await store.update(failed.id, { lastError: 'http_500', emailAttempts: 3 });
    clock.t = START + 365 * DAY;
    expect((await store.purge()).sort()).toEqual([pending.id, failed.id].sort());
  });

  it('a request approved before 90 days is then kept up to 365 days', async () => {
    const clock = { t: START };
    const { store, make } = await storeAt(clock);
    const r = await make('pending');
    clock.t = START + 80 * DAY;
    await store.update(r.id, { status: 'email_sent', accountAdded: true });
    clock.t = START + 200 * DAY;
    expect(await store.purge()).toEqual([]);
    clock.t = START + 365 * DAY;
    expect(await store.purge()).toEqual([r.id]);
  });

  it('the not-approved limit never exceeds the overall cap', async () => {
    const clock = { t: START };
    const { store, make } = await storeAt(clock);
    const r = await make('pending');
    clock.t = START + 10 * DAY;
    expect(await store.purge({ notApprovedMs: 90 * DAY, maxMs: 10 * DAY })).toEqual([r.id]);
  });

  it('a record with an unreadable creation time is deleted, not kept forever', async () => {
    const clock = { t: START };
    const { store, make } = await storeAt(clock);
    const r = await make('email_failed');
    await store.update(r.id, { createdAt: 'garbage' } as never);
    expect(await store.purge()).toEqual([r.id]);
  });
});

describe('purge horizon: nothing outlives its limit between two daily runs', () => {
  it('deletes what would pass its deadline before the next run', async () => {
    const clock = { t: START };
    const { store, make } = await storeAt(clock);
    const r = await make('pending');
    const a = await make('approved');
    clock.t = START + 89 * DAY - 1;
    expect(await store.purge(DEFAULT_RETENTION, DAY)).toEqual([]);
    clock.t = START + 89 * DAY;
    expect(await store.purge(DEFAULT_RETENTION, DAY)).toEqual([r.id]);
    clock.t = START + 364 * DAY;
    expect(await store.purge(DEFAULT_RETENTION, DAY)).toEqual([a.id]);
  });

  it('the admin wiring purges with the configured retention and the daily horizon', async () => {
    const clock = { t: START };
    const { store, make, root } = await storeAt(clock);
    const r = await make('pending');
    const keep = await make('email_failed');
    clock.t = START + 29 * DAY + 1; // 30-day setting, next run in 24 h -> delete now
    const logs: string[] = [];
    const purge = vi.spyOn(PendingStore.prototype, 'purge');
    try {
      const wiring = await wireSignupAdmin(
        {
          dir: join(root, 'p'),
          keyFile: '/u',
          from: 'x',
          labUrl: 'https://l.example.invalid/',
          retention: { notApprovedMs: 30 * DAY, maxMs: 60 * DAY },
        },
        {} as never,
        {
          fetch: async () => ({ ok: true, status: 200 }),
          log: (l) => logs.push(l),
          now: () => clock.t,
          email: { sendApproval: async () => undefined },
        },
      );
      const stop = wiring.startPurge();
      await vi.waitFor(() => expect(logs).toContain('signup: purge removed 1'));
      stop();
      expect(purge).toHaveBeenCalledWith(
        { notApprovedMs: 30 * DAY, maxMs: 60 * DAY },
        PURGE_INTERVAL_MS,
      );
      expect((await store.list()).map((x) => x.id)).toEqual([keep.id]);
      expect(r.id).not.toBe(keep.id);
    } finally {
      purge.mockRestore();
    }
  });
});
