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
 *   TBI_SIGNUP_QUIET             quiet hours `HH:MM-HH:MM` Israel time (default 23:00-08:00) or `off`;
 *                                approval emails triggered inside it are queued (see quietHours.ts)
 *   TBI_SIGNUP_RETENTION_PENDING_DAYS  requests not approved (pending, rejected) are deleted within
 *                                this many days of creation (default 90, 1..365)
 *   TBI_SIGNUP_RETENTION_MAX_DAYS      every other request is deleted at the latest this many days
 *                                after creation (default 365, 1..365; not below the first)
 *   TBI_SIGNUP_AUTO_APPROVE      BETA-G1, OFF by default: `1` approves pending requests automatically
 *   TBI_SIGNUP_AUTO_DAILY_CAP    required with it: 1..1000 per Israel day (see autoApprove.ts). A bad
 *                                value leaves auto-approve off (one log line); manual approval stays.
 *   TBI_SIGNUP_AUTO_STATE_DIR    optional: admin-only dir for the pause file + state (default: the
 *                                store dir); refused when not owned by us or group/world-writable
 *   TBI_SIGNUP_AUTO_SINCE        optional ISO cut-off; unset = the first time auto-approve ran
 *   TBI_SIGNUP_VERIFY            G1-AUTO-VERIFY, OFF by default: `1` sends the verify mail and
 *                                records confirmations (verifyState.ts; needs
 *                                TBI_SIGNUP_VERIFY_KEY_FILE, TBI_SIGNUP_SITE_URL and a separate
 *                                TBI_SIGNUP_AUTO_STATE_DIR). Approval stays manual unless
 *                                TBI_SIGNUP_AUTO_WEB=verified with auto-approve on.
 *   TBI_SIGNUP_MAIL_MAX_PER_HOUR / _PER_DAY / _PER_30D, TBI_SIGNUP_VERIFY_MAX_PER_DAY,
 *   TBI_SIGNUP_RETENTION_UNVERIFIED_DAYS   S4a safeguards (mailGate.ts), all unset = today's
 *                                behaviour. A bad value disables the sign-up admin routes (one log
 *                                line); TBI_SIGNUP_AUTO_WEB=verified needs the mail caps (without
 *                                them: no auto-approve and no verify mail; the binding stays).
 */
import {
  AUTO_APPROVE_INTERVAL_MS,
  AutoApprover,
  type AutoApproveStatus,
  autoApproveConfigFromEnv,
  type AutoWebSignups,
  autoStateDirCheck,
} from './autoApprove.js';
import { errorClass } from './errors.js';
import { RESEND_KEY_RE, ResendSender, type EmailSender } from './email.js';
import type { FetchLike } from './notify.js';
import { parseQuiet, type QuietWindow } from './quietHours.js';
import { SignupApprover, type AccountAdder } from './service.js';
import { spoolAccountAdder } from './http.js';
import { readSecretFile } from './secret-file.js';
import {
  DEFAULT_RETENTION,
  PendingStore,
  retentionFromEnv,
  StoreError,
  type Retention,
} from './store.js';
import { loadVerifyKeys } from './verify.js';
import { MailGate, safeguardsFromEnv, type MailLimits } from './mailGate.js';
import { VERIFY_MAX_PER_DAY } from './verifyState.js';
import { Verifier, verifyConfigFromEnv, type VerifyConfig } from './verifyState.js';
import type { AdminSpool } from '../accounts.js';
import type { FunnelSink } from '../funnel/counters.js';
import type { Principal } from '../../identity/principal.js';

export interface AdminSignupConfig {
  dir: string;
  keyFile: string;
  from: string;
  labUrl: string;
  replyTo?: string;
  /** Quiet hours (null = off). Unset (tests building a config by hand) = off. */
  quiet?: QuietWindow | null;
  /** Retention of the store (unset: DEFAULT_RETENTION, 90 d not approved / 365 d at most). */
  retention?: Retention;
  /** BETA-G1: auto-approve with a daily cap; unset = off (today's manual flow, unchanged). */
  autoApprove?: {
    dailyCap: number;
    stateDir?: string;
    since?: number;
    /** BETA-G1 s8: unset = `excluded` (web-origin requests are never auto-approved). */
    webSignups?: AutoWebSignups;
  };
  /** G1-AUTO-VERIFY: email verification; unset = off (no key read, nothing written). */
  verify?: VerifyConfig & { maxPerDay?: number; unverifiedDays?: number };
  /**
   * TBI_SIGNUP_AUTO_WEB=verified is set, whether or not auto-approve is on: the approval mail
   * binding stays, and without `mailCaps` no verify mail is sent.
   */
  verifiedMode?: boolean;
  /** S4a: the mail gate around every applicant mail; unset = no gate (today's behaviour). */
  mailCaps?: MailLimits & { stateDir: string };
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
  let quiet: QuietWindow | null;
  try {
    quiet = parseQuiet(env.TBI_SIGNUP_QUIET);
  } catch (e) {
    return bad((e as Error).message);
  }
  let retention: Retention;
  try {
    retention = retentionFromEnv(env);
  } catch (e) {
    return bad((e as Error).message);
  }
  let mailCaps: AdminSignupConfig['mailCaps'];
  try {
    const sg = safeguardsFromEnv(env);
    if (sg.mail) {
      const sd = env.TBI_SIGNUP_AUTO_STATE_DIR ?? '';
      if (!sd.startsWith('/') || sd.replace(/\/+$/, '') === dir.replace(/\/+$/, ''))
        return bad('the mail caps need TBI_SIGNUP_AUTO_STATE_DIR (not the store dir)');
      mailCaps = { ...sg.mail, stateDir: sd };
    }
  } catch (e) {
    return bad((e as Error).message);
  }
  return {
    enabled: true,
    config: {
      ...(mailCaps ? { mailCaps } : {}),
      quiet,
      retention,
      dir,
      keyFile,
      from,
      labUrl,
      ...(env.TBI_SIGNUP_REPLY_TO ? { replyTo: env.TBI_SIGNUP_REPLY_TO } : {}),
    },
  };
}

export const PURGE_INTERVAL_MS = 24 * 3_600_000;

/**
 * BETA-G1 slice 5: `GET /signups/auto-approve`. Off: `{enabled:false}` (nothing read). On: the
 * sweeper's read-only status plus `running` (the sweep timer of this process is active: false
 * before start, after stop, or when start refused an unsafe state dir; then a restart is needed).
 */
export type AutoApproveStatusAnswer =
  { enabled: false } | ({ enabled: true; running: boolean } & AutoApproveStatus);

export interface SignupAdminWiring {
  /** The `signups` dependency of `createAdminServer`. */
  signups: {
    approver: (actor: Principal) => SignupApprover;
    autoStatus: () => Promise<AutoApproveStatusAnswer>;
  };
  store: PendingStore;
  /**
   * Runs the retention purge now and then daily; returns the stop function. Each run also deletes
   * what would pass its deadline before the next run, so no record outlives its retention.
   */
  startPurge(): () => void;
  /**
   * Sends the queued approval emails whose quiet hours are over, now and every minute; returns
   * stop, which resolves once a drain in progress has finished.
   */
  startDrain(): () => Promise<void>;
  /**
   * BETA-G1: runs the auto-approve sweep now and every minute; returns stop (resolves once a
   * sweep in progress has finished). Without `config.autoApprove` it does nothing at all.
   */
  startAutoApprove(): () => Promise<void>;
  /** The sweeper, when auto-approve is configured (tests, operator checks); else null. */
  auto: AutoApprover | null;
  /** G1-AUTO-VERIFY: the verify step (runs before each auto-approve sweep), or null when off. */
  verifier: Verifier | null;
}

export const DRAIN_INTERVAL_MS = 60_000;

export async function wireSignupAdmin(
  c: AdminSignupConfig,
  spool: AdminSpool,
  io: {
    fetch: FetchLike;
    log: (line: string) => void;
    email?: EmailSender;
    now?: () => number;
    retention?: Retention;
    /**
     * BETA-G1: the principal auto-approve submits account requests as (the root helper accepts
     * them from the owner only), read at every sweep; null = not known yet (sweep waits).
     */
    autoActor?: () => Principal | null;
    /** K12: funnel counters (`signup_approved`); null / unset = off (see funnel/counters.ts). */
    counters?: FunnelSink | null;
  },
): Promise<SignupAdminWiring> {
  let verifier: Verifier | null = null;
  const store = new PendingStore(
    c.dir,
    c.verify ? { now: io.now, onRemoved: (id) => verifier!.remove(id) } : { now: io.now },
  );
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
  const rawEmail: EmailSender =
    io.email ??
    new ResendSender({
      from: c.from,
      labUrl: c.labUrl,
      ...(c.replyTo ? { replyTo: c.replyTo } : {}),
      readKey: () => readSecretFile(c.keyFile),
      fetch: io.fetch,
    });
  // S4a: ONE gate around the sender, so every applicant mail (approval, drain, owner resend,
  // verify) takes a persisted slot first. No caps configured = the sender itself, unchanged.
  const gate = c.mailCaps
    ? new MailGate({
        stateDir: c.mailCaps.stateDir,
        storeDir: c.dir,
        limits: c.mailCaps,
        now: io.now,
        log: io.log,
      })
    : null;
  const email: EmailSender = gate ? gate.wrap(rawEmail) : rawEmail;
  const runPurge = async () => {
    try {
      const removed = await store.purge(
        io.retention ?? c.retention ?? DEFAULT_RETENTION,
        PURGE_INTERVAL_MS,
      );
      io.log(
        `signup: purge removed ${removed.length}` +
          (store.corruptPurged ? ` and ${store.corruptPurged} unreadable file(s)` : ''),
      );
    } catch (e) {
      io.log(`signup: purge failed (${errorClass(e)})`);
    }
  };
  const quiet = c.quiet ?? null;
  if (c.verify) {
    const v = c.verify;
    verifier = new Verifier({
      stateDir: v.stateDir,
      storeDir: c.dir,
      store,
      email,
      siteUrl: v.siteUrl,
      keys: () => loadVerifyKeys(v.keyFile),
      ...(v.since !== undefined ? { since: v.since } : {}),
      ...(v.maxPerDay !== undefined ? { maxPerDay: v.maxPerDay } : {}),
      ...(c.verifiedMode && !c.mailCaps ? { mailsHeld: true } : {}),
      ...(v.unverifiedDays !== undefined
        ? {
            unverifiedDays: v.unverifiedDays,
            claimed: () => (auto ? auto.claimedIds() : Promise.resolve(new Set<string>())),
          }
        : {}),
      gate,
      now: io.now,
      log: io.log,
    });
  }
  // Verified mode (G1-AUTO-VERIFY): every approval mail, owner or auto, drained or not, goes only
  // to the address its account was added for (service.ts ApprovalMailBinding).
  const verifiedMode = c.verifiedMode || c.autoApprove?.webSignups === 'verified';
  const mailBinding = verifier && verifiedMode ? { mailBinding: verifier } : {};
  // The drain only sends mail for accounts that already exist; it never adds one.
  const drainer = new SignupApprover({
    store,
    accounts: { add: async () => 'error' },
    email,
    quiet,
    now: io.now,
    log: io.log,
    ...mailBinding,
  });
  const runDrain = async () => {
    try {
      const n = await drainer.drainEmails();
      if (n > 0) io.log(`signup: queued emails processed ${n}`);
    } catch (e) {
      io.log(`signup: email drain failed (${errorClass(e)})`);
    }
  };
  let draining: Promise<void> | null = null;
  const auto = c.autoApprove
    ? new AutoApprover({
        dir: c.autoApprove.stateDir ?? c.dir,
        store,
        dailyCap: c.autoApprove.dailyCap,
        ...(c.autoApprove.since !== undefined ? { since: c.autoApprove.since } : {}),
        ...(c.autoApprove.webSignups ? { webSignups: c.autoApprove.webSignups } : {}),
        ...(verifier ? { verified: verifier } : {}),
        now: io.now,
        log: io.log,
        approver: (hooks) => {
          const actor = io.autoActor?.() ?? null;
          const watched = {
            submit: async (...a: Parameters<AdminSpool['submit']>) => {
              const id = await spool.submit(...a);
              hooks.onSpoolRequest(id);
              return id;
            },
            wait: (id: string) => spool.wait(id),
          };
          if (!actor) return null;
          const inner = spoolAccountAdder(watched, actor);
          // Verified mode: the address handed to the spool must still be the proven one.
          const accounts: AccountAdder = {
            add: async (email, name) => {
              if (await hooks.mayAdd(email)) return inner.add(email, name);
              io.log(
                'signup: auto-approve account request refused (not verified for this address)',
              );
              return 'error';
            },
          };
          return actor
            ? new SignupApprover({
                store,
                accounts,
                email,
                quiet,
                now: io.now,
                log: io.log,
                actor: 'auto',
                counters: io.counters ?? null,
                ...mailBinding,
              })
            : null;
        },
      })
    : null;
  let sweeping: Promise<void> | null = null;
  let running = false;
  return {
    store,
    auto,
    verifier,
    startAutoApprove() {
      if (!auto && !verifier) return async () => undefined;
      if (auto) io.log(`signup: auto-approve on (daily cap ${c.autoApprove!.dailyCap})`);
      if (verifier) io.log('signup: email verification on');
      let t: ReturnType<typeof setInterval> | undefined;
      let stopped = false;
      let autoOk = false;
      const tick = () => {
        if (sweeping) return;
        sweeping = (async () => {
          // The verify step first, so a confirmation of this minute counts in this sweep.
          if (verifier)
            await verifier
              .sweep({ stop: () => stopped })
              .catch((e: unknown) => io.log(`signup: verify sweep failed (${errorClass(e)})`));
          if (!auto || !autoOk) return;
          await auto
            .sweep()
            .then((r) => {
              if (r.attempted > 0) io.log(`signup: auto-approve processed ${r.attempted}`);
            })
            .catch((e: unknown) => io.log(`signup: auto-approve sweep failed (${errorClass(e)})`));
        })().finally(() => {
          sweeping = null;
        });
      };
      // Refuse to start on an unsafe state dir (one log line); manual approval is unaffected.
      const started = (
        auto ? autoStateDirCheck(c.autoApprove!.stateDir ?? c.dir) : Promise.resolve(null)
      ).then((bad) => {
        if (bad) {
          io.log(`signup: auto-approve not started (state dir unsafe: ${bad}); manual only`);
          if (!verifier) return;
        } else autoOk = !!auto;
        // A stop requested while the state dir was checked: no sweep at all.
        if (stopped) return;
        tick();
        t = setInterval(tick, AUTO_APPROVE_INTERVAL_MS);
        t.unref();
        running = autoOk;
      });
      return async () => {
        stopped = true;
        running = false;
        await started;
        if (t) clearInterval(t);
        await sweeping;
      };
    },
    signups: {
      autoStatus: async () =>
        auto ? { enabled: true, running, ...(await auto.status()) } : { enabled: false },
      approver: (actor) =>
        new SignupApprover({
          store,
          accounts: spoolAccountAdder(spool, actor),
          email,
          quiet,
          now: io.now,
          log: io.log,
          counters: io.counters ?? null,
          ...mailBinding,
          ownerActions: true,
        }),
    },
    startDrain() {
      const tick = () => {
        if (draining) return;
        draining = runDrain().finally(() => {
          draining = null;
        });
      };
      tick();
      const t = setInterval(tick, DRAIN_INTERVAL_MS);
      t.unref();
      return async () => {
        clearInterval(t);
        await draining;
      };
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
  let auto = autoApproveConfigFromEnv(env);
  if (auto.enabled === false && auto.error)
    io.log(`signup: auto-approve off (config: ${auto.reason})`);
  // S4a: no automatic approval of web sign-ups without the mail caps.
  if (auto.enabled && auto.webSignups === 'verified' && !cfg.config.mailCaps) {
    auto = {
      enabled: false,
      error: true,
      reason: 'TBI_SIGNUP_AUTO_WEB=verified needs the mail caps',
    };
    io.log(`signup: auto-approve off (config: ${auto.reason})`);
  }
  const config: AdminSignupConfig = auto.enabled
    ? {
        ...cfg.config,
        autoApprove: {
          dailyCap: auto.dailyCap,
          ...(auto.stateDir !== undefined ? { stateDir: auto.stateDir } : {}),
          ...(auto.since !== undefined ? { since: auto.since } : {}),
          webSignups: auto.webSignups,
        },
      }
    : { ...cfg.config };
  // Keyed on the setting itself: it holds also when auto-approve is off (missing caps, bad cap).
  if (env.TBI_SIGNUP_AUTO_WEB === 'verified') config.verifiedMode = true;
  // G1-AUTO-VERIFY: all flags unset = `verify` stays absent (no key read, nothing written).
  const ver = verifyConfigFromEnv(env, cfg.config.dir);
  if (ver.enabled) config.verify = ver.config;
  else if (ver.error) io.log(`signup: email verification off (config: ${ver.reason})`);
  const sg = safeguardsFromEnv(env); // already validated by adminSignupConfigFromEnv
  const refuse = (reason: string) => {
    io.log(`signup: admin routes disabled (config: ${reason})`);
    return null;
  };
  if ((sg.verifyPerDay !== undefined || sg.unverifiedDays !== undefined) && !config.verify)
    return refuse(
      'TBI_SIGNUP_VERIFY_MAX_PER_DAY / _RETENTION_UNVERIFIED_DAYS need TBI_SIGNUP_VERIFY=1',
    );
  if (config.verify) {
    const perDay = sg.verifyPerDay ?? VERIFY_MAX_PER_DAY;
    if (config.mailCaps && perDay > config.mailCaps.perDay)
      return refuse('TBI_SIGNUP_VERIFY_MAX_PER_DAY must not exceed TBI_SIGNUP_MAIL_MAX_PER_DAY');
    if (sg.verifyPerDay !== undefined) config.verify.maxPerDay = sg.verifyPerDay;
    if (sg.unverifiedDays !== undefined) config.verify.unverifiedDays = sg.unverifiedDays;
  }
  if (auto.enabled && auto.webSignups === 'verified' && !ver.enabled)
    io.log(
      'signup: warning auto-approve web=verified without email verification; nothing is auto-approved',
    );
  try {
    return await wireSignupAdmin(config, spool, io);
  } catch (e) {
    const code =
      e instanceof StoreError ? e.code : `store_${errorClass(e).replace(/^secret_/, '')}`;
    io.log(`signup: admin routes disabled (${code})`);
    return null;
  }
}
