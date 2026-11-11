/**
 * TEST ONLY (Sprint 23B/23C): a stand-in for the root administration helper, for the browser
 * tests of the owner's administration. The services are REAL: the admin service
 * (runtime/admin/accounts.ts: the owner check, CSRF, limits, validation, the spool, results and
 * views), served here on its own port (the preview proxies `/admin-api` to it), and the Session
 * Host's report routes. This module plays the helper: it answers spooled requests from an
 * in-memory registry and regenerates the two views. The admin service's live-session count
 * comes from the fake Session Host (`capacity`).
 *
 * Admin app: it also plays the ops side's two read-only views the admin service serves to the
 * TBI Admin app: the usage exporter's `usage/usage.json` (synthetic activity of the seeded
 * testers over the last 30 Israel days, relative to now) and the helper's `view/audit.json`
 * (seeded lines, plus one per request it answers).
 *
 * Registry addresses use example.invalid only. Subjects: the owner is `e2e-owner`; `e2e-user`
 * (the default test identity) is an ordinary tester, so the routine tests never see the entry.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AccessView, deriveEmailTag } from '../../../runtime/identity/access.js';
import { derivePrincipal } from '../../../runtime/identity/principal.js';
import { AdminSpool, DEFAULT_ADMIN, createAdminServer } from '../../../runtime/admin/accounts.js';
import { AdminViews, todayIn, viewPathsFromEnv } from '../../../runtime/admin/views.js';
import { E2E_IDENTITY } from './identity.js';
import { ownedTempDir } from './temp-dirs.js';

export const OWNER_SUBJECT = 'e2e-owner';
export const OWNER_EMAIL = 'owner@example.invalid';
const CAP = 30; // owner 2026-11-04 (Phase C)

interface Rec {
  email: string;
  sub: string | null;
  class: 'owner' | 'alpha_tester';
  status: 'authorized' | 'revoked' | 'pending';
  dateAdded: string;
  /** Phase C: private display name; gate sign-ins (first, last, count); the host's last sighting. */
  name: string | null;
  firstSignIn: string | null;
  lastSignIn: string | null;
  signIns: number;
  lastSeen: string | null;
  statusUpdated: string | null;
}

const target = (email: string) =>
  `t_${createHash('sha256').update(`account|${email}`).digest('base64url').slice(0, 16)}`;
const mask = (email: string) => {
  const at = email.indexOf('@');
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
};

const rec = (p: Partial<Rec> & Pick<Rec, 'email'>): Rec => ({
  sub: null,
  class: 'alpha_tester',
  status: 'authorized',
  dateAdded: '2026-10-01',
  name: null,
  firstSignIn: null,
  lastSignIn: null,
  signIns: 0,
  lastSeen: null,
  statusUpdated: null,
  ...p,
});

function seed(): Rec[] {
  return [
    rec({
      email: OWNER_EMAIL,
      sub: OWNER_SUBJECT,
      class: 'owner',
      dateAdded: '2026-09-25',
      name: 'Owner',
      firstSignIn: '2026-09-25T09:00:00.000001Z',
      lastSignIn: '2026-10-29T08:12:00.000001Z',
      signIns: 41,
    }),
    rec({
      email: 'tester.one@example.invalid',
      sub: 'e2e-user',
      dateAdded: '2026-10-01',
      name: 'Alex T.',
      firstSignIn: '2026-10-01T17:05:00.000001Z',
      lastSignIn: '2026-11-02T15:07:20.000001Z',
      signIns: 7,
      lastSeen: '2026-11-04T15:00:00Z',
    }),
    rec({ email: 'tester.two@example.invalid', sub: 'e2e-tester', dateAdded: '2026-10-05' }),
    rec({
      email: 'former@example.invalid',
      sub: 'e2e-former',
      status: 'revoked',
      dateAdded: '2026-10-02',
      name: 'בודקת ל.',
      firstSignIn: '2026-10-03T07:00:00.000001Z',
      lastSignIn: '2026-10-20T07:00:00.000001Z',
      signIns: 3,
      statusUpdated: '2026-11-04T12:00:00Z',
    }),
  ];
}

/** Israel day `n` days before today. */
const dayAgo = (n: number) => {
  const today = todayIn('Asia/Jerusalem', Date.now());
  const ms = Date.parse(`${today}T12:00:00Z`) - n * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
};

/** Synthetic usage: Alex every other day, tester two on a few days, some unmatched activity. */
function usageFile(): string {
  const alex = target('tester.one@example.invalid');
  const two = target('tester.two@example.invalid');
  const former = target('former@example.invalid');
  const zero = { signIns: 0, builds: 0, prebuilt: 0, runs: 0, simSeconds: 0, refusals: 0 };
  const days: Record<string, Record<string, typeof zero>> = {};
  const put = (n: number, t: string, m: Partial<typeof zero>) =>
    ((days[dayAgo(n)] ??= {})[t] = { ...zero, ...m });
  for (let n = 28; n >= 0; n -= 2)
    put(n, alex, { signIns: 1, builds: 2, runs: 3, simSeconds: 600 });
  // Today: Alex 2 sign-ins, 4 builds, 1 prebuilt, 5 runs, 15 simulated minutes, 1 refusal.
  put(0, alex, { signIns: 2, builds: 4, prebuilt: 1, runs: 5, simSeconds: 900, refusals: 1 });
  put(0, two, { signIns: 1, runs: 2, simSeconds: 120 });
  put(3, two, { builds: 1, runs: 1, simSeconds: 60 });
  put(20, former, { signIns: 1, runs: 1, simSeconds: 30 });
  put(0, 'unmatched', { refusals: 2 });
  return JSON.stringify({
    v: 1,
    generated: new Date().toISOString(),
    tz: 'Asia/Jerusalem',
    from: dayAgo(29),
    days,
    lastActivity: {
      [alex]: new Date(Date.now() - 3600_000).toISOString(),
      [two]: new Date(Date.now() - 7200_000).toISOString(),
      [former]: `${dayAgo(20)}T08:00:00Z`,
    },
  });
}

interface AuditLine {
  at: string;
  action: string;
  target: string | null;
  result: string;
  corr: string;
  count?: number;
}
const seedAudit = (): AuditLine[] => [
  {
    at: `${dayAgo(1)}T08:00:00Z`,
    action: 'disable',
    target: target('former@example.invalid'),
    result: 'done',
    corr: 'seed-2',
  },
  {
    at: `${dayAgo(2)}T07:00:00Z`,
    action: 'sign_ins',
    target: null,
    result: 'ok',
    corr: 'seed-1',
    count: 3,
  },
];

export function startFakeAdmin(capacity: () => { live: number; max: number }) {
  const dir = ownedTempDir('tbi-e2e-admin-');
  for (const d of ['spool', 'results', 'view', 'observations']) mkdirSync(join(dir, d));
  mkdirSync(join(dir, 'usage'));
  let registry = seed();
  let audit = seedAudit();
  let views = { usage: true, audit: true };
  const writeHistory = () => {
    const usage = join(dir, 'usage', 'usage.json');
    const auditFile = join(dir, 'view', 'audit.json');
    if (views.usage) writeFileSync(usage, usageFile());
    else rmSync(usage, { force: true });
    if (views.audit)
      writeFileSync(
        auditFile,
        JSON.stringify({ v: 1, generated: new Date().toISOString(), entries: audit.slice(0, 500) }),
      );
    else rmSync(auditFile, { force: true });
  };
  let hold = false;
  let ownerRecorded = true;
  let seq = 0;

  const principal = (sub: string | null) => (sub ? derivePrincipal(E2E_IDENTITY, sub) : null);
  const writeViews = () => {
    seq++;
    const live = registry.filter((r) => r.status !== 'revoked');
    const owner = registry.find((r) => r.class === 'owner')!;
    writeFileSync(
      join(dir, 'view', 'access.json'),
      JSON.stringify({
        v: 1,
        generated: new Date().toISOString(),
        seq,
        owner: {
          principal: ownerRecorded ? principal(owner.sub) : null,
          emailTag: deriveEmailTag(E2E_IDENTITY, owner.email),
        },
        authorized: {
          principals: live
            .filter((r) => r.sub && (r.class !== 'owner' || ownerRecorded))
            .map((r) => principal(r.sub)),
          emailTags: live.map((r) => deriveEmailTag(E2E_IDENTITY, r.email)),
        },
        revoked: {
          principals: registry
            .filter((r) => r.status === 'revoked' && r.sub)
            .map((r) => principal(r.sub)),
          emailTags: registry
            .filter((r) => r.status === 'revoked')
            .map((r) => deriveEmailTag(E2E_IDENTITY, r.email)),
        },
      }),
    );
    writeFileSync(
      join(dir, 'view', 'accounts.json'),
      JSON.stringify({
        v: 1,
        generated: new Date().toISOString(),
        cap: CAP,
        authorizedTesters: registry.filter(
          (r) => r.class === 'alpha_tester' && r.status === 'authorized',
        ).length,
        owner: 1,
        accounts: registry.map((r) => ({
          target: target(r.email),
          masked: mask(r.email),
          class: r.class,
          status: r.status,
          dateAdded: r.dateAdded,
          googleIdRecorded: r.sub !== null && (r.class !== 'owner' || ownerRecorded),
          ...(r.name ? { displayName: r.name } : {}),
          firstSignIn: r.firstSignIn,
          lastSignIn: r.lastSignIn,
          signIns: r.signIns,
          lastSeen: r.lastSeen,
          statusUpdated: r.statusUpdated,
        })),
        warnings: [
          {
            target: target('tester.two@example.invalid'),
            kind: 'identity_mismatch',
            first: '2026-10-27T10:00:00Z',
            last: '2026-10-28T21:15:00Z',
            count: 2,
          },
        ],
      }),
    );
  };

  let current: { action: string; target: string | null } = { action: 'refused', target: null };
  const answer = (id: string, code: string, extra: Record<string, unknown> = {}) => {
    audit.unshift({
      at: new Date().toISOString(),
      action: code === 'done' ? current.action : 'refused',
      target: (extra.target as string | undefined) ?? current.target,
      result: code,
      corr: id.slice(-8),
    });
    writeHistory();
    writeFileSync(
      join(dir, 'results', `${id}.json`),
      JSON.stringify({
        v: 1,
        id,
        ok: code === 'done',
        code,
        at: new Date().toISOString(),
        ...extra,
      }),
    );
  };

  const processSpool = () => {
    if (hold) return;
    for (const name of readdirSync(join(dir, 'spool')).filter((n) => n.endsWith('.json'))) {
      const path = join(dir, 'spool', name);
      let req: {
        id: string;
        actor: string;
        action: string;
        email?: string;
        target?: string;
        display_name?: string;
      };
      try {
        req = JSON.parse(readFileSync(path, 'utf8')) as typeof req;
      } finally {
        rmSync(path, { force: true });
      }
      current = {
        action: req.action,
        target: req.target ?? (req.email ? target(req.email) : null),
      };
      const owner = registry.find((r) => r.class === 'owner')!;
      if (!ownerRecorded || req.actor !== principal(owner.sub)) {
        answer(req.id, 'forbidden');
        continue;
      }
      const testers = () =>
        registry.filter((r) => r.class === 'alpha_tester' && r.status === 'authorized').length;
      if (req.action === 'add') {
        const email = req.email!;
        if (registry.some((r) => r.email === email)) answer(req.id, 'exists');
        else if (testers() >= CAP) answer(req.id, 'cap_reached');
        else {
          registry.push(
            rec({
              email,
              status: 'pending',
              dateAdded: new Date().toISOString().slice(0, 10),
              name: req.display_name ?? null,
            }),
          );
          answer(req.id, 'done', { target: target(email), masked: mask(email), backup: 'e2e' });
        }
      } else {
        const found = registry.find((r) => target(r.email) === req.target);
        if (!found) answer(req.id, 'unknown_target');
        else if (req.action === 'rename') {
          found.name = req.display_name ?? found.name;
          answer(req.id, 'done', { target: req.target, masked: mask(found.email), backup: 'e2e' });
        } else if (found.class === 'owner') answer(req.id, 'last_owner');
        else if (req.action === 'reactivate' && testers() >= CAP) answer(req.id, 'cap_reached');
        else {
          found.status =
            req.action === 'disable' ? 'revoked' : found.sub ? 'authorized' : 'pending';
          found.statusUpdated = new Date().toISOString();
          answer(req.id, 'done', { target: req.target, masked: mask(found.email), backup: 'e2e' });
        }
      }
      writeViews();
      access.reload();
    }
  };

  writeViews();
  writeHistory();
  const access = new AccessView(join(dir, 'view', 'access.json'), { pollMs: 1000 }).start();
  const spool = new AdminSpool({ ...DEFAULT_ADMIN, dir, resultWaitMs: 2000, pollMs: 50 });
  setInterval(processSpool, 100).unref();
  const newService = () =>
    createAdminServer(E2E_IDENTITY, {
      access,
      spool,
      capacity: async () => capacity(),
      views: new AdminViews(viewPathsFromEnv(dir, {})),
    });
  let service = newService();

  return {
    dir,
    access,
    /** The admin service's request handler (a fresh one after each reset: fresh rate windows). */
    handle: (req: IncomingMessage, res: ServerResponse) => service.emit('request', req, res),
    reset() {
      service = newService();
      registry = seed();
      audit = seedAudit();
      views = { usage: true, audit: true };
      writeHistory();
      hold = false;
      ownerRecorded = true;
      for (const d of ['spool', 'results'])
        for (const n of readdirSync(join(dir, d))) rmSync(join(dir, d, n), { force: true });
      writeViews();
      access.reload();
    },
    /** Keep requests unanswered (the 202 path); answer them once released. */
    hold(on: boolean) {
      hold = on;
    },
    /** Phase C: add synthetic authorized testers until `n` hold a place (the cap tests). */
    fill(n: number) {
      for (
        let i = 0;
        registry.filter((r) => r.class === 'alpha_tester' && r.status === 'authorized').length < n;
        i++
      )
        registry.push(rec({ email: `filler${String(i).padStart(2, '0')}@example.invalid` }));
      writeViews();
      access.reload();
    },
    /** Admin app: make the usage history and the audit view unavailable (or available again). */
    history(on: { usage: boolean; audit: boolean }) {
      views = on;
      writeHistory();
    },
    /** The owner's Google id not yet recorded: owner by email tag, privileged actions refused. */
    ownerUnrecorded() {
      ownerRecorded = false;
      writeViews();
      access.reload();
    },
  };
}
