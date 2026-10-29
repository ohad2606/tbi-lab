/**
 * TEST ONLY (Sprint 23B): a stand-in for the root administration helper, for the browser tests of
 * the owner's administration. The Session Host side is REAL (runtime/host/admin.ts: the owner
 * check, CSRF, limits, validation, the spool, results and views); this module plays the helper:
 * it answers spooled requests from an in-memory registry and regenerates the two views.
 *
 * Registry addresses use example.invalid only. Subjects: the owner is `e2e-owner`; `e2e-user`
 * (the default test identity) is an ordinary tester, so the routine tests never see the entry.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AccessView, deriveEmailTag } from '../../../runtime/identity/access.js';
import { derivePrincipal } from '../../../runtime/identity/principal.js';
import { AdminSpool, DEFAULT_ADMIN } from '../../../runtime/host/admin.js';
import { E2E_IDENTITY } from './identity.js';
import { ownedTempDir } from './temp-dirs.js';

export const OWNER_SUBJECT = 'e2e-owner';
export const OWNER_EMAIL = 'owner@example.invalid';
const CAP = 20;

interface Rec {
  email: string;
  sub: string | null;
  class: 'owner' | 'alpha_tester';
  status: 'authorized' | 'revoked' | 'pending';
  dateAdded: string;
  lastSignIn: string | null;
}

const target = (email: string) =>
  `t_${createHash('sha256').update(`account|${email}`).digest('base64url').slice(0, 16)}`;
const mask = (email: string) => {
  const at = email.indexOf('@');
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
};

function seed(): Rec[] {
  return [
    {
      email: OWNER_EMAIL,
      sub: OWNER_SUBJECT,
      class: 'owner',
      status: 'authorized',
      dateAdded: '2026-09-25',
      lastSignIn: '2026-10-29T08:12:00Z',
    },
    {
      email: 'tester.one@example.invalid',
      sub: 'e2e-user',
      class: 'alpha_tester',
      status: 'authorized',
      dateAdded: '2026-10-01',
      lastSignIn: '2026-10-28T19:40:00Z',
    },
    {
      email: 'tester.two@example.invalid',
      sub: 'e2e-tester',
      class: 'alpha_tester',
      status: 'authorized',
      dateAdded: '2026-10-05',
      lastSignIn: null,
    },
    {
      email: 'former@example.invalid',
      sub: 'e2e-former',
      class: 'alpha_tester',
      status: 'revoked',
      dateAdded: '2026-10-02',
      lastSignIn: null,
    },
  ];
}

export function startFakeAdmin() {
  const dir = ownedTempDir('tbi-e2e-admin-');
  for (const d of ['spool', 'results', 'view', 'observations']) mkdirSync(join(dir, d));
  let registry = seed();
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
          lastSignIn: r.lastSignIn,
          statusUpdated: null,
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

  const answer = (id: string, code: string, extra: Record<string, unknown> = {}) =>
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

  const processSpool = () => {
    if (hold) return;
    for (const name of readdirSync(join(dir, 'spool')).filter((n) => n.endsWith('.json'))) {
      const path = join(dir, 'spool', name);
      let req: { id: string; actor: string; action: string; email?: string; target?: string };
      try {
        req = JSON.parse(readFileSync(path, 'utf8')) as typeof req;
      } finally {
        rmSync(path, { force: true });
      }
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
          registry.push({
            email,
            sub: null,
            class: 'alpha_tester',
            status: 'pending',
            dateAdded: new Date().toISOString().slice(0, 10),
            lastSignIn: null,
          });
          answer(req.id, 'done', { target: target(email), masked: mask(email), backup: 'e2e' });
        }
      } else {
        const rec = registry.find((r) => target(r.email) === req.target);
        if (!rec) answer(req.id, 'unknown_target');
        else if (rec.class === 'owner') answer(req.id, 'last_owner');
        else if (req.action === 'reactivate' && testers() >= CAP) answer(req.id, 'cap_reached');
        else {
          rec.status = req.action === 'disable' ? 'revoked' : rec.sub ? 'authorized' : 'pending';
          answer(req.id, 'done', { target: req.target, masked: mask(rec.email), backup: 'e2e' });
        }
      }
      writeViews();
      access.reload();
    }
  };

  writeViews();
  const access = new AccessView(join(dir, 'view', 'access.json'), { pollMs: 1000 }).start();
  const spool = new AdminSpool({ ...DEFAULT_ADMIN, dir, resultWaitMs: 2000, pollMs: 50 });
  setInterval(processSpool, 100).unref();

  return {
    dir,
    access,
    spool,
    reset() {
      registry = seed();
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
    /** The owner's Google id not yet recorded: owner by email tag, privileged actions refused. */
    ownerUnrecorded() {
      ownerRecorded = false;
      writeViews();
      access.reload();
    },
  };
}
