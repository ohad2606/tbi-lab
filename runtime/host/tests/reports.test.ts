/**
 * Sprint 14: in-app problem reports in the Session Host, adversarial. Users reach the host through
 * test gates (the deployment's oauth2-proxy role); the store writes to a private temporary
 * directory. Covers identity, cross-user isolation, input limits, rate limits, durable storage
 * and its failures, retention, the operator CLI and the notification line.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_IDENTITY, principalFor, startTestGate } from '../../identity/test-gate.js';
import type { SessionHost } from '../host.js';
import { createHttpServer } from '../http.js';
import {
  MAX_DESCRIPTION_CHARS,
  MAX_REPORT_BYTES,
  REPORT_ID_RE,
  browserOf,
  cleanDescription,
  validateReport,
} from '../reportProtocol.js';
import {
  DEFAULT_REPORTS,
  ReportStore,
  reportsConfigFromEnv,
  type ReportIo,
  type ReportsConfig,
  type StoredReport,
} from '../reports.js';
import { createRequest, fakeHost } from './support.js';

const A = principalFor('user-a');
const CLI = fileURLToPath(new URL('../../../scripts/problem-reports.mjs', import.meta.url));
const CHROME_UA =
  'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.54 Safari/537.36';

let shared: { host: SessionHost; art: { sha256: string } };
beforeAll(() => {
  shared = fakeHost('normal');
});
afterAll(async () => {
  await shared.host.shutdown();
});

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'tbi-reports-test-'));
  cleanup.push(() => {
    chmodSync(d, 0o700);
    rmSync(d, { recursive: true, force: true });
  });
  return d;
}

interface Setup {
  dir: string;
  lines: string[];
  store: ReportStore | null;
  /** Gate bases by subject (null: no identity asserted). */
  gate: (subject: string | null) => Promise<string>;
}

async function serve(
  opts: {
    enabled?: boolean;
    config?: Partial<ReportsConfig>;
    io?: ReportIo;
    log?: (line: string) => void;
    now?: () => number;
  } = {},
): Promise<Setup> {
  const dir = join(tempDir(), 'reports'); // created by the store on first use
  const lines: string[] = [];
  const store =
    opts.enabled === false
      ? null
      : new ReportStore(
          { ...DEFAULT_REPORTS, dir, ...opts.config },
          {
            ...(opts.io ? { io: opts.io } : {}),
            log: opts.log ?? ((l) => void lines.push(l)),
            ...(opts.now ? { now: opts.now } : {}),
          },
        );
  const server: Server = createHttpServer(shared.host, TEST_IDENTITY, store);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const target = { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
  return {
    dir,
    lines,
    store,
    gate: async (subject) => {
      const g = await startTestGate(target, TEST_IDENTITY, subject);
      cleanup.push(g.close);
      return g.base;
    },
  };
}

const valid = (over: Record<string, unknown> = {}) => ({
  description: 'The LED stays off after Run.',
  category: 'simulation',
  blocking: false,
  locale: 'en',
  view: 'editor',
  ...over,
});

async function report(
  base: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(`${base}/reports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': CHROME_UA, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {}, headers: res.headers };
}

const files = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);
const stored = (dir: string, id: string) =>
  JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as StoredReport;

describe('POST /reports: identity and acceptance', () => {
  it('401 without a gate identity; nothing is stored', async () => {
    const s = await serve();
    const r = await report(await s.gate(null), valid());
    expect(r.status).toBe(401);
    expect(files(s.dir)).toEqual([]);
  });

  it('503 when the deployment has not enabled reports (TBI_REPORTS_DIR unset)', async () => {
    const s = await serve({ enabled: false });
    const r = await report(await s.gate('user-a'), valid());
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'reports_disabled' });
    expect(existsSync(s.dir)).toBe(false);
    expect(reportsConfigFromEnv({})).toBeNull();
    expect(reportsConfigFromEnv({ TBI_REPORTS_DIR: '' })).toBeNull();
  });

  it('201 { id } only with a durable 0600 file in a 0700 directory; host-side facts recorded', async () => {
    const s = await serve();
    const r = await report(
      await s.gate('user-a'),
      valid({
        app: { version: '0.14.0-alpha.1', commit: 'a'.repeat(40) },
        sim: { status: 'failed', code: 'runtime_crashed' },
      }),
    );
    expect(r.status).toBe(201);
    expect(Object.keys(r.body)).toEqual(['id']);
    const id = r.body.id as string;
    expect(id).toMatch(REPORT_ID_RE);
    expect(files(s.dir)).toEqual([`${id}.json`]);
    expect(statSync(s.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(s.dir, `${id}.json`)).mode & 0o777).toBe(0o600);
    const rec = stored(s.dir, id);
    expect(rec).toMatchObject({
      v: 1,
      id,
      principal: A,
      category: 'simulation',
      blocking: false,
      description: 'The LED stays off after Run.',
      locale: 'en',
      view: 'editor',
      app: { version: '0.14.0-alpha.1', commit: 'a'.repeat(40) },
      browser: { family: 'Chrome', major: 141, os: 'Linux' },
      session: null,
      appSim: { status: 'failed', code: 'runtime_crashed' },
    });
    expect(Math.abs(Date.parse(rec.receivedAt) - Date.now())).toBeLessThan(10_000);
    // The full User-Agent is never kept.
    expect(readFileSync(join(s.dir, `${id}.json`), 'utf8')).not.toContain('AppleWebKit');
  });

  it('one notification line per accepted report, without the description or identity', async () => {
    const s = await serve();
    const r = await report(await s.gate('user-a'), valid({ description: 'secret words here' }));
    expect(r.status).toBe(201);
    const notes = s.lines.filter((l) => l.includes('"problem_report"'));
    expect(notes).toHaveLength(1);
    const n = JSON.parse(notes[0]!) as Record<string, unknown>;
    expect(n).toMatchObject({
      event: 'problem_report',
      v: 1,
      id: r.body.id,
      category: 'simulation',
    });
    expect(Object.keys(n).sort()).toEqual(
      ['app', 'at', 'blocking', 'category', 'event', 'id', 'release', 'v'].sort(),
    );
    expect(notes[0]).not.toContain('secret');
    expect(notes[0]).not.toContain(A.slice(0, 10));
  });

  it('a failing log writer (the alerter path down) never prevents acceptance', async () => {
    const s = await serve({
      log: () => {
        throw new Error('journald unavailable');
      },
    });
    const r = await report(await s.gate('user-a'), valid());
    expect(r.status).toBe(201);
    expect(files(s.dir)).toEqual([`${r.body.id as string}.json`]);
  });
});

describe('forged identifiers', () => {
  it('body fields naming an identity, owner or diagnostics are refused', async () => {
    const s = await serve();
    const base = await s.gate('user-a');
    for (const field of ['principal', 'who', 'owner', 'user', 'email', 'session', 'release']) {
      const r = await report(base, valid({ [field]: 'p_' + 'b'.repeat(26) }));
      expect(r.status, field).toBe(400);
      expect(r.body.error).toBe('unknown field');
    }
    expect(
      (await report(base, valid({ app: { version: '1', commit: 'a'.repeat(40), who: 'x' } })))
        .status,
    ).toBe(400);
    expect((await report(base, valid({ sim: { status: 'failed', detail: 'x' } }))).status).toBe(
      400,
    );
    expect(files(s.dir)).toEqual([]);
  });

  it('spoofed identity headers do not change who reported', async () => {
    const s = await serve();
    const r = await report(await s.gate('user-a'), valid(), {
      'x-forwarded-user': 'user-b',
      'x-tbi-principal': principalFor('user-b'),
      'x-forwarded-email': 'b@example.com',
    });
    expect(r.status).toBe(201);
    expect(stored(s.dir, r.body.id as string).principal).toBe(A);
  });
});

describe('session association', () => {
  it('only the owner’s own session is associated; otherwise none, with an identical answer', async () => {
    const s = await serve();
    const a = await s.gate('user-a');
    const b = await s.gate('user-b');
    const created = await fetch(`${a}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createRequest(shared.art.sha256)),
    });
    expect(created.status).toBe(201);
    const { sessionId } = (await created.json()) as { sessionId: string };

    const own = await report(a, valid({ sessionId }));
    const foreign = await report(b, valid({ sessionId }));
    const unknown = await report(b, valid({ sessionId: '0'.repeat(32) }));
    for (const r of [own, foreign, unknown]) {
      expect(r.status).toBe(201);
      expect(Object.keys(r.body)).toEqual(['id']);
      expect(r.headers.get('content-type')).toBe(own.headers.get('content-type'));
      expect(r.headers.get('content-length')).toBe(own.headers.get('content-length'));
    }
    const mine = stored(s.dir, own.body.id as string);
    expect(mine.session).toMatchObject({ id: sessionId, state: 'ready', reason: null });
    expect(mine.session!.ageS).toBeGreaterThanOrEqual(0);
    expect(mine.session!.endedAgoS).toBeNull();
    expect(stored(s.dir, foreign.body.id as string).session).toBeNull();
    expect(stored(s.dir, unknown.body.id as string).session).toBeNull();
    // A's session is untouched.
    expect(shared.host.statusFor(sessionId, A)?.state).toBe('ready');
    expect(shared.host.statusFor(sessionId, principalFor('user-b'))).toBeNull();
  });
});

describe('input limits', () => {
  it('413 above 8 KiB, 415 without JSON, 400 for malformed JSON or invalid fields', async () => {
    const s = await serve();
    const base = await s.gate('user-a');
    const big = JSON.stringify(valid({ description: 'x'.repeat(MAX_REPORT_BYTES) }));
    expect((await report(base, big)).status).toBe(413);
    expect((await report(base, valid(), { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await report(base, '{"description":')).status).toBe(400);
    expect((await report(base, '[]')).status).toBe(400);
    for (const bad of [
      { category: 'hardware' },
      { blocking: 'yes' },
      { locale: 'en_US; drop' },
      { view: 'settings' },
      { description: 42 },
      { description: '   \n\t ' },
      { app: { version: '1.0', commit: 'XYZ' } },
      { sessionId: '../../etc/passwd' },
      { sim: { status: 'exploded' } },
      { sim: { status: 'failed', code: 'Bad Code' } },
    ]) {
      const r = await report(base, valid(bad));
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect(files(s.dir)).toEqual([]);
  });

  it('the description is capped at 1000 code points, after normalization', async () => {
    const s = await serve();
    const base = await s.gate('user-a');
    // Astral characters count once each (two UTF-16 units, four UTF-8 bytes).
    const emoji = '🔌'.repeat(MAX_DESCRIPTION_CHARS);
    expect((await report(base, valid({ description: emoji }))).status).toBe(201);
    const over = await report(base, valid({ description: 'א'.repeat(MAX_DESCRIPTION_CHARS + 1) }));
    expect(over.status).toBe(400);
    expect(over.body.error).toBe('description too long');
    // Combining sequences that compose under NFC count as one.
    const composed = await report(base, valid({ description: 'é'.repeat(MAX_DESCRIPTION_CHARS) }));
    expect(composed.status).toBe(201);
  });

  it('control characters are stripped (tab and newline kept); text is otherwise kept as written', async () => {
    const s = await serve();
    const raw = '\u0000Run\u0007 fails\r\nשורה\tשנייה\u001b[31m red\u0085 é\uD800';
    const r = await report(await s.gate('user-a'), valid({ description: raw }));
    expect(r.status).toBe(201);
    expect(stored(s.dir, r.body.id as string).description).toBe(
      'Run fails\nשורה\tשנייה[31m red é�',
    );
    expect(cleanDescription('  a\r\rb  ')).toBe('a\n\nb');
  });
});

describe('rate limits', () => {
  it('5 per 10 minutes per user: then 429 with Retry-After, and no file', async () => {
    let now = Date.parse('2026-10-15T10:00:00Z');
    const s = await serve({ now: () => now });
    const a = await s.gate('user-a');
    for (let i = 0; i < 5; i++) expect((await report(a, valid())).status).toBe(201);
    const refused = await report(a, valid());
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ error: 'rate_limited', retryAfterS: 600 });
    expect(refused.headers.get('retry-after')).toBe('600');
    expect(files(s.dir)).toHaveLength(5);
    // Another user is unaffected.
    expect((await report(await s.gate('user-b'), valid())).status).toBe(201);
    now += 10 * 60_000 + 1;
    expect((await report(a, valid())).status).toBe(201);
  });

  it('20 per day per user, and a global cap across users', async () => {
    let now = Date.parse('2026-10-15T00:00:00Z');
    const s = await serve({
      now: () => now,
      config: { global: { count: 10, windowMs: 3600_000 } },
    });
    const a = await s.gate('user-a');
    for (let i = 0; i < 20; i++) {
      expect((await report(a, valid())).status).toBe(201);
      now += 11 * 60_000; // never the 10-minute limit
    }
    const daily = await report(a, valid());
    expect(daily.status).toBe(429);
    expect(Number(daily.headers.get('retry-after'))).toBeGreaterThan(3600);
    expect(files(s.dir)).toHaveLength(20);
    // Global: 10 per hour in this configuration; the last hour holds 5 of A's reports (the
    // refused one is not counted), so B fills it and C is refused although C sent nothing yet.
    const b = await s.gate('user-b');
    for (let i = 0; i < 5; i++) expect((await report(b, valid())).status).toBe(201);
    const c = await report(await s.gate('user-c'), valid());
    expect(c.status).toBe(429);
    expect(Number(c.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(files(s.dir)).toHaveLength(25);
  });
});

describe('storage', () => {
  it('an unwritable directory is 503 (never 201) and leaves nothing', async () => {
    const s = await serve();
    const base = await s.gate('user-a');
    expect((await report(base, valid())).status).toBe(201); // creates the directory
    chmodSync(s.dir, 0o500);
    const r = await report(base, valid());
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'storage_pressure' });
    expect(files(s.dir)).toHaveLength(1);
    chmodSync(s.dir, 0o700);
    expect(s.lines.some((l) => l.includes('storage error: EACCES'))).toBe(true);
  });

  it('a failing file fsync or directory fsync is 503 with no partial or temporary file', async () => {
    for (const io of [
      {
        syncFile: () => Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })),
        syncDir: () => Promise.resolve(),
      },
      {
        syncFile: (fh: { sync(): Promise<void> }) => fh.sync(),
        syncDir: () => Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })),
      },
    ] as ReportIo[]) {
      const s = await serve({ io });
      const r = await report(await s.gate('user-a'), valid());
      expect(r.status).toBe(503);
      expect(files(s.dir)).toEqual([]);
      expect(s.lines.some((l) => l.includes('problem_report'))).toBe(false);
    }
  });

  it('a full store refuses new reports (503) and keeps the stored ones', async () => {
    const s = await serve({ config: { maxReports: 2 } });
    const base = await s.gate('user-a');
    expect((await report(base, valid())).status).toBe(201);
    expect((await report(base, valid())).status).toBe(201);
    expect((await report(base, valid())).status).toBe(503);
    expect(files(s.dir)).toHaveLength(2);
  });

  it('refusals that are not the user’s doing cost no rate token (review)', async () => {
    // A full store answers 503 every time; the tester retrying it must not end up with a 429.
    const s = await serve({ config: { maxReports: 1 } });
    const a = await s.gate('user-a');
    expect((await report(a, valid())).status).toBe(201);
    for (let i = 0; i < 6; i++) expect((await report(a, valid())).status).toBe(503);
    rmSync(join(s.dir, files(s.dir)[0]!));
    // 1 stored + 6 refused: only the stored one counts against the 5 per 10 minutes.
    for (let i = 0; i < 4; i++) expect((await report(a, valid())).status).toBe(i === 0 ? 201 : 503);
    // A failing disk likewise.
    const io = {
      syncFile: () => Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })),
      syncDir: () => Promise.resolve(),
    } as ReportIo;
    const f = await serve({ io });
    const b = await f.gate('user-b');
    for (let i = 0; i < 7; i++) expect((await report(b, valid())).status).toBe(503);
  });

  it('a directory created looser is tightened to 0700', async () => {
    const s = await serve();
    rmSync(s.dir, { recursive: true, force: true });
    execFileSync('mkdir', ['-m', '0755', s.dir]);
    expect((await report(await s.gate('user-a'), valid())).status).toBe(201);
    expect(statSync(s.dir).mode & 0o777).toBe(0o700);
  });
});

describe('retention and the operator CLI', () => {
  async function seeded() {
    let now = Date.parse('2026-01-01T00:00:00Z');
    const s = await serve({ now: () => now, config: { retentionMs: 90 * 24 * 3600_000 } });
    const a = await s.gate('user-a');
    const old = (await report(a, valid({ description: 'old' }))).body.id as string;
    now = Date.parse('2026-03-15T00:00:00Z');
    const mid = (await report(a, valid({ description: 'mid' }))).body.id as string;
    now = Date.parse('2026-04-10T00:00:00Z');
    const fresh = (await report(await s.gate('user-b'), valid({ description: 'new' }))).body
      .id as string;
    return { s, old, mid, fresh, setNow: (t: number) => (now = t) };
  }

  it('housekeeping deletes reports past retention and stale temporary files', async () => {
    const { s, old, mid, fresh } = await seeded();
    writeFileSync(join(s.dir, '.AAAA-BBBB-CCCC.tmp'), 'partial');
    execFileSync('touch', ['-d', '2 hours ago', join(s.dir, '.AAAA-BBBB-CCCC.tmp')]);
    writeFileSync(join(s.dir, 'notes.txt'), 'not a report'); // never touched
    // 2026-04-10 minus 90 days is 2026-01-10: only `old` is past retention.
    expect(await s.store!.purge()).toBe(1);
    expect(files(s.dir).sort()).toEqual([`${fresh}.json`, `${mid}.json`, 'notes.txt'].sort());
    expect(files(s.dir)).not.toContain(`${old}.json`);
  });

  it('show escapes bidirectional controls in a tester’s text (still the same JSON; review)', async () => {
    const { s } = await seeded();
    const cli = (...args: string[]) =>
      execFileSync(process.execPath, [CLI, '--dir', s.dir, ...args], { encoding: 'utf8' });
    const bidi = 'abc \u202edcba\u202c \u2066x\u2069'; // RLO ... PDF, isolate
    const tricky = (await report(await s.gate('user-c'), valid({ description: bidi }))).body
      .id as string;
    const shown = cli('show', tricky);
    expect(shown).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
    expect(shown).toContain('\\u202e');
    expect(JSON.parse(shown).description).toBe(bidi);
  });

  it('list, show, delete, delete-principal and purge-older work on the directory alone', async () => {
    const { s, old, mid, fresh } = await seeded();
    const cli = (...args: string[]) =>
      execFileSync(process.execPath, [CLI, '--dir', s.dir, ...args], { encoding: 'utf8' });
    const list = cli('list');
    expect(list).toContain('3 report(s)');
    expect(list.indexOf(old)).toBeLessThan(list.indexOf(fresh));
    expect(list).not.toContain('mid'); // descriptions are only shown by `show`
    expect(JSON.parse(cli('show', mid)).description).toBe('mid');
    expect(() => cli('show', '../../etc/passwd')).toThrow();
    // purge-older counts from the real clock: nothing is 9999 days old.
    expect(cli('purge-older', '9999')).toContain('deleted 0');
    expect(cli('delete', mid)).toContain(`deleted ${mid}`);
    expect(cli('delete-principal', A)).toContain('deleted 1');
    expect(files(s.dir)).toEqual([`${fresh}.json`]);
    expect(cli('purge-older', '0')).toContain('deleted 1');
    expect(files(s.dir)).toEqual([]);
  });
});

describe('contract helpers', () => {
  it('validateReport keeps only known fields and normalizes the description', () => {
    const v = validateReport(valid({ description: ' x\u0000 ', sim: { status: 'running' } }));
    expect(v).toEqual({
      ok: true,
      value: { ...valid({ description: 'x' }), sim: { status: 'running' } },
    });
  });

  it('browserOf keeps family, major version and OS family only', () => {
    expect(browserOf(CHROME_UA)).toEqual({ family: 'Chrome', major: 141, os: 'Linux' });
    expect(
      browserOf(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.3485.54',
      ),
    ).toEqual({ family: 'Edge', major: 140, os: 'Windows' });
    expect(
      browserOf(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0',
      ),
    ).toEqual({ family: 'Firefox', major: 143, os: 'macOS' });
    expect(
      browserOf(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
      ),
    ).toEqual({ family: 'Safari', major: 18, os: 'macOS' });
    expect(browserOf(undefined)).toEqual({ family: 'Other', major: null, os: 'Other' });
  });

  it('environment configuration: absolute directory, bounded values', () => {
    expect(reportsConfigFromEnv({ TBI_REPORTS_DIR: '/var/lib/x/reports' })).toMatchObject({
      dir: '/var/lib/x/reports',
      retentionMs: 90 * 24 * 3600_000,
      maxReports: 2000,
    });
    expect(
      reportsConfigFromEnv({
        TBI_REPORTS_DIR: '/r',
        TBI_REPORTS_RETENTION_DAYS: '30',
        TBI_REPORTS_MAX: '10',
      }),
    ).toMatchObject({ retentionMs: 30 * 24 * 3600_000, maxReports: 10 });
    expect(() => reportsConfigFromEnv({ TBI_REPORTS_DIR: 'relative/dir' })).toThrow();
    expect(() =>
      reportsConfigFromEnv({ TBI_REPORTS_DIR: '/r', TBI_REPORTS_RETENTION_DAYS: '0' }),
    ).toThrow();
  });
});
