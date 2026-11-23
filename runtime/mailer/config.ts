/**
 * ARC-MAILER: the mailer process configuration. Off unless TBI_MAILER=1 (exact). With the flag set,
 * a missing or invalid setting is an error (the process refuses to start). Reasons are fixed texts
 * naming a variable, never its value. The key is configured as a FILE path only (in deployment the
 * systemd credential `%d/resend.key`), never as a value.
 *
 *   TBI_MAILER               must be exactly `1` to enable
 *   TBI_MAILER_QUEUE_DIR     the queue written by the admin service (absolute)
 *   TBI_MAILER_STATUS_DIR    the mailer's status ledger (absolute; readable by the admin service)
 *   TBI_MAILER_KEY_FILE      sending-only provider key file (absolute; read at send time)
 *   TBI_MAILER_FROM          sender, `Name <address>` or a bare address (single line)
 *   TBI_MAILER_LAB_URL       the lab link placed in the approved text (https)
 *   TBI_MAILER_REPLY_TO      optional reply-to (default: the sender)
 *   TBI_MAILER_QUIET         quiet hours `HH:MM-HH:MM` Israel time (default 23:00-08:00) or `off`
 *   TBI_MAILER_MAX_PER_HOUR  provider attempts per hour (default 20, 1..200)
 *   TBI_MAILER_MAX_PER_DAY   provider attempts per day (default 100, 1..1000, not below per hour)
 *   TBI_MAILER_QUEUE_UID     optional: queue files must be owned by this uid (the admin user)
 */
import { parseQuiet } from '../admin/signup/quietHours.js';
import type { MailerConfig } from './mailer.js';

export interface MailerProcessConfig extends MailerConfig {
  keyFile: string;
}

export type MailerConfigResult =
  | { enabled: false; error?: false; reason: string }
  | { enabled: false; error: true; reason: string }
  | { enabled: true; config: MailerProcessConfig; error?: undefined; reason?: undefined };

/** Attempts per run (one tick a minute); bounded further by the hour and day caps. */
export const MAILER_MAX_PER_RUN = 10;

function intIn(v: string | undefined, def: number, lo: number, hi: number): number | null {
  if (v === undefined || v === '') return def;
  if (!/^\d{1,7}$/.test(v)) return null;
  const n = Number(v);
  return n >= lo && n <= hi ? n : null;
}

export function mailerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MailerConfigResult {
  if (env.TBI_MAILER !== '1')
    return { enabled: false, reason: 'TBI_MAILER is not 1 (feature off)' };
  const bad = (reason: string): MailerConfigResult => ({ enabled: false, error: true, reason });
  const queueDir = env.TBI_MAILER_QUEUE_DIR;
  const statusDir = env.TBI_MAILER_STATUS_DIR;
  const keyFile = env.TBI_MAILER_KEY_FILE;
  const from = env.TBI_MAILER_FROM;
  const labUrl = env.TBI_MAILER_LAB_URL;
  if (!queueDir) return bad('TBI_MAILER_QUEUE_DIR is required');
  if (!statusDir) return bad('TBI_MAILER_STATUS_DIR is required');
  if (!keyFile) return bad('TBI_MAILER_KEY_FILE is required');
  if (!from) return bad('TBI_MAILER_FROM is required');
  if (!labUrl) return bad('TBI_MAILER_LAB_URL is required');
  if (![queueDir, statusDir, keyFile].every((p) => p.startsWith('/')))
    return bad('paths must be absolute');
  if (queueDir === statusDir) return bad('queue and status directories must differ');
  if (!/^https:\/\/[^\s/@]+(\/\S*)?$/.test(labUrl))
    return bad('TBI_MAILER_LAB_URL must be an https URL');
  const replyTo = env.TBI_MAILER_REPLY_TO;
  if (/[\r\n]/.test(from) || /[\r\n]/.test(replyTo ?? ''))
    return bad('sender settings must be single-line');
  let quiet;
  try {
    quiet = parseQuiet(env.TBI_MAILER_QUIET);
  } catch {
    return bad('TBI_MAILER_QUIET must be HH:MM-HH:MM or off');
  }
  const maxPerHour = intIn(env.TBI_MAILER_MAX_PER_HOUR, 20, 1, 200);
  if (maxPerHour === null) return bad('TBI_MAILER_MAX_PER_HOUR must be 1..200');
  const maxPerDay = intIn(env.TBI_MAILER_MAX_PER_DAY, 100, 1, 1000);
  if (maxPerDay === null || maxPerDay < maxPerHour)
    return bad('TBI_MAILER_MAX_PER_DAY must be 1..1000 and not below the hourly cap');
  let queueUid: number | undefined;
  if (env.TBI_MAILER_QUEUE_UID !== undefined) {
    const u = intIn(env.TBI_MAILER_QUEUE_UID, -1, 1, 4_294_967_294);
    if (u === null || u < 1) return bad('TBI_MAILER_QUEUE_UID must be a non-root uid');
    queueUid = u;
  }
  return {
    enabled: true,
    config: {
      queueDir,
      statusDir,
      keyFile,
      from,
      labUrl,
      ...(replyTo ? { replyTo } : {}),
      quiet,
      maxPerRun: MAILER_MAX_PER_RUN,
      maxPerHour,
      maxPerDay,
      ...(queueUid !== undefined ? { queueUid } : {}),
    },
  };
}
