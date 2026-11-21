/**
 * TBI-022 ops review follow-up (quiet hours slice): a drained approval email whose final save was
 * lost is never sent again automatically (N1), the admin's SIGTERM can wait for an in-flight drain
 * send (N1), the intake drains stale deferred alerts at start even with quiet hours off (N2), and a
 * secret path that is a FIFO fails at once instead of blocking (N5).
 */
import { execFileSync } from 'node:child_process';
import { closeSync, constants, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wireSignupAdmin } from '../signup/admin-wiring.js';
import { intakeConfigFromEnv, startIntake, type RunningIntake } from '../signup/intake-server.js';
import type { FetchLike } from '../signup/notify.js';
import { parseQuiet } from '../signup/quietHours.js';
import { readSecretFile } from '../signup/secret-file.js';
import { SignupApprover } from '../signup/service.js';
import { PendingStore } from '../signup/store.js';

const SECRET = 'test-secret-not-real-0123456789abcdef';
const TG_TOKEN = '1234567:AAAAAAAAAAAAAAAAAAAAAAAAAAAA_test';
const PERSON = {
  name: 'Dana',
  email: 'dana@example.com',
  role: 'T',
  lang: 'en' as const,
  consent: true as const,
};
const NIGHT = Date.parse('2026-01-15T23:30:00+02:00');
const MORNING = Date.parse('2026-01-16T08:00:00+02:00');

const roots: string[] = [];
const running: RunningIntake[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.close();
  roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'tbi-followup-'));
  roots.push(d);
  return d;
}

describe('N1: a drained send whose final save is lost is not repeated', () => {
  it('send accepted, email_sent not saved, next drain sends nothing; approve says email_not_resent', async () => {
    const c = { t: NIGHT };
    const now = () => c.t;
    const store = new PendingStore(join(tmp(), 'p'), { now });
    await store.init();
    const rec = await store.create(PERSON);
    const mails: string[] = [];
    const approver = new SignupApprover({
      store,
      quiet: parseQuiet(undefined),
      now,
      accounts: { add: async () => 'done' },
      email: { sendApproval: async (to: { id: string }) => void mails.push(to.id) },
    });
    expect(await approver.approve(rec.id)).toMatchObject({ ok: true, note: 'email_queued' });
    c.t = MORNING;
    // The provider accepts the mail; the process dies before `email_sent` is saved.
    const realUpdate = store.update.bind(store);
    const spy = vi.spyOn(store, 'update').mockImplementation(async (id, patch) => {
      if (patch.status === 'email_sent') throw new Error('crash');
      return realUpdate(id, patch);
    });
    await expect(approver.drainEmails()).rejects.toThrow('crash');
    spy.mockRestore();
    expect(mails).toEqual([rec.id]);
    expect(await store.get(rec.id)).toMatchObject({
      status: 'approved',
      emailAttempts: 1,
      emailSendAfter: null,
    });
    expect(await approver.drainEmails()).toBe(0);
    expect(await approver.approve(rec.id)).toMatchObject({ ok: true, note: 'email_not_resent' });
    expect(mails).toHaveLength(1);
  });
});

describe('N1: stopping the admin drain waits for an in-flight send', () => {
  it('stop() resolves only after the send in progress has finished and been saved', async () => {
    const root = tmp();
    const sent: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const sending = new Promise<void>((r) => (started = r));
    const w = await wireSignupAdmin(
      {
        dir: join(root, 'p'),
        keyFile: join(root, 'k'),
        from: 'x',
        labUrl: 'https://l.example.invalid/',
        quiet: null,
      },
      {} as never,
      {
        fetch: (async () => ({ ok: true, status: 200 })) as FetchLike,
        log: () => undefined,
        email: {
          sendApproval: async (to: { id: string }) => {
            started();
            await gate;
            sent.push(to.id);
          },
        },
      },
    );
    const rec = await w.store.create(PERSON);
    await w.store.update(rec.id, {
      status: 'email_queued',
      accountAdded: true,
      emailSendAfter: new Date(Date.now() - 1000).toISOString(),
    });
    const stop = w.startDrain();
    await sending;
    let stopped = false;
    const done = stop().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(stopped).toBe(false);
    release();
    await done;
    expect(sent).toEqual([rec.id]);
    expect(await w.store.get(rec.id)).toMatchObject({ status: 'email_sent' });
  });
});

describe('N2: intake drains stale deferred alerts at start', () => {
  it('quiet hours off: a .notifyq marker left from quiet hours is alerted once at start', async () => {
    const root = tmp();
    const hmac = join(root, 'hmac');
    const token = join(root, 'tg');
    writeFileSync(hmac, `${SECRET}\n`, { mode: 0o600 });
    writeFileSync(token, `${TG_TOKEN}\n`, { mode: 0o600 });
    const dir = join(root, 'p');
    const pre = new PendingStore(dir);
    await pre.init();
    const rec = await pre.create(PERSON);
    await pre.markNotifyPending(rec.id);
    const cfg = intakeConfigFromEnv({
      TBI_SIGNUP_INTAKE: '1',
      TBI_SIGNUP_DIR: dir,
      TBI_SIGNUP_HMAC_FILE: hmac,
      TBI_SIGNUP_TELEGRAM_TOKEN_FILE: token,
      TBI_SIGNUP_TELEGRAM_CHAT_ID: '42',
      TBI_SIGNUP_ADMIN_LINK: 'https://admin.example.invalid/signups',
      TBI_SIGNUP_LISTEN: '127.0.0.1:0',
      TBI_SIGNUP_QUIET: 'off',
    });
    if (!cfg.enabled) throw new Error('config');
    const urls: string[] = [];
    const fetch: FetchLike = async (u) => (urls.push(u), { ok: true, status: 200 });
    running.push(await startIntake(cfg.config, { fetch, log: () => undefined }));
    await vi.waitFor(async () => expect((await pre.get(rec.id)).notified).toBe(true), {
      timeout: 2000,
    });
    expect(urls).toHaveLength(1);
    expect((await pre.get(rec.id)).notifyPending).toBe(false);
  });
});

describe('N5: a FIFO secret path fails at once', () => {
  it('readSecretFile on a FIFO rejects with secret_not_file instead of blocking', async () => {
    const fifo = join(tmp(), 'fifo');
    try {
      execFileSync('mkfifo', ['-m', '600', fifo]);
    } catch {
      return; // no mkfifo on this host: nothing to test
    }
    try {
      const out = await Promise.race([
        readSecretFile(fifo).then(
          () => 'read',
          (e: Error) => e.message,
        ),
        new Promise<string>((r) => setTimeout(() => r('blocked'), 1500)),
      ]);
      expect(out).toBe('secret_not_file');
    } finally {
      // Unblock a reader that is stuck in open() (only in the failing case).
      try {
        closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
      } catch {
        /* no reader: fine */
      }
    }
  });
});
