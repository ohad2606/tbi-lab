/**
 * TBI-022: the Apps Script forwarder (deploy/signup/apps-script/Code.gs): its signer verifies with
 * runtime hmac.ts, and its send status / retry / owner alert logic (FABLE-REVIEW 3, 5) runs here
 * against Node stand-ins for the Apps Script services, with the runtime verifier as the endpoint.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { NonceCache, sign, verifyRequest } from '../signup/hmac.js';

const SECRET = 'test-secret-not-real-0123456789abcdef';
const NONCE = 'abcdefghijklmnop0123';
const TS = 1_795_000_000;
const BODY = '{"name":"Dana כהן","email":"a@example.com","role":"x","lang":"he","consent":true}';

/** Loads Code.gs with Node stand-ins for the Apps Script services it uses. */
function load(): { signRequest_: (s: string, t: number, n: string, b: string) => string } {
  const src = readFileSync(
    new URL('../../../deploy/signup/apps-script/Code.gs', import.meta.url),
    'utf8',
  );
  const Utilities = {
    newBlob: (s: string) => ({
      getBytes: () => [...Buffer.from(s, 'utf8')].map((b) => (b > 127 ? b - 256 : b)),
    }),
    computeHmacSha256Signature: (m: number[], k: number[]) =>
      [
        ...createHmac('sha256', Buffer.from(k.map((b) => b & 255)))
          .update(Buffer.from(m.map((b) => b & 255)))
          .digest(),
      ].map((b) => (b > 127 ? b - 256 : b)),
  };
  const ctx: Record<string, unknown> = { Utilities, console };
  runInNewContext(src, ctx);
  return ctx as never;
}

describe('Apps Script signer parity', () => {
  it('produces the same signature as runtime sign()', () => {
    const gs = load();
    expect(gs.signRequest_(SECRET, TS, NONCE, BODY)).toBe(
      sign(Buffer.from(SECRET), TS, NONCE, Buffer.from(BODY, 'utf8')),
    );
  });

  it('verifies with verifyRequest, and a changed body fails', () => {
    const gs = load();
    const headers = {
      'x-tbi-timestamp': String(TS),
      'x-tbi-nonce': NONCE,
      'x-tbi-signature': gs.signRequest_(SECRET, TS, NONCE, BODY),
    };
    const base = { secret: Buffer.from(SECRET), headers, now: TS * 1000, nonces: new NonceCache() };
    expect(verifyRequest({ ...base, body: Buffer.from(BODY, 'utf8') })).toEqual({ ok: true });
    expect(
      verifyRequest({ ...base, body: Buffer.from(BODY + ' ', 'utf8'), nonces: new NonceCache() }),
    ).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });
});

// ---------------------------------------------------------------- send status, retry, alerts

const MIN = 60_000;
const TITLES = ['Timestamp', 'Name', 'Email', 'Role', 'Language', 'Consent'];
const ANSWERS = ['Test Person', 'person@example.com', 'Teacher', 'English', 'I agree'];
const EXPECTED_BODY =
  '{"name":"Test Person","email":"person@example.com","role":"Teacher","lang":"en","consent":true}';
const URL_OK = 'https://signup.example.invalid/signup';

class FakeSheet {
  constructor(
    readonly name: string,
    readonly id: number,
    readonly rows: unknown[][] = [],
  ) {}
  getSheetId = () => this.id;
  getName = () => this.name;
  getLastRow = () => this.rows.length;
  getLastColumn = () => Math.max(0, ...this.rows.map((r) => r.length));
  appendRow = (r: unknown[]) => void this.rows.push([...r]);
  getDataRange = () => this.getRange(1, 1, this.rows.length, this.getLastColumn());
  getRange = (r: number, c: number, nr = 1, nc = 1) => ({
    getValue: () => this.rows[r - 1]?.[c - 1] ?? '',
    getValues: () =>
      Array.from({ length: nr }, (_, i) =>
        Array.from({ length: nc }, (_, j) => this.rows[r - 1 + i]?.[c - 1 + j] ?? ''),
      ),
    setValues: (v: unknown[][]) =>
      v.forEach((row, i) =>
        row.forEach((x, j) => {
          (this.rows[r - 1 + i] ??= [])[c - 1 + j] = x;
        }),
      ),
  });
}

interface Gs {
  onFormSubmit(e: unknown): void;
  retryUnsent(now?: number): number;
  installRetryTrigger(): void;
  backoffMinutes_(n: number): number;
  isHttpsUrl_(u: string): boolean;
  MAX_ATTEMPTS: number;
}

/** Code.gs with fake services; `answer` decides each POST (verified with the runtime verifier first). */
function world(o: {
  url?: string | null;
  answer: (n: number) => number | Error | [number, number];
}) {
  const src = readFileSync(
    new URL('../../../deploy/signup/apps-script/Code.gs', import.meta.url),
    'utf8',
  );
  const responses = new FakeSheet('Form Responses 1', 101, [TITLES]);
  const sheets: FakeSheet[] = [responses];
  const posts: { verified: boolean; body: string; opts: Record<string, unknown> }[] = [];
  const mails: { to: string; subject: string; body: string }[] = [];
  const nonces = new NonceCache();
  const triggers: { handler: string; minutes: number; deleted: boolean }[] = [
    { handler: 'retryUnsent', minutes: 1, deleted: false },
  ];
  const props: Record<string, string | null> = {
    ENDPOINT_URL: o.url === undefined ? URL_OK : o.url,
    HMAC_SECRET: SECRET,
  };
  const ctx: Record<string, unknown> = {
    console: { log: () => undefined },
    Utilities: {
      newBlob: (s: string) => ({
        getBytes: () => [...Buffer.from(s, 'utf8')].map((b) => (b > 127 ? b - 256 : b)),
      }),
      computeHmacSha256Signature: (m: number[], k: number[]) =>
        [
          ...createHmac('sha256', Buffer.from(k.map((b) => b & 255)))
            .update(Buffer.from(m.map((b) => b & 255)))
            .digest(),
        ].map((b) => (b > 127 ? b - 256 : b)),
      getUuid: () => randomUUID(),
    },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k: string) => props[k] ?? null }),
    },
    UrlFetchApp: {
      fetch: (url: string, opts: { payload: string; headers: Record<string, string> }) => {
        const v = verifyRequest({
          secret: Buffer.from(SECRET),
          headers: opts.headers,
          body: Buffer.from(opts.payload, 'utf8'),
          now: Date.now(),
          nonces,
        });
        posts.push({ verified: v.ok, body: opts.payload, opts: opts as never });
        expect(url).toBe(props.ENDPOINT_URL);
        const a = o.answer(posts.length);
        if (a instanceof Error) throw a;
        const [code, ra] = Array.isArray(a) ? a : [a, 0];
        return {
          getResponseCode: () => code,
          getHeaders: () => (ra ? { 'Retry-After': String(ra) } : {}),
        };
      },
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheets: () => sheets,
        getSheetByName: (n: string) => sheets.find((x) => x.name === n) ?? null,
        insertSheet: (n: string) => {
          const s = new FakeSheet(n, 900 + sheets.length);
          sheets.push(s);
          return s;
        },
      }),
    },
    LockService: {
      getScriptLock: () => ({ waitLock: () => undefined, releaseLock: () => undefined }),
    },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.invalid' }) },
    MailApp: {
      sendEmail: (to: string, subject: string, body: string) =>
        void mails.push({ to, subject, body }),
    },
    ScriptApp: {
      getProjectTriggers: () =>
        triggers.filter((t) => !t.deleted).map((t) => ({ getHandlerFunction: () => t.handler, t })),
      deleteTrigger: (x: { t: { deleted: boolean } }) => void (x.t.deleted = true),
      newTrigger: (handler: string) => ({
        timeBased: () => ({
          everyMinutes: (m: number) => ({
            create: () => void triggers.push({ handler, minutes: m, deleted: false }),
          }),
        }),
      }),
    },
  };
  runInNewContext(src, ctx);
  const gs = ctx as unknown as Gs;
  /** A new response row (as the form writes it) and the trigger's event for it. */
  const submit = (answers: unknown[] = ANSWERS) => {
    responses.appendRow([Date.now() - 1000, ...answers]);
    const row = responses.rows.length;
    gs.onFormSubmit({ range: { getRow: () => row, getSheet: () => responses } });
    return row;
  };
  const status = () => {
    const st = sheets.find((x) => x.name === 'TBI send status');
    return (st?.rows.slice(1) ?? []).map((r) => ({
      row: r[0],
      status: r[3],
      attempts: r[4],
      last: r[5],
      next: r[6] ? (r[6] as Date).getTime() : null,
      alerted: r[8],
    }));
  };
  return { gs, submit, status, posts, mails, responses, triggers, props };
}

describe('Apps Script forwarder: send status, retry, owner alert', () => {
  it('a 2xx on the first attempt: status sent, one signed post with the exact body, no alert', () => {
    const w = world({ answer: () => 202 });
    const row = w.submit();
    expect(w.posts).toHaveLength(1);
    expect(w.posts[0]).toMatchObject({ verified: true, body: EXPECTED_BODY });
    expect(w.posts[0]!.opts.followRedirects).toBe(false);
    expect(w.status()).toEqual([
      { row, status: 'sent', attempts: 1, last: '202', next: null, alerted: '' },
    ]);
    expect(w.gs.retryUnsent(Date.now() + 999 * MIN)).toBe(0);
    expect(w.mails).toEqual([]);
  });

  it('transient failures back off (5, 10 min ...), honour a longer Retry-After, then send; each attempt freshly signed', () => {
    const w = world({ answer: (n) => (n === 1 ? 503 : n === 2 ? [429, 3600] : 202) });
    const t0 = Date.now();
    w.submit();
    expect(w.status()[0]).toMatchObject({ status: 'retry', attempts: 1, last: '503' });
    const next1 = w.status()[0]!.next!;
    expect(next1 - t0).toBeGreaterThanOrEqual(5 * MIN - 1000);
    expect(next1 - t0).toBeLessThan(5 * MIN + 5000);
    expect(w.gs.retryUnsent(next1 - 1)).toBe(0);
    expect(w.posts).toHaveLength(1);
    expect(w.gs.retryUnsent(next1)).toBe(1);
    expect(w.status()[0]).toMatchObject({ status: 'retry', attempts: 2, last: '429' });
    const next2 = w.status()[0]!.next!;
    expect(next2 - next1).toBeGreaterThanOrEqual(3600_000); // Retry-After 1 h > backoff 10 min
    expect(w.gs.retryUnsent(next2)).toBe(1);
    expect(w.status()[0]).toMatchObject({ status: 'sent', attempts: 3, last: '202', next: null });
    expect(w.posts.every((p) => p.verified)).toBe(true); // no nonce reused
    expect(w.mails).toEqual([]);
  });

  it('repeated failure: one alert at the 3rd attempt, gives up after 8 with a second alert; no answers in mail', () => {
    const w = world({ answer: () => new Error('transport') });
    w.submit();
    w.gs.retryUnsent(w.status()[0]!.next!);
    expect(w.status()[0]!.attempts).toBe(2);
    expect(w.mails).toEqual([]);
    w.gs.retryUnsent(w.status()[0]!.next!);
    expect(w.status()[0]!.attempts).toBe(3);
    expect(w.mails).toHaveLength(1);
    let guard = 0;
    while (w.status()[0]!.status === 'retry' && guard++ < 20)
      w.gs.retryUnsent(w.status()[0]!.next!);
    expect(w.gs.MAX_ATTEMPTS).toBe(8);
    expect(w.posts).toHaveLength(8);
    expect(w.status()[0]).toMatchObject({
      status: 'failed',
      attempts: 8,
      last: 'network',
      next: null,
    });
    expect(w.mails.map((m) => m.subject)).toEqual([
      'TBI Lab sign-up forwarding: repeated',
      'TBI Lab sign-up forwarding: failed',
    ]);
    expect(w.mails.every((m) => m.to === 'owner@example.invalid')).toBe(true);
    for (const m of w.mails) {
      expect(m.body).not.toContain('Test Person');
      expect(m.body).not.toContain('person@example.com');
      expect(m.body).toContain('Response row: 2');
    }
    expect(w.gs.retryUnsent(Date.now() + 9999 * MIN)).toBe(0);
  });

  it('backoff: 5, 10, 20, 40, 80, 160, 320 min, capped at 6 h', () => {
    const w = world({ answer: () => 202 });
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => w.gs.backoffMinutes_(n))).toEqual([
      5, 10, 20, 40, 80, 160, 320, 360, 360,
    ]);
  });

  it('a permanent refusal (400) is given up at once with an alert', () => {
    const w = world({ answer: () => 400 });
    w.submit();
    expect(w.status()[0]).toMatchObject({ status: 'failed', attempts: 1, last: '400' });
    expect(w.mails).toHaveLength(1);
    expect(w.gs.retryUnsent(Date.now() + 9999 * MIN)).toBe(0);
  });

  it('401 (e.g. a secret rotation in progress) is retried, not given up', () => {
    const w = world({ answer: (n) => (n === 1 ? 401 : 202) });
    w.submit();
    expect(w.status()[0]).toMatchObject({ status: 'retry', last: '401' });
    w.gs.retryUnsent(w.status()[0]!.next!);
    expect(w.status()[0]).toMatchObject({ status: 'sent' });
  });

  it('ENDPOINT_URL must be https: nothing is sent, the owner is alerted once, a fix is picked up', () => {
    const w = world({ url: 'http://signup.example.invalid/signup', answer: () => 202 });
    w.submit();
    expect(w.posts).toEqual([]);
    expect(w.status()[0]).toMatchObject({ status: 'retry', last: 'endpoint_not_https' });
    w.gs.retryUnsent(w.status()[0]!.next!);
    expect(w.mails.map((m) => m.subject)).toEqual(['TBI Lab sign-up forwarding: config']);
    w.props.ENDPOINT_URL = URL_OK;
    w.gs.retryUnsent(w.status()[0]!.next!);
    expect(w.posts).toHaveLength(1);
    expect(w.status()[0]).toMatchObject({ status: 'sent' });
    for (const u of ['https://signup.example.invalid/signup', 'HTTPS://signup.example.invalid'])
      expect(w.gs.isHttpsUrl_(u), u).toBe(true);
    for (const u of [
      'http://signup.example.invalid/signup',
      'https:/x',
      'https://',
      'ftp://x',
      ' https://x',
      'https://user@x/',
      '',
    ])
      expect(w.gs.isHttpsUrl_(u), u).toBe(false);
  });

  it('a missing setting is a config retry with an alert (no post)', () => {
    const w = world({ url: null, answer: () => 202 });
    w.submit();
    expect(w.posts).toEqual([]);
    expect(w.status()[0]).toMatchObject({ status: 'retry', last: 'not_configured' });
    expect(w.mails).toHaveLength(1);
  });

  it('a response row that changed (sorted / deleted) is not sent with the wrong answers', () => {
    const w = world({ answer: (n) => (n === 1 ? 503 : 202) });
    const row = w.submit();
    w.responses.rows[row - 1]![0] = 12345; // another response now sits in that row
    w.gs.retryUnsent(w.status()[0]!.next!);
    expect(w.posts).toHaveLength(1);
    expect(w.status()[0]).toMatchObject({ status: 'failed', last: 'row_moved' });
    expect(w.mails).toHaveLength(1);
  });

  it('answers that do not map (question titles) are skipped with an alert, never posted', () => {
    const w = world({ answer: () => 202 });
    w.submit(['Test Person', 'person@example.com', 'Teacher', 'Klingon', 'I agree']);
    expect(w.posts).toEqual([]);
    expect(w.status()[0]).toMatchObject({ status: 'skipped', last: 'incomplete' });
    expect(w.mails.map((m) => m.subject)).toEqual(['TBI Lab sign-up forwarding: skipped']);
  });

  it('a form-bound trigger (no response row) is refused explicitly with an alert', () => {
    const w = world({ answer: () => 202 });
    w.gs.onFormSubmit({ response: {} });
    expect(w.posts).toEqual([]);
    expect(w.mails.map((m) => m.subject)).toEqual(['TBI Lab sign-up forwarding: setup']);
  });

  it('installRetryTrigger replaces the 5-minute trigger instead of adding a second one', () => {
    const w = world({ answer: () => 202 });
    w.gs.installRetryTrigger();
    w.gs.installRetryTrigger();
    expect(w.triggers.filter((t) => !t.deleted).map((t) => `${t.handler}@${t.minutes}`)).toEqual([
      'retryUnsent@5',
    ]);
  });
});
