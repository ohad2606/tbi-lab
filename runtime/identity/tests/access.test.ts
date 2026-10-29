/**
 * Sprint 23B: the authorization view (identity/access.ts): email tags, strict parsing, the owner
 * rule, reload on change and on a timer, fail closed.
 */
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccessView,
  accessViewFromEnv,
  decideAccess,
  deriveEmailTag,
  gateEmail,
  isAuthorized,
  isOwner,
  parseAccessView,
  type AccessViewData,
} from '../access.js';
import { TEST_IDENTITY, principalFor } from '../test-gate.js';

const A = principalFor('user-a');
const B = principalFor('user-b');
const tag = (e: string) => deriveEmailTag(TEST_IDENTITY, e);

function viewJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    generated: '2026-10-29T10:00:00Z',
    seq: 1,
    owner: { principal: A, emailTag: tag('owner@example.invalid') },
    authorized: { principals: [A], emailTags: [tag('owner@example.invalid')] },
    revoked: { principals: [], emailTags: [] },
    ...over,
  });
}

const dirs: string[] = [];
const views: AccessView[] = [];
afterEach(() => {
  views.splice(0).forEach((v) => v.stop());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'tbi-access-'));
  dirs.push(d);
  return d;
}
const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const req = (headers: Record<string, string | string[]>) =>
  ({ headers }) as unknown as IncomingMessage;

describe('email tags', () => {
  it('are e_ + 26 base64url characters, the same for any case and surrounding space', () => {
    const t = tag('TESTER@example.invalid ');
    expect(t).toMatch(/^e_[A-Za-z0-9_-]{26}$/);
    expect(t).toBe(tag('tester@example.invalid'));
    expect(t).not.toBe(tag('other@example.invalid'));
    // The tag is keyed: another key gives another tag (not a plain hash of the address).
    expect(
      deriveEmailTag({ ...TEST_IDENTITY, key: Buffer.alloc(32, 7) }, 'tester@example.invalid'),
    ).not.toBe(t);
  });

  it('a header that is not one plain address is no address', () => {
    expect(gateEmail('tester@example.invalid')).toBe('tester@example.invalid');
    expect(gateEmail('a@example.invalid, b@example.invalid')).toBeNull(); // repeated header
    expect(gateEmail('a@b@example.invalid')).toBeNull();
    expect(gateEmail('a\n@example.invalid')).toBeNull();
    expect(gateEmail('"a"@example.invalid')).toBeNull();
    expect(gateEmail('ä@example.invalid')).toBeNull();
    expect(gateEmail(['a@example.invalid'])).toBeNull();
    expect(gateEmail(`${'a'.repeat(65)}@example.invalid`)).toBeNull();
  });
});

describe('the view', () => {
  it('parses only the exact format', () => {
    expect(parseAccessView(viewJson())).not.toBeNull();
    for (const bad of [
      '',
      'null',
      '[]',
      viewJson({ v: 2 }),
      viewJson({ seq: -1 }),
      viewJson({ seq: '1' }),
      viewJson({ owner: { principal: 'p_short', emailTag: tag('x@example.invalid') } }),
      viewJson({ owner: { principal: null } }),
      viewJson({ authorized: { principals: ['tester@example.invalid'], emailTags: [] } }),
      viewJson({ authorized: { principals: [A] } }),
      viewJson({ revoked: null }),
    ])
      expect(parseAccessView(bad), bad).toBeNull();
    const nullOwner = parseAccessView(
      viewJson({ owner: { principal: null, emailTag: tag('owner@example.invalid') } }),
    );
    expect(nullOwner?.owner.principal).toBeNull();
  });

  it('deny wins: a revoked principal or a revoked email tag is refused whatever the other says', () => {
    const v = parseAccessView(
      viewJson({
        authorized: {
          principals: [A, B],
          emailTags: [tag('a@example.invalid'), tag('b@example.invalid')],
        },
        revoked: { principals: [A], emailTags: [tag('b@example.invalid')] },
      }),
    ) as AccessViewData;
    // Revoked principal, authorized tag.
    expect(isAuthorized(v, A, tag('a@example.invalid'))).toBe(false);
    expect(isAuthorized(v, A, null)).toBe(false);
    // Authorized principal, revoked tag.
    expect(isAuthorized(v, B, tag('b@example.invalid'))).toBe(false);
    expect(isAuthorized(v, null, tag('b@example.invalid'))).toBe(false);
    // Neither revoked: allowed.
    expect(isAuthorized(v, B, null)).toBe(true);
    expect(isAuthorized(v, B, tag('a@example.invalid'))).toBe(true);
  });

  it('authorizes by principal or by email tag; the owner by principal, by tag only while none is recorded', () => {
    const v = parseAccessView(
      viewJson({ authorized: { principals: [A], emailTags: [tag('pending@example.invalid')] } }),
    ) as AccessViewData;
    expect(isAuthorized(v, A, null)).toBe(true);
    expect(isAuthorized(v, B, null)).toBe(false);
    expect(isAuthorized(v, B, tag('pending@example.invalid'))).toBe(true);
    expect(isAuthorized(v, null, tag('other@example.invalid'))).toBe(false);
    expect(isOwner(v, A, null)).toBe(true);
    // The owner's address under another Google account is not the owner once a principal is recorded.
    expect(isOwner(v, B, tag('owner@example.invalid'))).toBe(false);
    const fresh = parseAccessView(
      viewJson({ owner: { principal: null, emailTag: tag('owner@example.invalid') } }),
    ) as AccessViewData;
    expect(isOwner(fresh, B, tag('owner@example.invalid'))).toBe(true);
    expect(isOwner(fresh, A, null)).toBe(false);
  });

  it('decideAccess: RC4 without a view; 401 / 503 / 403 / allowed with one', () => {
    const sub = { 'x-forwarded-user': 'user-a' };
    expect(decideAccess(req(sub), TEST_IDENTITY, null)).toMatchObject({ ok: true, principal: A });
    expect(decideAccess(req({}), TEST_IDENTITY, null)).toMatchObject({ ok: false, status: 401 });
    const d = tempDir();
    const file = join(d, 'access.json');
    const view = new AccessView(file);
    expect(decideAccess(req(sub), TEST_IDENTITY, view)).toMatchObject({
      ok: false,
      status: 503,
      error: 'access_view_unavailable',
    });
    writeFileSync(file, viewJson());
    view.reload();
    expect(decideAccess(req({}), TEST_IDENTITY, view)).toMatchObject({ status: 401 });
    expect(decideAccess(req(sub), TEST_IDENTITY, view)).toMatchObject({ ok: true });
    expect(decideAccess(req({ 'x-forwarded-user': 'user-b' }), TEST_IDENTITY, view)).toMatchObject({
      ok: false,
      status: 403,
      error: 'account_disabled',
    });
    // An address alone (no subject) is identity enough to be judged, not to own sessions.
    expect(
      decideAccess(req({ 'x-forwarded-email': 'owner@example.invalid' }), TEST_IDENTITY, view),
    ).toMatchObject({ ok: true, principal: null });
  });

  it('reloads on change (rename included) and on its timer; fails closed on a bad file', async () => {
    const d = tempDir();
    const file = join(d, 'access.json');
    writeFileSync(file, viewJson({ seq: 1 }));
    const seen: number[] = [];
    const view = new AccessView(file, { pollMs: 60_000 });
    views.push(view);
    view.onReload((v) => seen.push(v.seq));
    view.start();
    expect(view.current?.seq).toBe(1);
    // Atomic replacement, as the helper does it: the watch sees the rename.
    writeFileSync(join(d, 'access.json.tmp'), viewJson({ seq: 2 }));
    renameSync(join(d, 'access.json.tmp'), file);
    await until(() => view.current?.seq === 2);
    writeFileSync(file, '{"v":1,');
    await until(() => view.current === null);
    rmSync(file);
    await until(() => view.current === null);
    writeFileSync(file, viewJson({ seq: 3 }));
    await until(() => view.current?.seq === 3);
    expect(seen).toContain(3);
    expect(new AccessView(file, { pollMs: 3_600_000 }).pollMs).toBe(10_000); // at least every 10 s
  });

  it('the timer alone picks up a change when the directory cannot be watched', async () => {
    let text = viewJson({ seq: 1 });
    const view = new AccessView('/nonexistent-dir/access.json', { pollMs: 50, read: () => text });
    views.push(view);
    view.start();
    expect(view.current?.seq).toBe(1);
    text = viewJson({ seq: 9 });
    await until(() => view.current?.seq === 9);
    text = 'garbage';
    await until(() => view.current === null);
  });

  it('a throwing listener never changes the view in force', () => {
    const view = new AccessView('/x', { read: () => viewJson() });
    view.onReload(() => {
      throw new Error('listener');
    });
    expect(view.reload()).toBe(true);
    expect(view.current).not.toBeNull();
  });

  it('environment: off when unset, an absolute path otherwise', () => {
    expect(accessViewFromEnv({})).toBeNull();
    expect(accessViewFromEnv({ TBI_ACCESS_VIEW: '' })).toBeNull();
    expect(() => accessViewFromEnv({ TBI_ACCESS_VIEW: 'view/access.json' })).toThrow(/absolute/);
    expect(
      accessViewFromEnv({ TBI_ACCESS_VIEW: '/var/lib/tbi-admin/view/access.json' })?.path,
    ).toBe('/var/lib/tbi-admin/view/access.json');
  });
});
