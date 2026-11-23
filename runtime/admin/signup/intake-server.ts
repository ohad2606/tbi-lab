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
 *   TBI_SIGNUP_QUIET              quiet hours `HH:MM-HH:MM` Israel time (default 23:00-08:00) or `off`; alerts
 *                                 triggered inside it are stored and sent when it ends
 *   TBI_SIGNUP_SOURCE_HEADER      REQUIRED: header the trusted proxy sets to the client address (an
 *                                 IP), e.g. `x-forwarded-for`; unset or malformed = refusal to start
 *                                 (design §3: no silent fallback that puts every client in one bucket).
 *                                 Requests without a valid IP in it are logged (throttled) as
 *                                 `source_header_missing` (they share the proxy's rate bucket)
 *   TBI_SIGNUP_WEB                BETA-G1 s8: exactly `1` adds the browser route (`GET /signup/form-token`,
 *                                 `POST /signup/web`); unset / empty / `0` = off (both paths 404); any
 *                                 other value = refusal to start. docs/plans/BETA-G1-WEB-INTAKE.md
 *   TBI_SIGNUP_WEB_ORIGINS        REQUIRED when TBI_SIGNUP_WEB=1, no default: comma-separated exact
 *                                 `https://host[:port]` origins of the sign-up page
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorClass } from './errors.js';
import { NonceCache } from './hmac.js';
import {
  handleSignupRequest,
  handleWebSignupRequest,
  parseSourceHeader,
  readSecret,
  WEB_SIGNUP_PATH,
  WEB_TOKEN_PATH,
} from './http.js';
import { SlidingWindowLimiter } from './limits.js';
import { TELEGRAM_TOKEN_RE, TelegramNotifier, type FetchLike } from './notify.js';
import { parseQuiet, type QuietWindow } from './quietHours.js';
import { readSecretFile } from './secret-file.js';
import { SignupIntake } from './service.js';
import { PendingStore } from './store.js';
import { deriveWebKey, parseOrigins, WEB_TOKEN_TTL_MS } from './web.js';

export interface IntakeConfig {
  dir: string;
  hmacFile: string;
  tokenFile: string;
  chatId: string;
  adminLink: string;
  host: string;
  port: number;
  sourceHeader: string;
  /** Quiet hours (null / unset = off). */
  quiet?: QuietWindow | null;
  /** BETA-G1 s8: the browser route; null / unset = off (its paths answer 404). */
  web?: { origins: string[] } | null;
}

export const INTAKE_DRAIN_MS = 60_000;

/**
 * Rate limits (design §3, values chosen in FABLE-REVIEW 3). The form forwarder runs on Google's
 * servers, so the per-source key is an address of Google's SHARED UrlFetch pool, not of the
 * person: it bounds how much unsigned work one source can cause (it is checked before the HMAC)
 * but is not a per-person limit, and other Apps Script users on the same address share it. The
 * global budget is spent only by requests that verify (secret holders), so it bounds the damage
 * of a leaked secret; it is set well above any realistic burst of real sign-ups. A 429 is not a
 * loss: the forwarder retries with backoff (Code.gs). The store cap is the final bound.
 */
export const INTAKE_SOURCE_LIMIT = { count: 30, windowMs: 60_000 } as const;
export const INTAKE_GLOBAL_LIMIT = { count: 200, windowMs: 3_600_000 } as const;
export const INTAKE_MAX_RECORDS = 5_000;

/**
 * BETA-G1 s8, the browser route (docs/plans/BETA-G1-WEB-INTAKE.md). Here the source key IS a
 * person's address (the proxy's last hop), unlike the signed route's shared forwarder pool, so the
 * per-source limits are small: a few page loads and a few retries (typos, `too_fast`). The global
 * budget is separate from the signed route's and is spent only by requests carrying a token this
 * intake issued; a real person never retries a 429 automatically, so it is generous.
 */
export const WEB_TOKEN_SOURCE_LIMIT = { count: 20, windowMs: 10 * 60_000 } as const;
export const WEB_POST_SOURCE_LIMIT = { count: 10, windowMs: 10 * 60_000 } as const;
export const WEB_GLOBAL_LIMIT = { count: 200, windowMs: 3_600_000 } as const;

/** At most one `source_header_missing` line per this interval. */
export const SOURCE_FALLBACK_LOG_MS = 10 * 60_000;

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
  const sourceHeader = parseSourceHeader(env.TBI_SIGNUP_SOURCE_HEADER);
  if (!sourceHeader) return bad('TBI_SIGNUP_SOURCE_HEADER is required (a header name)');
  let quiet: QuietWindow | null;
  try {
    quiet = parseQuiet(env.TBI_SIGNUP_QUIET);
  } catch (e) {
    return bad((e as Error).message);
  }
  let web: { origins: string[] } | null = null;
  const webFlag = env.TBI_SIGNUP_WEB ?? '';
  if (webFlag === '1') {
    const origins = parseOrigins(env.TBI_SIGNUP_WEB_ORIGINS);
    if (!origins)
      return bad(
        'TBI_SIGNUP_WEB_ORIGINS is required with TBI_SIGNUP_WEB=1 (comma-separated https origins)',
      );
    web = { origins };
  } else if (webFlag !== '' && webFlag !== '0') return bad('TBI_SIGNUP_WEB must be 1, 0 or unset');
  return {
    enabled: true,
    config: {
      quiet,
      web,
      dir: dir!,
      hmacFile: hmacFile!,
      tokenFile: tokenFile!,
      chatId: chatId!,
      adminLink: adminLink!,
      host,
      port,
      sourceHeader,
    },
  };
}

export interface RunningIntake {
  server: Server;
  /** The intake itself (tests await `settled()` for web-route alerts). */
  intake: SignupIntake;
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
  // The token must be usable now (same shape check as the notifier), else nothing listens.
  const token = await readSecretFile(c.tokenFile).then(
    (t) => t.trim(),
    (e: unknown) => {
      throw new Error(errorClass(e).replace('secret_', 'token_'));
    },
  );
  if (token.length === 0) throw new Error('token_empty');
  if (!TELEGRAM_TOKEN_RE.test(token)) throw new Error('token_malformed');
  const store = new PendingStore(c.dir, { now: io.now, maxRecords: INTAKE_MAX_RECORDS });
  await store.init();
  const now = io.now ?? Date.now;
  const intake = new SignupIntake({
    secret,
    store,
    notifier: new TelegramNotifier({
      readToken: () => readSecretFile(c.tokenFile),
      chatId: c.chatId,
      adminLink: c.adminLink,
      fetch: io.fetch,
    }),
    now,
    quiet: c.quiet ?? null,
    sourceRate: new SlidingWindowLimiter(INTAKE_SOURCE_LIMIT, now),
    globalRate: new SlidingWindowLimiter(INTAKE_GLOBAL_LIMIT, now),
    nonces: new NonceCache(),
    log: io.log,
    ...(c.web
      ? {
          web: {
            webKey: deriveWebKey(secret),
            tokenRate: new SlidingWindowLimiter(WEB_TOKEN_SOURCE_LIMIT, now),
            sourceRate: new SlidingWindowLimiter(WEB_POST_SOURCE_LIMIT, now),
            globalRate: new SlidingWindowLimiter(WEB_GLOBAL_LIMIT, now),
            // Its own cache: a used token is remembered for 2 x its TTL (outlives every valid use).
            nonces: new NonceCache({ windowMs: WEB_TOKEN_TTL_MS }),
          },
        }
      : {}),
  });
  let lastFallbackLog = -Infinity;
  const onSourceFallback = () => {
    const t = now();
    if (t - lastFallbackLog < SOURCE_FALLBACK_LOG_MS) return;
    lastFallbackLog = t;
    io.log('signup: warning source_header_missing (no valid client IP in the proxy header)');
  };
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (c.web && (path === WEB_TOKEN_PATH || path === WEB_SIGNUP_PATH)) {
      void handleWebSignupRequest(req, res, intake, path, {
        sourceHeader: c.sourceHeader,
        origins: c.web.origins,
        onSourceFallback,
      });
      return;
    }
    if (path !== '/signup') {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end('{"error":"not_found"}');
      req.resume();
      return;
    }
    void handleSignupRequest(req, res, intake, c.sourceHeader, onSourceFallback);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(c.port, c.host, () => resolve());
  });
  // Alerts deferred by quiet hours: sent from here (this process holds the Telegram token), at
  // start (always: markers left from before quiet hours were switched off are sent too) and then
  // every minute while quiet hours are on; unref'd, and stopped by close().
  let drainTimer: NodeJS.Timeout | null = null;
  const tick = () => void intake.drainNotifications();
  tick();
  if (c.quiet) {
    drainTimer = setInterval(tick, INTAKE_DRAIN_MS);
    drainTimer.unref();
  }
  if (c.web) io.log(`web route on (${c.web.origins.length} origin(s))`);
  return {
    server,
    intake,
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        if (drainTimer) clearInterval(drainTimer);
        // Web-route alerts still in flight finish first (each is bounded by the notifier timeout).
        server.close(() => void intake.settled().then(resolve, resolve));
        server.closeAllConnections();
      }),
  };
}
