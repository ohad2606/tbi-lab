/**
 * ARC-MAILER (D-ARC-2): the mail queue shared by the admin service (the only writer) and the
 * separate mailer service (the only reader and sender). Design: docs/alpha/MAILER-DESIGN.md.
 *
 * One queue entry = one file `<key>.json` with `key = <template>-<request id>-g<generation>`.
 * The entry names an approved template and its recipient only: no subject, no body, no sender,
 * no URL, no secret. The mailer renders the approved text itself, so a compromised writer cannot
 * make us send arbitrary text: the only writer value that reaches the body is the first token of
 * `to.name`, and only when it is a plain letters-only first name (`greetingName` in
 * admin/signup/email.ts: letters, marks, hyphen, apostrophe; no `:` `/` `@` `.` digits, no `www`),
 * otherwise the generic greeting is used. So a writer cannot put a link or an address into the
 * text. Strictly schema-validated on BOTH sides, size-capped.
 *
 * The writer is write-only on the directory (mode 3730 in deployment: setgid, sticky, group
 * `wx`): it creates `.tmp-<random>` exclusively (0640), fsyncs it, then hard-links it to the
 * final name (fails with EEXIST instead of replacing: enqueueing the same key twice is a no-op)
 * and removes the temporary name. Nothing is ever overwritten.
 */
import { randomBytes } from 'node:crypto';
import { link, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { normalizeAddEmail } from '../admin/accounts.js';
import { REQUEST_ID_RE } from '../admin/common.js';
import { cleanText, NAME_MAX } from '../admin/signup/validate.js';

export const QUEUE_VERSION = 1;
/** Largest queue file the mailer accepts (and the writer produces). */
export const QUEUE_MAX_BYTES = 4096;
/** The mailer processes at most this many entries per directory listing (oldest names first). */
export const QUEUE_MAX_FILES = 500;
/** Owner resend generations per request: a new generation is a new idempotency key. */
export const QUEUE_MAX_GEN = 9;
/** Prefix of the writer's temporary files; the mailer ignores them (and removes stale ones). */
export const QUEUE_TMP_PREFIX = '.tmp-';

/** The only templates the mailer knows; each maps to owner-approved text in code. */
export const MAIL_TEMPLATES = ['signup-approval'] as const;
export type MailTemplate = (typeof MAIL_TEMPLATES)[number];

export interface QueueItem {
  v: 1;
  template: MailTemplate;
  /** The sign-up request id (ULID-like, REQUEST_ID_RE); never derived from the recipient. */
  id: string;
  /** 1 for the first send; an explicit owner resend after a dead letter uses the next one. */
  gen: number;
  to: { email: string; name: string; lang: 'he' | 'en' };
  /** Enqueue time (ms since epoch). */
  createdAt: number;
}

const ITEM_KEYS = ['v', 'template', 'id', 'gen', 'to', 'createdAt'];
const TO_KEYS = ['email', 'name', 'lang'];

/** `<template>-<id>-g<gen>`: the file name stem, the status ledger name and the provider idempotency key. */
export function itemKey(i: Pick<QueueItem, 'template' | 'id' | 'gen'>): string {
  return `${i.template}-${i.id}-g${i.gen}`;
}

/** A valid queue file name; groups: template, id, gen. */
export const QUEUE_NAME_RE = /^(signup-approval)-([0-9A-HJKMNP-TV-Z]{26})-g([1-9])\.json$/;
/** A valid key (the name without `.json`). */
export const QUEUE_KEY_RE = /^signup-approval-[0-9A-HJKMNP-TV-Z]{26}-g[1-9]$/;

function exactKeys(o: Record<string, unknown>, keys: string[]): boolean {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => Object.hasOwn(o, x));
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export type ParseResult = { ok: true; item: QueueItem } | { ok: false; reason: string };

/**
 * Strict validation of a parsed queue entry. Values must already be in canonical form (the
 * address normalised, the name cleaned): anything a sanitiser would change is refused, never
 * repaired, so what is sent is exactly what the writer validated.
 */
export function parseQueueItem(raw: unknown): ParseResult {
  const no = (reason: string): ParseResult => ({ ok: false, reason });
  if (!isObj(raw) || !exactKeys(raw, ITEM_KEYS)) return no('bad_shape');
  if (raw.v !== QUEUE_VERSION) return no('bad_version');
  if (!(MAIL_TEMPLATES as readonly unknown[]).includes(raw.template)) return no('bad_template');
  if (typeof raw.id !== 'string' || !REQUEST_ID_RE.test(raw.id)) return no('bad_id');
  if (!Number.isInteger(raw.gen) || (raw.gen as number) < 1 || (raw.gen as number) > QUEUE_MAX_GEN)
    return no('bad_gen');
  if (
    !Number.isSafeInteger(raw.createdAt) ||
    (raw.createdAt as number) <= 0 ||
    (raw.createdAt as number) > 8.64e15
  )
    return no('bad_time');
  const to = raw.to;
  if (!isObj(to) || !exactKeys(to, TO_KEYS)) return no('bad_shape');
  if (typeof to.email !== 'string' || normalizeAddEmail(to.email) !== to.email)
    return no('bad_email');
  if (typeof to.name !== 'string' || cleanText(to.name, NAME_MAX) !== to.name)
    return no('bad_name');
  if (to.lang !== 'he' && to.lang !== 'en') return no('bad_lang');
  return {
    ok: true,
    item: {
      v: 1,
      template: raw.template as MailTemplate,
      id: raw.id,
      gen: raw.gen as number,
      to: { email: to.email, name: to.name, lang: to.lang },
      createdAt: raw.createdAt as number,
    },
  };
}

export class QueueError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface QueueWriterIo {
  syncFile(fh: FileHandle): Promise<void>;
}
const defaultIo: QueueWriterIo = { syncFile: (fh) => fh.sync() };

/**
 * Admin side: enqueue one mail. Returns `queued`, or `already_queued` when an entry with the same
 * key is still waiting (the existing one is kept untouched). Throws QueueError(`invalid_<reason>`
 * | `too_large`) for an entry the mailer would refuse; fs errors are rethrown (callers map them with
 * `errorClass`). On any failure nothing is left behind.
 */
export async function enqueueMail(
  dir: string,
  item: QueueItem,
  io: QueueWriterIo = defaultIo,
): Promise<'queued' | 'already_queued'> {
  const text = JSON.stringify(item);
  // Validate exactly what will be read back (the JSON round trip), not the in-memory object.
  const back = parseQueueItem(JSON.parse(text));
  if (!back.ok) throw new QueueError(`invalid_${back.reason.replace(/^bad_/, '')}`);
  if (Buffer.byteLength(text, 'utf8') > QUEUE_MAX_BYTES) throw new QueueError('too_large');
  const tmp = join(dir, `${QUEUE_TMP_PREFIX}${randomBytes(8).toString('hex')}`);
  const fh = await open(tmp, 'wx', 0o640);
  try {
    try {
      await fh.chmod(0o640);
      await fh.writeFile(text, 'utf8');
      await io.syncFile(fh);
    } finally {
      await fh.close();
    }
    try {
      await link(tmp, join(dir, `${itemKey(item)}.json`));
      return 'queued';
    } catch (e) {
      if ((e as { code?: unknown }).code === 'EEXIST') return 'already_queued';
      throw e;
    }
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}
