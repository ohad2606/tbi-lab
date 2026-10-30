/**
 * Run tickets (Sprint 8, D-S8-4): the build service's short-lived, MAC'd statement "this principal
 * may run this artifact now, and the firmware declares these features". Issued by a lease (which
 * requires a grant); verified by the Session Host before it creates a session, so that neither a
 * sha256 alone nor a browser-supplied feature list is ever trusted.
 *
 *   <base64url(JSON payload)>.<base64url(HMAC-SHA256(key, payload))>
 *
 * The key is shared only by the two services (a root-owned file readable by their group).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isPrincipal, type Principal } from './principal.js';

/**
 * What the build found in the firmware (server-side analysis, Sprint 7). `null` for images that
 * were not analysed (Advanced prebuilt, reference images): nothing is declared for them.
 */
export interface TicketFeatures {
  internalPull: number[];
  gpioInterrupt: number[];
  restart: boolean;
  unsupported: string[];
  /**
   * Sprint 12 (ADR-011 §5), additive: runtime bridge capabilities the firmware needs (for
   * example `i2c` for `Wire`). Absent in tickets from earlier build services. The Session Host
   * refuses the session at the bridge handshake if the runtime does not announce every one.
   */
  requires?: string[];
  /**
   * Sprint 25 (Runtime v5, `input-read`), additive: the GPIOs the program may read as inputs and
   * whether a read could not be resolved to a pin (the host then watches every wired pad).
   */
  inputReads?: { pins: number[]; unresolved: boolean };
}

export interface RunTicket {
  v: 1;
  principal: Principal;
  sha256: string;
  features: TicketFeatures | null;
  /** Expiry, ms since the epoch. */
  exp: number;
}

export const loadTicketKey = (file: string): Buffer => {
  const key = readFileSync(file);
  if (key.length < 32) throw new Error('ticket key must be at least 32 bytes');
  return key;
};

const mac = (key: Buffer, payload: string) =>
  createHmac('sha256', key).update(`tbi-run-ticket|${payload}`).digest();

export function signTicket(key: Buffer, t: RunTicket): string {
  const payload = Buffer.from(JSON.stringify(t)).toString('base64url');
  return `${payload}.${mac(key, payload).toString('base64url')}`;
}

const ints = (v: unknown) =>
  Array.isArray(v) && v.length <= 64 && v.every((n) => Number.isInteger(n) && n >= 0 && n < 64);

function validFeatures(f: unknown): f is TicketFeatures | null {
  if (f === null) return true;
  if (typeof f !== 'object') return false;
  const o = f as Record<string, unknown>;
  return (
    ints(o.internalPull) &&
    ints(o.gpioInterrupt) &&
    typeof o.restart === 'boolean' &&
    Array.isArray(o.unsupported) &&
    o.unsupported.length <= 64 &&
    o.unsupported.every((s) => typeof s === 'string' && s.length <= 64) &&
    (o.requires === undefined ||
      (Array.isArray(o.requires) &&
        o.requires.length <= 16 &&
        o.requires.every((s) => typeof s === 'string' && /^[a-z0-9-]{1,32}$/.test(s)))) &&
    (o.inputReads === undefined ||
      (typeof o.inputReads === 'object' &&
        o.inputReads !== null &&
        ints((o.inputReads as Record<string, unknown>).pins) &&
        typeof (o.inputReads as Record<string, unknown>).unresolved === 'boolean'))
  );
}

/** The ticket if its MAC, shape and expiry are all valid; otherwise null (never a reason). */
export function verifyTicket(key: Buffer, token: unknown, now = Date.now()): RunTicket | null {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  const want = mac(key, payload);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let t: RunTicket;
  try {
    t = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as RunTicket;
  } catch {
    return null;
  }
  if (
    t?.v !== 1 ||
    !isPrincipal(t.principal) ||
    typeof t.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(t.sha256) ||
    typeof t.exp !== 'number' ||
    !validFeatures(t.features)
  )
    return null;
  if (t.exp <= now) return null;
  return t;
}
