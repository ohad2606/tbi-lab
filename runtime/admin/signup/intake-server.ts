/**
 * TBI-022: the public sign-up intake process, as a library (the process entry is intake-main.ts).
 * Inert by default: `intakeConfigFromEnv` returns `{ enabled: false }` unless TBI_SIGNUP_INTAKE=1,
 * and a misconfiguration with the flag set is an error (fail closed: nothing listens). The server
 * binds to the loopback interface only (the trusted proxy forwards to it) and serves `POST /signup`
 * only. It holds the HMAC secret and the Telegram token; it never sees the approval-mail key, the
 * account spool or any session data.
 *
 *   TBI_SIGNUP_INTAKE             must be exactly `1` to enable
 *   TBI_SIGNUP_DIR                the pending store (absolute)
 *   TBI_SIGNUP_HMAC_FILE          HMAC secret file (absolute; >= 32 bytes; the value is never logged)
 *   TBI_SIGNUP_TELEGRAM_TOKEN_FILE  bot token file (absolute)
 *   TBI_SIGNUP_TELEGRAM_CHAT_ID   the owner's chat
 *   TBI_SIGNUP_ADMIN_LINK         link placed in the notification (https)
 *   TBI_SIGNUP_LISTEN             `127.0.0.1:<port>` or `[::1]:<port>` (default 127.0.0.1:7411)
 *   TBI_SIGNUP_SOURCE_HEADER      header the trusted proxy sets to the client address
 */
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorClass } from './errors.js';
import { NonceCache } from './hmac.js';
import { handleSignupRequest, readSecret } from './http.js';
import { SlidingWindowLimiter } from './limits.js';
import { TelegramNotifier, type FetchLike } from './notify.js';
import { SignupIntake } from './service.js';
import { PendingStore } from './store.js';

export interface IntakeConfig {
  dir: string;
  hmacFile: string;
  tokenFile: string;
  chatId: string;
  adminLink: string;
  host: string;
  port: number;
  sourceHeader: string;
}

export type IntakeConfigResult =
  | { enabled: false; reason: string; error?: false }
  | { enabled: false; error: true; reason: string }
  | { enabled: true; config: IntakeConfig; error?: undefined; reason?: undefined };

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function intakeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): IntakeConfigResult {
  if (env.TBI_SIGNUP_INTAKE !== '1')
    return { enabled: false, reason: 'TBI_SIGNUP_INTAKE is not 1 (feature off)' };
  const bad = (reason: string): IntakeConfigResult => ({ enabled: false, error: true, reason });
  const need = (k: string): string | null => env[k] || null;
  const dir = need('TBI_SIGNUP_DIR');
  const hmacFile = need('TBI_SIGNUP_HMAC_FILE');
  const tokenFile = need('TBI_SIGNUP_TELEGRAM_TOKEN_FILE');
  const chatId = need('TBI_SIGNUP_TELEGRAM_CHAT_ID');
  const adminLink = need('TBI_SIGNUP_ADMIN_LINK');
  for (const [k, v] of Object.entries({
    TBI_SIGNUP_DIR: dir,
    TBI_SIGNUP_HMAC_FILE: hmacFile,
    TBI_SIGNUP_TELEGRAM_TOKEN_FILE: tokenFile,
    TBI_SIGNUP_TELEGRAM_CHAT_ID: chatId,
    TBI_SIGNUP_ADMIN_LINK: adminLink,
  }))
    if (!v) return bad(`${k} is required`);
  for (const [k, v] of Object.entries({
    TBI_SIGNUP_DIR: dir,
    TBI_SIGNUP_HMAC_FILE: hmacFile,
    TBI_SIGNUP_TELEGRAM_TOKEN_FILE: tokenFile,
  }))
    if (!v!.startsWith('/')) return bad(`${k} must be an absolute path`);
  if (!/^https:\/\//.test(adminLink!)) return bad('TBI_SIGNUP_ADMIN_LINK must be an https URL');
  const m = /^(\[[0-9a-f:]+\]|[^:[\]]+):(\d{1,5})$/i.exec(
    env.TBI_SIGNUP_LISTEN ?? '127.0.0.1:7411',
  );
  if (!m) return bad('TBI_SIGNUP_LISTEN must be host:port');
  const host = m[1]!.replace(/^\[|\]$/g, '');
  const port = Number(m[2]);
  if (!LOOPBACK.has(host)) return bad('TBI_SIGNUP_LISTEN must be a loopback address');
  if (port > 65535) return bad('TBI_SIGNUP_LISTEN port out of range');
  return {
    enabled: true,
    config: {
      dir: dir!,
      hmacFile: hmacFile!,
      tokenFile: tokenFile!,
      chatId: chatId!,
      adminLink: adminLink!,
      host,
      port,
      sourceHeader: (env.TBI_SIGNUP_SOURCE_HEADER ?? 'x-forwarded-for').toLowerCase(),
    },
  };
}

export interface RunningIntake {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/**
 * Preflight (secrets and store must be usable, else throw a class code and listen on nothing),
 * then listen. `fetch` is injected (tests); the entry passes the global one.
 */
export async function startIntake(
  c: IntakeConfig,
  io: { fetch: FetchLike; log: (line: string) => void; now?: () => number },
): Promise<RunningIntake> {
  const secret = await readSecret(c.hmacFile); // throws secret_missing / secret_unreadable / secret_short
  try {
    if ((await readFile(c.tokenFile, 'utf8')).trim().length === 0) throw new Error('token_empty');
  } catch (e) {
    // eslint-disable-next-line preserve-caught-error -- the cause would carry the token file path
    throw new Error(
      e instanceof Error && e.message === 'token_empty'
        ? 'token_empty'
        : errorClass(e).replace('secret_', 'token_'),
    );
  }
  const store = new PendingStore(c.dir, { now: io.now });
  await store.init();
  const now = io.now ?? Date.now;
  const intake = new SignupIntake({
    secret,
    store,
    notifier: new TelegramNotifier({
      readToken: () => readFile(c.tokenFile, 'utf8'),
      chatId: c.chatId,
      adminLink: c.adminLink,
      fetch: io.fetch,
    }),
    now,
    // A form sends one request per sign-up: generous for humans, tight for floods.
    sourceRate: new SlidingWindowLimiter({ count: 10, windowMs: 60_000 }, now),
    globalRate: new SlidingWindowLimiter({ count: 60, windowMs: 3_600_000 }, now),
    nonces: new NonceCache(),
    log: io.log,
  });
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/signup') {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end('{"error":"not_found"}');
      req.resume();
      return;
    }
    void handleSignupRequest(req, res, intake, c.sourceHeader);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(c.port, c.host, () => resolve());
  });
  return {
    server,
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
