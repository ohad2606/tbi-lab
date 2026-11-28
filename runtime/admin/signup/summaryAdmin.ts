/**
 * BETA-G1 G1-AUTO-VERIFY slice 4b, admin side: collects the counts of summary.ts and writes
 * `<STORE_DIR>/auto-summary.json`. OFF unless TBI_SIGNUP_SUMMARY=1. Write-only: the file is never
 * read back. Counts of sign-ups, confirmations and approvals come from the records the store holds
 * now (a request deleted or purged since is not counted); the verify mail and mail budget numbers
 * come from the admin-only state.
 */
import { join } from 'node:path';
import { AUTO_PAUSE_FILE, autoPauseCheck, israelDay, type AutoApprover } from './autoApprove.js';
import type { MailGate, MailLimits } from './mailGate.js';
import type { PendingStore, SignupRecord } from './store.js';
import { replaceJson, SUMMARY_FILE, type DayCounts, type Summary } from './summary.js';
import type { Verifier } from './verifyState.js';

const HOUR_MS = 3_600_000;

export interface SummaryDeps {
  storeDir: string;
  store: PendingStore;
  auto: AutoApprover | null;
  verify: {
    verifier: Verifier;
    maxPerDay: number;
    /** Resolves when the verify key can be read and parsed. */
    keys: () => Promise<unknown>;
  } | null;
  mail: { gate: MailGate; limits: MailLimits } | null;
  /** Where the kill switch lives; null = no state dir configured (nothing can be paused). */
  pauseDir: string | null;
  now?: () => number;
}

/** The Israel calendar day before `day`'s instant `t` (DST-correct: days are at least 23 h). */
export function previousIsraelDay(t: number): string {
  const day = israelDay(t);
  let x = t;
  while (israelDay(x) === day) x -= HOUR_MS;
  return israelDay(x);
}

function dayCounts(
  records: SignupRecord[],
  day: string,
  t: number,
  verifyMails: number | null,
  verifyOn: boolean,
): DayCounts {
  const on = (iso: string | null | undefined): boolean => {
    const ms = iso ? Date.parse(iso) : NaN;
    // The cheap age test first: the date formatting is slow over a full store.
    return Math.abs(t - ms) < 72 * HOUR_MS && israelDay(ms) === day;
  };
  return {
    signups: records.filter((r) => on(r.createdAt)).length,
    verifyMails,
    verified: verifyOn ? records.filter((r) => on(r.verifiedAt)).length : null,
    // Approved only: a `pending` or `rejected` record can carry the mark without being approved.
    autoApproved: records.filter(
      (r) =>
        r.accountAdded &&
        r.status !== 'pending' &&
        r.status !== 'rejected' &&
        r.approvedBy !== 'owner' &&
        on(r.autoApprovedAt),
    ).length,
  };
}

export async function collectSummary(d: SummaryDeps): Promise<Summary> {
  const t = (d.now ?? Date.now)();
  const day = israelDay(t);
  const before = previousIsraelDay(t);
  const records = await d.store.list();
  const mails = d.verify ? await d.verify.verifier.mailCounts([day, before]) : null;
  const cap = d.auto ? await d.auto.capStatus(records) : null;
  const used = d.mail ? await d.mail.gate.usage() : null;
  const mail =
    d.mail && used
      ? {
          dayUsed: used.day,
          dayLimit: d.mail.limits.perDay,
          d30Used: used.d30,
          d30Limit: d.mail.limits.per30d,
        }
      : null;
  const keyBad = d.verify
    ? await d.verify.keys().then(
        () => false,
        () => true,
      )
    : false;
  const paused = d.pauseDir
    ? (await autoPauseCheck(join(d.pauseDir, AUTO_PAUSE_FILE))).paused
    : false;
  const at80 = (n: number, max: number) => n * 5 >= max * 4;
  return {
    v: 1,
    at: new Date(t).toISOString(),
    day,
    today: dayCounts(records, day, t, mails ? mails[0]! : null, !!d.verify),
    yesterday: dayCounts(records, before, t, mails ? mails[1]! : null, !!d.verify),
    waitingCap: cap ? cap.waiting : null,
    mail,
    paused,
    alerts: {
      autoCap: cap?.reached === true,
      verifyCap: !!d.verify && !!mails && mails[0]! >= d.verify.maxPerDay,
      mailDay80: !!mail && at80(mail.dayUsed, mail.dayLimit),
      mail30d80: !!mail && at80(mail.d30Used, mail.d30Limit),
      verifyKey: keyBad,
    },
  };
}

export async function writeSummary(d: SummaryDeps): Promise<void> {
  await replaceJson(d.storeDir, SUMMARY_FILE, await collectSummary(d));
}
