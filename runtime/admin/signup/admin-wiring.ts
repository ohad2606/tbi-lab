/**
 * TBI-022: wires the owner side of the sign-up workflow into the admin service. Inert by default:
 * `adminSignupConfigFromEnv` returns `{ enabled: false }` unless TBI_SIGNUP_ADMIN=1; with the flag
 * set, a missing setting is an error. `signupWiringFromEnv` contains any such error (a bad
 * setting, an unusable store directory): it logs a reason / class code and returns null, so the
 * admin service runs WITHOUT the sign-up routes (they answer 404) instead of not starting at all;
 * account administration never depends on this optional feature. The routes themselves live in
 * accounts.ts (`signups` dependency).
 *
 *   TBI_SIGNUP_ADMIN             must be exactly `1` to enable
 *   TBI_SIGNUP_DIR               the pending store (absolute; shared with the intake)
 *   TBI_SIGNUP_RESEND_KEY_FILE   sending-only mail key file (absolute; read at send time only)
 *   TBI_SIGNUP_FROM              sender address, e.g. `TBI Lab <support@tbi-tech.net>`
 *   TBI_SIGNUP_LAB_URL           the lab link placed in the mail (https)
 *   TBI_SIGNUP_REPLY_TO          optional reply-to (default: the sender)
 */
import { errorClass } from './errors.js';
import { RESEND_KEY_RE, ResendSender, type EmailSender } from './email.js';
import type { FetchLike } from './notify.js';
import { SignupApprover } from './service.js';
import { spoolAccountAdder } from './http.js';
import { readSecretFile } from './secret-file.js';
import { DEFAULT_RETENTION, PendingStore, StoreError, type Retention } from './store.js';
import type { AdminSpool } from '../accounts.js';
import type { Principal } from '../../identity/principal.js';

export interface AdminSignupConfig {
  dir: string;
  keyFile: string;
  from: string;
  labUrl: string;
  replyTo?: string;
}

export type AdminSignupConfigResult =
  | { enabled: false; error?: false; reason: string }
  | { enabled: false; error: true; reason: string }
  | { enabled: true; config: AdminSignupConfig; error?: undefined; reason?: undefined };

export function adminSignupConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AdminSignupConfigResult {
  if (env.TBI_SIGNUP_ADMIN !== '1')
    return { enabled: false, reason: 'TBI_SIGNUP_ADMIN is not 1 (feature off)' };
  const bad = (reason: string): AdminSignupConfigResult => ({
    enabled: false,
    error: true,
    reason,
  });
  const dir = env.TBI_SIGNUP_DIR;
  const keyFile = env.TBI_SIGNUP_RESEND_KEY_FILE;
  const from = env.TBI_SIGNUP_FROM;
  const labUrl = env.TBI_SIGNUP_LAB_URL;
  if (!dir) return bad('TBI_SIGNUP_DIR is required');
  if (!keyFile) return bad('TBI_SIGNUP_RESEND_KEY_FILE is required');
  if (!from) return bad('TBI_SIGNUP_FROM is required');
  if (!labUrl) return bad('TBI_SIGNUP_LAB_URL is required');
  if (!dir.startsWith('/') || !keyFile.startsWith('/')) return bad('paths must be absolute');
  if (!/^https:\/\//.test(labUrl)) return bad('TBI_SIGNUP_LAB_URL must be an https URL');
  if (/[\r\n]/.test(from) || /[\r\n]/.test(env.TBI_SIGNUP_REPLY_TO ?? ''))
    return bad('sender settings must be single-line');
  return {
    enabled: true,
    config: {
      dir,
      keyFile,
      from,
      labUrl,
      ...(env.TBI_SIGNUP_REPLY_TO ? { replyTo: env.TBI_SIGNUP_REPLY_TO } : {}),
    },
  };
}

export const PURGE_INTERVAL_MS = 24 * 3_600_000;

export interface SignupAdminWiring {
  /** The `signups` dependency of `createAdminServer`. */
  signups: { approver: (actor: Principal) => SignupApprover };
  store: PendingStore;
  /** Runs the retention purge now and then daily; returns the stop function. */
  startPurge(): () => void;
}

export async function wireSignupAdmin(
  c: AdminSignupConfig,
  spool: AdminSpool,
  io: {
    fetch: FetchLike;
    log: (line: string) => void;
    email?: EmailSender;
    now?: () => number;
    retention?: Retention;
  },
): Promise<SignupAdminWiring> {
  const store = new PendingStore(c.dir, { now: io.now });
  await store.init();
  // The key is read at send time only (never held here); a missing file fails the send, not
  // startup. It is checked once now so a deploy mistake shows in the log before the first approval.
  if (!io.email) {
    const problem = await readSecretFile(c.keyFile).then(
      (k) => (RESEND_KEY_RE.test(k.trim()) ? null : 'bad_key'),
      (e: unknown) => errorClass(e),
    );
    if (problem) io.log(`signup: warning mail key not usable at start (${problem})`);
  }
  const email: EmailSender =
    io.email ??
    new ResendSender({
      from: c.from,
      labUrl: c.labUrl,
      ...(c.replyTo ? { replyTo: c.replyTo } : {}),
      readKey: () => readSecretFile(c.keyFile),
      fetch: io.fetch,
    });
  const runPurge = async () => {
    try {
      const removed = await store.purge(io.retention ?? DEFAULT_RETENTION);
      io.log(`signup: purge removed ${removed.length}`);
    } catch (e) {
      io.log(`signup: purge failed (${errorClass(e)})`);
    }
  };
  return {
    store,
    signups: {
      approver: (actor) =>
        new SignupApprover({
          store,
          accounts: spoolAccountAdder(spool, actor),
          email,
          now: io.now,
          log: io.log,
        }),
    },
    startPurge() {
      void runPurge();
      const t = setInterval(() => void runPurge(), PURGE_INTERVAL_MS);
      t.unref();
      return () => clearInterval(t);
    },
  };
}

/**
 * The admin service's entry point for the sign-up feature: null when the feature is off, and
 * also null (after ONE log line with a reason or class code, never a path or value) when it is
 * on but cannot be wired. Never throws: the account administration keeps running either way.
 */
export async function signupWiringFromEnv(
  env: NodeJS.ProcessEnv,
  spool: AdminSpool,
  io: Parameters<typeof wireSignupAdmin>[2],
): Promise<SignupAdminWiring | null> {
  const cfg = adminSignupConfigFromEnv(env);
  if (!cfg.enabled) {
    // The reasons are fixed texts naming a variable, never its value.
    if (cfg.error) io.log(`signup: admin routes disabled (config: ${cfg.reason})`);
    return null;
  }
  try {
    return await wireSignupAdmin(cfg.config, spool, io);
  } catch (e) {
    const code =
      e instanceof StoreError ? e.code : `store_${errorClass(e).replace(/^secret_/, '')}`;
    io.log(`signup: admin routes disabled (${code})`);
    return null;
  }
}
