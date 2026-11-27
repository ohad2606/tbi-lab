/**
 * G1-AUTO-VERIFY slice 1: verify token, admin verify state, verify mail, marker consume and
 * `TBI_SIGNUP_AUTO_WEB=verified`. Real temp dirs; markers written as a (compromised) intake would.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTO_PAUSE_FILE, autoApproveConfigFromEnv } from '../signup/autoApprove.js';
import {
  signupWiringFromEnv,
  wireSignupAdmin,
  type SignupAdminWiring,
} from '../signup/admin-wiring.js';
import { verifyEmail, type EmailSender, type VerifyMailTo } from '../signup/email.js';
import type { FetchLike } from '../signup/notify.js';
import {
  checkVerifyToken,
  loadVerifyKeys,
  mintVerifyToken,
  parseSiteUrl,
  parseVerifyKey,
  parseVerifyToken,
  tokenHash,
} from '../signup/verify.js';
import {
  VERIFY_DIR,
  VERIFY_MARKERS_PER_SWEEP,
  VERIFY_MAX_PER_DAY,
  verifyConfigFromEnv,
  Verifier,
} from '../signup/verifyState.js';
import { PendingStore } from '../signup/store.js';
import type { AdminSpool } from '../accounts.js';
import type { Principal } from '../../identity/principal.js';

const T0 = Date.parse('2026-11-23T10:00:00Z'); // 12:00 Israel
const DAY = 86_400_000;
// Test keys are generated per run (never a fixed key-looking literal in a public repo).
const KEY_HEX = randomBytes(32).toString('hex');
const KEY2_HEX = randomBytes(32).toString('hex');
const ID = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const SITE = 'https://site.example.com';
const person = (i: number, lang: 'he' | 'en' = 'en') => ({
  name: `Tester ${i}`,
  email: `tester${i}@example.com`,
  role: 'Student',
  lang,
  consent: true as const,
});

const roots: string[] = [];
const allLogs: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
  // Req 13: class codes and counts only, on every line of every test (error paths included).
  for (const l of allLogs.splice(0))
    expect(l).not.toMatch(
      /@|example|Tester|evil|[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{12}|v1\.|#verify|\/tmp|\/home|(^|[^a-z])re_/,
    );
});

function newRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tbi-g1-verify-')));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

interface Rig {
  root: string;
  storeDir: string;
  stateDir: string;
  keyFile: string;
  clock: { t: number };
  w: SignupAdminWiring;
  sent: VerifyMailTo[];
  approvals: string[];
  submitted: string[];
  logs: string[];
  sendVerify: (to: VerifyMailTo) => Promise<void>;
}

async function rig(
  o: { web?: 'verified' | 'excluded' | null; verify?: boolean; verifySince?: number } = {},
): Promise<Rig> {
  const root = newRoot();
  const storeDir = join(root, 'p');
  const stateDir = join(root, 's');
  mkdirSync(stateDir, { mode: 0o700 });
  const keyFile = join(root, 'verify.key');
  writeFileSync(keyFile, `${KEY_HEX}\n`, { mode: 0o600 });
  const clock = { t: T0 };
  const r = {
    root,
    storeDir,
    stateDir,
    keyFile,
    clock,
    sent: [] as VerifyMailTo[],
    approvals: [] as string[],
    submitted: [] as string[],
    logs: [] as string[],
  } as Rig;
  r.sendVerify = async (to) => void r.sent.push(to);
  const email: EmailSender = {
    sendApproval: async (to) => void r.approvals.push(to.id),
    sendVerify: (to) => r.sendVerify(to),
  };
  const spool = {
    submit: async (_a: string, x: { email: string }) => {
      r.submitted.push(x.email);
      return 'spool1';
    },
    wait: async () => ({ ok: true }),
  } as unknown as AdminSpool;
  r.w = await wireSignupAdmin(
    {
      dir: storeDir,
      keyFile: join(root, 'resend.key'),
      from: 'x',
      labUrl: 'https://l.example.invalid/',
      quiet: null,
      ...(o.web === null
        ? {}
        : {
            autoApprove: {
              dailyCap: 5,
              stateDir,
              since: T0 - DAY,
              webSignups: o.web ?? 'verified',
            },
          }),
      ...(o.verify === false
        ? {}
        : { verify: { keyFile, stateDir, siteUrl: SITE, since: o.verifySince ?? T0 - DAY } }),
    },
    spool,
    {
      fetch: (async () => ({ ok: true, status: 200 })) as FetchLike,
      log: (l) => {
        r.logs.push(l);
        allLogs.push(l);
      },
      email,
      autoActor: () => 'p_ownerownerownerownerowner' as Principal,
      now: () => clock.t,
    },
  );
  // The first approving sweep resets the auto cut-off (DEC-11): only later requests count.
  if (r.w.auto) await r.w.auto.sweep();
  clock.t += 1000;
  return r;
}

const webRecord = async (r: Rig, i = 1, lang: 'he' | 'en' = 'en') =>
  (await r.w.store.createIfNew(person(i, lang), { origin: 'web' })).record.id;
const tokenOf = (m: VerifyMailTo) => m.link.split('#verify=')[1]!;
/** As the intake (slice 2) would: `<id>.vq-<sha256(token)[0:16]>` holding the token. */
function dropMarker(r: Rig, token: string, id = parseVerifyToken(token)?.id ?? ID): string {
  const name = `${id}.vq-${tokenHash(token).slice(0, 16)}`;
  writeFileSync(join(r.storeDir, name), token, { mode: 0o600 });
  return name;
}
const markers = (r: Rig) => readdirSync(r.storeDir).filter((f) => f.includes('.vq-'));
const recordText = (r: Rig, id: string) => readFileSync(join(r.storeDir, `${id}.json`), 'utf8');
const vstate = (r: Rig, id: string) =>
  JSON.parse(readFileSync(join(r.stateDir, VERIFY_DIR, `${id}.json`), 'utf8')) as {
    gens: { gen: number; hash: string }[];
    usedAt?: string;
    verifiedAt?: string;
  };
const rejectedLog = (r: Rig, cls: string) =>
  r.logs.some((l) => l.startsWith(`signup: verify rejected (${cls})`));

describe('token (verify.ts)', () => {
  const key = parseVerifyKey(KEY_HEX);
  const key2 = parseVerifyKey(KEY2_HEX);
  it('mints a token that checks; format v1.<id>.<gen>.<exp>.<nonce>.<mac>; no address', () => {
    const m = mintVerifyToken(key, { id: ID, gen: 2, now: T0, purpose: 'verify' });
    expect(m.token).toMatch(/^v1\.01JA{23}\.2\.\d{10}\.[\w-]{22}\.[\w-]{43}$/);
    expect(m.exp).toBe(T0 + DAY);
    expect(m.hash).toBe(createHash('sha256').update(m.token).digest('hex'));
    expect(checkVerifyToken([key], m.token, 'verify', T0)).toMatchObject({ id: ID, gen: 2 });
    expect(checkVerifyToken([key], m.token, 'verify', T0 + DAY)).toBeNull();
  });
  it('forged, other key, other purpose, wrong gen or bad syntax never check; .prev checks', () => {
    const m = mintVerifyToken(key, { id: ID, gen: 1, now: T0, purpose: 'verify' });
    const last = m.token.at(-1) === 'A' ? 'B' : 'A';
    expect(checkVerifyToken([key], m.token.slice(0, -1) + last, 'verify')).toBeNull();
    expect(checkVerifyToken([key2], m.token, 'verify')).toBeNull();
    expect(checkVerifyToken([key2, key], m.token, 'verify')).not.toBeNull();
    expect(checkVerifyToken([key], m.token, 'reset')).toBeNull();
    const reset = mintVerifyToken(key, { id: ID, gen: 1, now: T0, purpose: 'reset' });
    expect(checkVerifyToken([key], reset.token, 'verify')).toBeNull();
    expect(checkVerifyToken([key], m.token.replace('.1.', '.2.'), 'verify')).toBeNull();
    for (const bad of [`${m.token} `, `x${m.token}`, m.token.replace('v1', 'v2'), '', 'v1....'])
      expect(parseVerifyToken(bad)).toBeNull();
  });
  it('key: hex or base64url of >= 32 bytes only; missing/unsafe file = fixed classes', async () => {
    expect(parseVerifyKey(KEY_HEX)).toHaveLength(32);
    expect(parseVerifyKey(Buffer.alloc(32, 7).toString('base64url'))).toHaveLength(32);
    for (const bad of [
      '',
      randomBytes(31).toString('hex'),
      '!!'.repeat(32),
      'short',
      Buffer.alloc(31).toString('base64url'),
    ])
      expect(() => parseVerifyKey(bad)).toThrow('verify_key_bad');
    const root = newRoot();
    const f = join(root, 'k');
    await expect(loadVerifyKeys(f)).rejects.toThrow('verify_key_missing');
    writeFileSync(f, KEY_HEX, { mode: 0o604 });
    await expect(loadVerifyKeys(f)).rejects.toThrow('verify_key_bad');
    chmodSync(f, 0o600);
    expect((await loadVerifyKeys(f)).prev).toBeNull();
    writeFileSync(`${f}.prev`, KEY2_HEX, { mode: 0o600 });
    expect((await loadVerifyKeys(f)).prev).toHaveLength(32);
  });
  it('site URL: https origin only', () => {
    expect(parseSiteUrl('https://site.example.com')).toBe(SITE);
    expect(parseSiteUrl('https://site.example.com/')).toBe(SITE);
    for (const bad of [
      'http://site.example.com',
      'https://site.example.com/x',
      // userinfo built at runtime (no credential-looking URL literal in the public repo)
      `https://u${'\u003a'}p${'\u0040'}h.example`,
      'https://h.example/?a',
      undefined,
      '',
    ])
      expect(parseSiteUrl(bad)).toBeNull();
  });
});

describe('verify mail', () => {
  it('HE and EN: fixed text, the link, 24 h, ignore-if-not-you, company sign-off', () => {
    const he = verifyEmail('he', `${SITE}/he/signup/#verify=T`);
    expect(he.subject).toBe('אישור כתובת המייל ל-TBI Lab');
    expect(he.text).toContain(`${SITE}/he/signup/#verify=T`);
    expect(he.text).toContain('24 שעות');
    expect(he.text.trim().endsWith('צוות TBI Lab')).toBe(true);
    const en = verifyEmail('en', `${SITE}/en/signup/#verify=T`);
    expect(en.subject).toBe('Confirm your email for TBI Lab');
    expect(en.text).toContain('24 hours');
    expect(en.text).toMatch(/ignore this email/);
    expect(en.text.trim().endsWith('The TBI Lab team')).toBe(true);
    for (const t of [he.text, en.text]) expect(t).not.toMatch(/\bI\b|\bI'm\b|אני /);
  });
  it('carries no sign-up field: an attacker-chosen name never reaches the mail', async () => {
    const r = await rig();
    await r.w.store.createIfNew(
      { ...person(1, 'he'), name: 'https://evil.example/login' },
      { origin: 'web' },
    );
    await r.w.verifier!.sweep();
    expect(r.sent).toHaveLength(1);
    const m = r.sent[0]!;
    expect(m.lang).toBe('he');
    expect(m.link.startsWith(`${SITE}/he/signup/#verify=v1.`)).toBe(true);
    expect(JSON.stringify(m)).not.toContain('evil');
    expect(verifyEmail(m.lang, m.link).text).not.toContain('evil');
  });
});

describe('config (all default off)', () => {
  const store = '/srv/p';
  const on = {
    TBI_SIGNUP_VERIFY: '1',
    TBI_SIGNUP_VERIFY_KEY_FILE: '/run/creds/verify.key',
    TBI_SIGNUP_SITE_URL: SITE,
    TBI_SIGNUP_AUTO_STATE_DIR: '/srv/s',
  };
  it('unset = off silently; exactly 1 with every setting = on', () => {
    expect(verifyConfigFromEnv({}, store)).not.toHaveProperty('error');
    expect(verifyConfigFromEnv({ TBI_SIGNUP_VERIFY: '' }, store).enabled).toBe(false);
    expect(verifyConfigFromEnv(on, store)).toEqual({
      enabled: true,
      config: { keyFile: on.TBI_SIGNUP_VERIFY_KEY_FILE, stateDir: '/srv/s', siteUrl: SITE },
    });
    expect(
      autoApproveConfigFromEnv({
        TBI_SIGNUP_AUTO_APPROVE: '1',
        TBI_SIGNUP_AUTO_DAILY_CAP: '5',
        TBI_SIGNUP_AUTO_WEB: 'verified',
      }),
    ).toMatchObject({ webSignups: 'verified' });
  });
  it('refuses: no/equal state dir, shared or relative key, non-https site, AUTO_WEB=included', () => {
    const { TBI_SIGNUP_AUTO_STATE_DIR: _s, ...noState } = on;
    for (const env of [
      { ...on, TBI_SIGNUP_VERIFY: 'yes' },
      noState,
      { ...on, TBI_SIGNUP_AUTO_STATE_DIR: store },
      { ...on, TBI_SIGNUP_AUTO_STATE_DIR: '/srv/p/' },
      { ...on, TBI_SIGNUP_AUTO_STATE_DIR: '/srv/../srv/s' },
      { ...on, TBI_SIGNUP_VERIFY_KEY_FILE: 'verify.key' },
      { ...on, TBI_SIGNUP_HMAC_FILE: on.TBI_SIGNUP_VERIFY_KEY_FILE },
      { ...on, TBI_SIGNUP_SITE_URL: 'http://site.example.com' },
      { ...on, TBI_SIGNUP_AUTO_WEB: 'included' },
      { ...on, TBI_SIGNUP_VERIFY_SINCE: 'yesterday' },
    ])
      expect(verifyConfigFromEnv(env, store)).toMatchObject({ enabled: false, error: true });
  });
});

describe('flags off: behaviour and record bytes unchanged', () => {
  it('auto-approve on, all three verify flags unset: no verifier, no key read, nothing written', async () => {
    const root = newRoot();
    const sd = join(root, 's');
    mkdirSync(sd, { mode: 0o700 });
    const logs: string[] = [];
    let verifyCalls = 0;
    const env = {
      TBI_SIGNUP_ADMIN: '1',
      TBI_SIGNUP_DIR: join(root, 'p'),
      TBI_SIGNUP_RESEND_KEY_FILE: join(root, 'key'),
      TBI_SIGNUP_FROM: 'x',
      TBI_SIGNUP_LAB_URL: 'https://l.example.invalid/',
      TBI_SIGNUP_QUIET: 'off',
      TBI_SIGNUP_AUTO_APPROVE: '1',
      TBI_SIGNUP_AUTO_DAILY_CAP: '5',
      TBI_SIGNUP_AUTO_STATE_DIR: sd,
    };
    const w = await signupWiringFromEnv(env, {} as AdminSpool, {
      fetch: (async () => ({ ok: true, status: 200 })) as FetchLike,
      log: (l) => {
        logs.push(l);
        allLogs.push(l);
      },
      email: { sendApproval: async () => undefined, sendVerify: async () => void verifyCalls++ },
      autoActor: () => null,
    });
    expect(w!.verifier).toBeNull();
    const id = (await w!.store.createIfNew(person(1), { origin: 'web' })).record.id;
    const before = recordText({ storeDir: join(root, 'p') } as Rig, id);
    const files = readdirSync(join(root, 'p')).sort();
    await w!.startAutoApprove()();
    expect(recordText({ storeDir: join(root, 'p') } as Rig, id)).toBe(before);
    expect(readdirSync(join(root, 'p')).sort()).toEqual(files);
    expect(existsSync(join(sd, VERIFY_DIR))).toBe(false);
    expect(verifyCalls).toBe(0);
    expect(before).not.toMatch(/verif/);
    expect(logs.filter((l) => /verif/.test(l))).toEqual([]);
  });
  it('from env: verify on wires a verifier; a bad verify setting = one log line, verifier off', async () => {
    const root = newRoot();
    const sd = join(root, 's');
    mkdirSync(sd, { mode: 0o700 });
    const logs: string[] = [];
    const base = {
      TBI_SIGNUP_ADMIN: '1',
      TBI_SIGNUP_DIR: join(root, 'p'),
      TBI_SIGNUP_RESEND_KEY_FILE: join(root, 'key'),
      TBI_SIGNUP_FROM: 'x',
      TBI_SIGNUP_LAB_URL: 'https://l.example.invalid/',
      TBI_SIGNUP_QUIET: 'off',
      TBI_SIGNUP_AUTO_APPROVE: '1',
      TBI_SIGNUP_AUTO_DAILY_CAP: '5',
      TBI_SIGNUP_AUTO_STATE_DIR: sd,
      TBI_SIGNUP_AUTO_WEB: 'verified',
      TBI_SIGNUP_VERIFY: '1',
      TBI_SIGNUP_VERIFY_KEY_FILE: join(root, 'verify.key'),
      TBI_SIGNUP_SITE_URL: SITE,
    };
    const io = {
      fetch: (async () => ({ ok: true, status: 200 })) as FetchLike,
      log: (l: string) => {
        logs.push(l);
        allLogs.push(l);
      },
      email: { sendApproval: async () => undefined, sendVerify: async () => undefined },
      autoActor: () => null,
    };
    const on = await signupWiringFromEnv(base, {} as AdminSpool, io);
    expect(on!.verifier).not.toBeNull();
    expect(on!.auto).not.toBeNull();
    const off = await signupWiringFromEnv(
      { ...base, TBI_SIGNUP_SITE_URL: 'http://site.example.com' },
      {} as AdminSpool,
      io,
    );
    expect(off!.verifier).toBeNull();
    expect(logs.filter((l) => /verification off/.test(l))).toEqual([
      'signup: email verification off (config: TBI_SIGNUP_SITE_URL must be an https origin)',
    ]);
  });
  it('AUTO_WEB=verified without TBI_SIGNUP_VERIFY never approves anyone (any origin)', async () => {
    const r = await rig({ verify: false });
    await webRecord(r, 1);
    await r.w.store.createIfNew(person(2)); // Apps Script shape: no origin
    expect(await r.w.auto!.sweep()).toMatchObject({ claimed: 0 });
    expect(r.submitted).toEqual([]);
    expect(r.w.verifier).toBeNull();
  });
  it('TBI_SIGNUP_VERIFY=1 with AUTO_WEB=excluded: mail + confirmation recorded, never approved', async () => {
    const r = await rig({ web: 'excluded' });
    const id = await webRecord(r);
    await r.w.verifier!.sweep();
    dropMarker(r, tokenOf(r.sent[0]!));
    expect(await r.w.verifier!.sweep()).toMatchObject({ verified: 1 });
    expect(await r.w.auto!.sweep()).toMatchObject({ claimed: 0 });
    expect(r.submitted).toEqual([]);
    expect(JSON.parse(recordText(r, id))).toMatchObject({
      status: 'pending',
      verifiedAt: expect.any(String),
    });
  });
});

describe('end to end: mint, mail, marker, consume, approve with the bound address', () => {
  it('only the hash is stored; the confirmed address goes to the spool; logs are counts', async () => {
    const r = await rig();
    const id = await webRecord(r, 7);
    expect(await r.w.verifier!.sweep()).toMatchObject({ sent: 1 });
    const token = tokenOf(r.sent[0]!);
    expect(r.sent[0]).toMatchObject({ id, gen: 1, lang: 'en', email: 'tester7@example.com' });
    const stFile = join(r.stateDir, VERIFY_DIR, `${id}.json`);
    expect(statSync(stFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(stFile, 'utf8')).not.toContain(token);
    expect(vstate(r, id).gens[0]!.hash).toBe(tokenHash(token));
    expect(JSON.parse(recordText(r, id)).verifySentAt).toBeDefined();
    // Not confirmed yet: nothing approved; a second sweep sends no second mail.
    expect(await r.w.auto!.sweep()).toMatchObject({ claimed: 0 });
    await r.w.verifier!.sweep();
    expect(r.sent).toHaveLength(1);
    r.clock.t += 60_000;
    dropMarker(r, token);
    expect(await r.w.verifier!.sweep()).toMatchObject({ verified: 1 });
    expect(markers(r)).toEqual([]);
    expect(vstate(r, id)).toMatchObject({
      usedAt: expect.any(String),
      verifiedAt: expect.any(String),
    });
    expect(await r.w.auto!.sweep()).toMatchObject({ claimed: 1 });
    expect(r.submitted).toEqual(['tester7@example.com']);
    expect(r.approvals).toEqual([id]);
    expect(r.logs).toContain('signup: verify sent 1');
    expect(r.logs).toContain('signup: verify ok 1');
  });
  it('the timer runs the verify step before the auto-approve sweep', async () => {
    const r = await rig();
    await webRecord(r);
    await r.w.startAutoApprove()();
    expect(r.sent).toHaveLength(1);
    expect(r.logs).toContain('signup: email verification on');
  });
});

describe('compromised intake (req 15)', () => {
  async function minted(r: Rig, i = 1) {
    const id = await webRecord(r, i);
    await r.w.verifier!.sweep();
    return { id, token: tokenOf(r.sent.at(-1)!) };
  }
  const notVerified = async (r: Rig, id: string) => {
    await r.w.auto!.sweep();
    expect(r.submitted).toEqual([]);
    expect(JSON.parse(recordText(r, id)).verifiedAt).toBeUndefined();
  };

  it('forged MAC', async () => {
    const r = await rig();
    const { id, token } = await minted(r);
    const forged = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    dropMarker(r, forged);
    expect(await r.w.verifier!.sweep()).toMatchObject({ verified: 0, rejected: 1 });
    expect(rejectedLog(r, 'bad_mac')).toBe(true);
    expect(markers(r)).toEqual([]);
    await notVerified(r, id);
  });
  it("a valid token of A under B's marker name", async () => {
    const r = await rig();
    const a = await minted(r, 1);
    const b = await minted(r, 2);
    dropMarker(r, a.token, b.id);
    await r.w.verifier!.sweep();
    expect(rejectedLog(r, 'id_mismatch')).toBe(true);
    await notVerified(r, b.id);
    await notVerified(r, a.id);
  });
  it('symlink, FIFO, hard-linked, oversized and wrong-suffix markers are refused', async () => {
    const r = await rig();
    const { id, token } = await minted(r);
    const real = join(r.root, 'outside');
    writeFileSync(real, token);
    const h = tokenHash(token).slice(0, 16);
    symlinkSync(real, join(r.storeDir, `${id}.vq-${h}`));
    expect(await r.w.verifier!.sweep()).toMatchObject({ verified: 0, rejected: 1 });
    expect(existsSync(real)).toBe(true);
    execFileSync('mkfifo', [join(r.storeDir, `${id}.vq-${h}`)]);
    expect(await r.w.verifier!.sweep()).toMatchObject({ verified: 0, rejected: 1 });
    linkSync(real, join(r.storeDir, `${id}.vq-${h}`));
    expect(await r.w.verifier!.sweep()).toMatchObject({ verified: 0, rejected: 1 });
    writeFileSync(join(r.storeDir, `${id}.vq-${h}`), token + ' '.repeat(1100));
    expect(await r.w.verifier!.sweep()).toMatchObject({ verified: 0, rejected: 1 });
    writeFileSync(join(r.storeDir, `${id}.vq-${'0'.repeat(16)}`), token);
    expect(await r.w.verifier!.sweep()).toMatchObject({ verified: 0, rejected: 1 });
    expect(r.logs.filter((l) => l.startsWith('signup: verify rejected (bad_marker)'))).toHaveLength(
      5,
    );
    expect(markers(r)).toEqual([]);
    await notVerified(r, id);
  });
  it('10k markers: at most 200 per sweep, and a real one still gets through', async () => {
    const r = await rig();
    const { id, token } = await minted(r);
    for (let i = 0; i < 10_000; i++)
      writeFileSync(join(r.storeDir, `${id}.vq-${i.toString(16).padStart(16, '0')}`), 'junk');
    const started = performance.now();
    const out = await r.w.verifier!.sweep();
    expect(out.rejected).toBe(VERIFY_MARKERS_PER_SWEEP);
    expect(performance.now() - started).toBeLessThan(20_000);
    expect(markers(r)).toHaveLength(10_000 - VERIFY_MARKERS_PER_SWEEP);
    for (const f of markers(r)) rmSync(join(r.storeDir, f));
    dropMarker(r, token);
    expect(await r.w.verifier!.sweep()).toMatchObject({ verified: 1 });
    expect(vstate(r, id).verifiedAt).toBeDefined();
  }, 60_000);
  it('email changed after the mail or after the confirmation: never approved', async () => {
    const r = await rig();
    const a = await minted(r, 1);
    const rewrite = (id: string, email: string) => {
      const rec = JSON.parse(recordText(r, id));
      writeFileSync(join(r.storeDir, `${id}.json`), JSON.stringify({ ...rec, email }));
    };
    rewrite(a.id, 'victim@example.org');
    dropMarker(r, a.token);
    await r.w.verifier!.sweep();
    expect(rejectedLog(r, 'addr_changed')).toBe(true);
    await notVerified(r, a.id);
    const b = await minted(r, 2);
    dropMarker(r, b.token);
    expect(await r.w.verifier!.sweep()).toMatchObject({ verified: 1 });
    rewrite(b.id, 'victim@example.org');
    expect(await r.w.auto!.sweep()).toMatchObject({ claimed: 0 });
    expect(r.submitted).toEqual([]);
    expect(r.logs).toContain('signup: verify rejected (addr_changed)');
    // Case only (same normalised address) is the same account: still allowed.
    rewrite(b.id, 'TESTER2@example.com');
    expect(await r.w.auto!.sweep()).toMatchObject({ claimed: 1 });
    expect(r.submitted).toEqual(['TESTER2@example.com']);
  });
  it('email changed between the claim and the account request: the spool gets nothing', async () => {
    const r = await rig();
    const { id, token } = await minted(r);
    dropMarker(r, token);
    await r.w.verifier!.sweep();
    const update = r.w.store.update.bind(r.w.store);
    r.w.store.update = async (i, patch) => {
      const out = await update(i, patch);
      if (patch.autoApprovedAt) {
        const rec = JSON.parse(recordText(r, i));
        writeFileSync(
          join(r.storeDir, `${i}.json`),
          JSON.stringify({ ...rec, email: 'victim@example.org' }),
        );
      }
      return out;
    };
    await r.w.auto!.sweep();
    expect(r.submitted).toEqual([]);
    expect(JSON.parse(recordText(r, id))).toMatchObject({ status: 'pending', lastError: 'error' });
    expect(r.logs).toContain(
      'signup: auto-approve account request refused (not verified for this address)',
    );
  });
  it('origin removed: an unverified record is never eligible in verified mode', async () => {
    const r = await rig();
    const id = (await r.w.store.createIfNew(person(1))).record.id; // no origin field at all
    await r.w.verifier!.sweep();
    expect(r.sent).toEqual([]); // only web requests are mailed
    await notVerified(r, id);
  });
  it('replay after usedAt, and an older generation after a newer one was used', async () => {
    const r = await rig({ web: 'excluded' });
    const { id, token } = await minted(r);
    r.clock.t += 11 * 60_000;
    expect(await r.w.verifier!.mint(id, await loadVerifyKeys(r.keyFile), true)).toBe('sent');
    const token2 = tokenOf(r.sent.at(-1)!);
    expect(vstate(r, id).gens.map((g) => g.gen)).toEqual([1, 2]);
    dropMarker(r, token2);
    expect(await r.w.verifier!.sweep()).toMatchObject({ verified: 1 });
    dropMarker(r, token2);
    dropMarker(r, token);
    expect(await r.w.verifier!.sweep()).toMatchObject({ verified: 0, rejected: 2 });
    expect(r.logs).toContain('signup: verify rejected (replay) 2');
  });
  it('generation rule (req 6): gen is in token and MAC; an older live generation works until any is used', async () => {
    const r = await rig({ web: 'excluded' });
    const { id, token } = await minted(r);
    r.clock.t += 11 * 60_000;
    expect(await r.w.verifier!.mint(id, await loadVerifyKeys(r.keyFile), true)).toBe('sent');
    const token2 = tokenOf(r.sent.at(-1)!);
    // gen 1's token relabelled as gen 2: the MAC covers gen, so it never checks.
    const p = parseVerifyToken(token)!;
    const relabelled = token.replace(`.${p.gen}.`, '.2.');
    dropMarker(r, relabelled, id);
    expect(await r.w.verifier!.sweep()).toMatchObject({ verified: 0, rejected: 1 });
    expect(rejectedLog(r, 'bad_mac')).toBe(true);
    // The older, still unexpired generation is not superseded by the newer mail.
    dropMarker(r, token);
    expect(await r.w.verifier!.sweep()).toMatchObject({ verified: 1 });
    // After one use every generation is dead.
    dropMarker(r, token2);
    expect(await r.w.verifier!.sweep()).toMatchObject({ verified: 0, rejected: 1 });
    expect(rejectedLog(r, 'replay')).toBe(true);
  });
  it('expired by the admin clock while still "valid" for a skewed intake', async () => {
    const r = await rig();
    const { id, token } = await minted(r);
    r.clock.t += DAY + 1000;
    dropMarker(r, token);
    await r.w.verifier!.sweep();
    expect(rejectedLog(r, 'expired')).toBe(true);
    await notVerified(r, id);
  });
  it('pause: nothing minted while paused, and a pause during a sweep stops the next send', async () => {
    const r = await rig();
    writeFileSync(join(r.stateDir, AUTO_PAUSE_FILE), '');
    await webRecord(r, 1);
    await webRecord(r, 2);
    await r.w.verifier!.sweep();
    expect(r.sent).toEqual([]);
    expect(existsSync(join(r.stateDir, VERIFY_DIR, 'mail-counters.json'))).toBe(false);
    rmSync(join(r.stateDir, AUTO_PAUSE_FILE));
    r.sendVerify = async (to) => {
      r.sent.push(to);
      writeFileSync(join(r.stateDir, AUTO_PAUSE_FILE), '');
    };
    await r.w.verifier!.sweep();
    expect(r.sent).toHaveLength(1);
  });
  it('state dir equal to the store dir: refused at config and at sweep time', async () => {
    const root = newRoot();
    const store = new PendingStore(join(root, 'p'));
    await store.init();
    const v = new Verifier({
      stateDir: join(root, 'p'),
      storeDir: join(root, 'p'),
      store,
      email: { sendApproval: async () => undefined, sendVerify: async () => undefined },
      siteUrl: SITE,
      keys: () => loadVerifyKeys(join(root, 'none')),
      log: (l) => allLogs.push(l),
    });
    expect(await v.sweep()).toMatchObject({ stopped: 'state_dir_unsafe' });
    expect(existsSync(join(root, 'p', VERIFY_DIR))).toBe(false);
  });
  it('reject racing a consume: the rejected request is never verified', async () => {
    const r = await rig();
    const { id, token } = await minted(r);
    dropMarker(r, token);
    const consumed = r.w.verifier!.sweep();
    await r.w.signups.approver('p_ownerownerownerownerowner' as Principal).reject(id);
    await consumed;
    const rec = JSON.parse(recordText(r, id));
    // Whoever held the per-id lock first wins; either way the request ends rejected, no account.
    expect(rec.status).toBe('rejected');
    await r.w.auto!.sweep();
    expect(r.submitted).toEqual([]);
  });
});

describe('limits, persistence and cleanup (req 8, 9, 11, 14)', () => {
  it('per address 3 per 7 days, 10 min apart; a crash after persist never sends twice', async () => {
    const r = await rig({ web: 'excluded' });
    const keys = await loadVerifyKeys(r.keyFile);
    r.sendVerify = async () => {
      throw new Error('network');
    };
    const id = await webRecord(r);
    await r.w.verifier!.sweep();
    expect(vstate(r, id).gens).toHaveLength(1); // persisted before the (failed) send
    expect(r.logs).toContain('signup: verify send failed (network)');
    r.sendVerify = async (to) => void r.sent.push(to);
    await r.w.verifier!.sweep();
    expect(r.sent).toEqual([]); // no automatic second mail
    expect(await r.w.verifier!.mint(id, keys, true)).toBe('limit_gap');
    r.clock.t += 11 * 60_000;
    expect(await r.w.verifier!.mint(id, keys, true)).toBe('sent');
    r.clock.t += 11 * 60_000;
    expect(await r.w.verifier!.mint(id, keys, true)).toBe('sent');
    r.clock.t += 11 * 60_000;
    expect(await r.w.verifier!.mint(id, keys, true)).toBe('limit_live');
    // The same normalised address on another request: 3 per address per 7 days.
    await r.w.store.createIfNew({ ...person(1), email: 'TESTER1@example.com' }, { origin: 'web' });
    await r.w.verifier!.sweep();
    expect(r.logs).toContain('signup: verify not sent (limit_address) 1');
    r.clock.t += 7 * DAY;
    expect(await r.w.verifier!.mint(id, keys, true)).toBe('sent');
    r.clock.t += 11 * 60_000;
    expect(await r.w.verifier!.mint(id, keys, true)).toBe('sent');
    r.clock.t += 11 * 60_000;
    expect(await r.w.verifier!.mint(id, keys, true)).toBe('limit_record'); // 5 per request
  });
  it(`at most ${VERIFY_MAX_PER_DAY} verify mails per Israel day; an unreadable counter = none`, async () => {
    const r = await rig({ web: 'excluded' });
    for (let i = 0; i < VERIFY_MAX_PER_DAY + 2; i++) await webRecord(r, i);
    await r.w.verifier!.sweep();
    expect(r.sent).toHaveLength(VERIFY_MAX_PER_DAY);
    expect(r.logs).toContain('signup: verify not sent (limit_day) 2');
    r.clock.t += DAY;
    writeFileSync(join(r.stateDir, VERIFY_DIR, 'mail-counters.json'), '{corrupt');
    await r.w.verifier!.sweep();
    expect(r.sent).toHaveLength(VERIFY_MAX_PER_DAY);
    expect(r.logs).toContain('signup: verify not sent (limit_unreadable) 2');
  });
  it('switch-on cut-off: the pending backlog is never mailed', async () => {
    const r = await rig();
    // No TBI_SIGNUP_VERIFY_SINCE: the first enable persists "now" as the cut-off.
    const v = new Verifier({
      stateDir: r.stateDir,
      storeDir: r.storeDir,
      store: r.w.store,
      email: { sendApproval: async () => undefined, sendVerify: (t) => r.sendVerify(t) },
      siteUrl: SITE,
      keys: () => loadVerifyKeys(r.keyFile),
      now: () => r.clock.t,
      log: (l) => allLogs.push(l),
    });
    await webRecord(r, 1); // backlog, created before the first enable
    r.clock.t += 1000;
    await v.sweep();
    expect(r.sent).toEqual([]);
    r.clock.t += 1000;
    await webRecord(r, 2);
    await v.sweep();
    expect(r.sent.map((m) => m.email)).toEqual(['tester2@example.com']);
  });
  it('key missing or bad: nothing minted or verified, one log line', async () => {
    const r = await rig();
    rmSync(r.keyFile);
    await webRecord(r);
    expect(await r.w.verifier!.sweep()).toMatchObject({ stopped: 'key_unusable' });
    expect(await r.w.verifier!.sweep()).toMatchObject({ stopped: 'key_unusable' });
    expect(r.sent).toEqual([]);
    expect(r.logs.filter((l) => /verify key unusable/.test(l))).toEqual([
      'signup: verify key unusable (verify_key_missing); verification off',
    ]);
  });
  it('owner delete and retention purge remove the verify state and the markers', async () => {
    const r = await rig();
    const a = await webRecord(r, 1);
    const b = await webRecord(r, 2);
    await r.w.verifier!.sweep();
    dropMarker(r, tokenOf(r.sent[0]!));
    dropMarker(r, tokenOf(r.sent[1]!));
    expect(await r.w.store.deleteNow(a)).toBe('deleted');
    expect(existsSync(join(r.stateDir, VERIFY_DIR, `${a}.json`))).toBe(false);
    expect(markers(r).some((f) => f.startsWith(a))).toBe(false);
    r.clock.t += 91 * DAY;
    expect(await r.w.store.purge()).toEqual([b]);
    expect(existsSync(join(r.stateDir, VERIFY_DIR, `${b}.json`))).toBe(false);
    expect(markers(r)).toEqual([]);
  });
});
