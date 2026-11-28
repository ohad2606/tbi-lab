/**
 * BETA-G1: a failed approval send leaves one log line for the operator (the admin screens point to
 * the server log): a class from a fixed list and the request id, nothing else.
 */
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EmailError } from '../signup/email.js';
import { SignupApprover } from '../signup/service.js';
import { PendingStore } from '../signup/store.js';

const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function failedSend(error: Error) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tbi-sendlog-')));
  chmodSync(dir, 0o700);
  roots.push(dir);
  const store = new PendingStore(dir);
  await store.init();
  const { record } = await store.createIfNew({
    name: 'Tester One',
    email: 'tester1@example.com',
    role: 'Student',
    lang: 'en',
    consent: true,
  });
  const logs: string[] = [];
  const approver = new SignupApprover({
    store,
    email: {
      sendApproval: async () => {
        throw error;
      },
    },
    accounts: { add: async () => 'done' },
    log: (l) => void logs.push(l),
  });
  const out = await approver.approve(record.id);
  expect(out).toMatchObject({ ok: false, code: 'email_failed' });
  return { id: record.id, logs };
}

describe('a failed approval send is logged', () => {
  for (const code of ['http_401', 'http_403', 'network', 'bad_key'])
    it(`${code}: the class and the request id only`, async () => {
      const { id, logs } = await failedSend(new EmailError(code));
      expect(logs).toEqual([`signup: approval mail send failed (${code}) ${id}`]);
    });

  for (const code of ['secret_unsafe_mode', 'secret_not_file'])
    it(`${code}: named`, async () => {
      const { id, logs } = await failedSend(new Error(code));
      expect(logs).toEqual([`signup: approval mail send failed (${code}) ${id}`]);
    });

  for (const text of ['tester1@example.com refused', 're_secretkey12345', 'some_unlisted_word'])
    it(`anything else is just "error" (${text.length} chars)`, async () => {
      const { id, logs } = await failedSend(new Error(text));
      expect(logs).toEqual([`signup: approval mail send failed (error) ${id}`]);
    });
});
