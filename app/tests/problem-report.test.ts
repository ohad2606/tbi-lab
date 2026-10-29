/** Sprint 14: the "Report a problem" dialog's logic (validation, request, outcomes, transitions). */
import { describe, expect, it, vi } from 'vitest';
import { parseEnabled } from '../src/deployment.js';
import {
  MAX_DESCRIPTION_CHARS,
  buildRequest,
  descriptionLength,
  emptyDraft,
  interpretResponse,
  nextPhase,
  sendReport,
  validateDraft,
  waitMinutes,
  type ReportDraft,
  type ReportPhase,
  MAX_COMPONENT_NAME_CHARS,
  deviceClass,
} from '../src/ui/problemReport.js';
import { validateReport } from '../../runtime/host/reportProtocol.js';
import type { BuildInfo } from '../src/buildInfo.js';
import type { SimState } from '../src/sim/controller.js';
import { emptyView } from '../src/runtime/view.js';

const draft = (over: Partial<ReportDraft> = {}): ReportDraft => ({
  ...emptyDraft(),
  description: 'The LED never lights.',
  category: 'simulation',
  blocking: false,
  ...over,
});
const BUILD: BuildInfo = {
  product: 'TBI Lab',
  version: '0.14.0-alpha.1',
  environment: 'alpha',
  commit: 'c'.repeat(40),
  shortCommit: 'c'.repeat(7),
  builtAt: '2026-10-15T00:00:00Z',
  dirty: false,
};
const ctx = (sim: SimState = { status: 'stopped' }) => ({
  locale: 'he',
  view: 'editor' as const,
  build: BUILD,
  sim,
});

describe('deployment flag', () => {
  it('only an explicit 1 enables reports', () => {
    expect(parseEnabled('1')).toBe(true);
    expect(parseEnabled(' 1 ')).toBe(true);
    for (const v of [undefined, '', '0', 'true', 'yes', 1, true])
      expect(parseEnabled(v)).toBe(false);
  });
});

describe('draft validation', () => {
  it('needs a description and an area', () => {
    expect(validateDraft(emptyDraft())).toEqual({
      description: 'required',
      category: 'required',
    });
    expect(validateDraft(draft({ description: ' \n\t ' })).description).toBe('required');
    expect(validateDraft(draft())).toEqual({});
  });

  it('counts code points of the text as it will be sent, and caps them', () => {
    expect(descriptionLength('  שלום  ')).toBe(4);
    expect(descriptionLength('🔌🔌')).toBe(2); // not UTF-16 units
    expect(descriptionLength('a\u0000b')).toBe(2); // controls are not sent
    expect(validateDraft(draft({ description: 'x'.repeat(MAX_DESCRIPTION_CHARS) }))).toEqual({});
    expect(
      validateDraft(draft({ description: 'x'.repeat(MAX_DESCRIPTION_CHARS + 1) })).description,
    ).toBe('too_long');
  });
});

describe('request', () => {
  it('carries the draft and the disclosed app facts only, accepted by the host contract', () => {
    const req = buildRequest(draft({ description: '  נורה לא נדלקת\r\n', blocking: true }), ctx());
    expect(req).toEqual({
      description: 'נורה לא נדלקת',
      category: 'simulation',
      blocking: true,
      locale: 'he',
      view: 'editor',
      app: { version: BUILD.version, commit: BUILD.commit },
      sim: { status: 'stopped' },
    });
    expect(validateReport(req).ok).toBe(true);
  });

  it('names the ESP32 session and the failure code, never project content', () => {
    const runtime = {
      ...emptyView('board.esp32_devkitc_wroom32', 'f'.repeat(64)),
      sessionId: 'a'.repeat(32),
    };
    const req = buildRequest(
      draft(),
      ctx({ status: 'failed', failure: { kind: 'runtime', code: 'runtime_crashed' }, runtime }),
    );
    expect(req.sessionId).toBe('a'.repeat(32));
    expect(req.sim).toEqual({ status: 'failed', code: 'runtime_crashed' });
    const text = JSON.stringify(req);
    expect(text).not.toContain('board.esp32');
    expect(text).not.toContain('f'.repeat(64));
    expect(validateReport(req).ok).toBe(true);
    // Component ids of a plan failure are project data: only the code is sent.
    const plan = buildRequest(
      draft(),
      ctx({
        status: 'failed',
        failure: { kind: 'mcu', code: 'mcu_build_required', components: ['U1'] },
      }),
    );
    expect(JSON.stringify(plan)).not.toContain('U1');
    expect(plan.sim).toEqual({ status: 'failed', code: 'mcu_build_required' });
  });

  it('without a build identity, no app field', () => {
    expect(buildRequest(draft(), { ...ctx(), build: null }).app).toBeUndefined();
  });
});

describe('server answers', () => {
  it('confirmed only by a 201 with a well-formed id', () => {
    expect(interpretResponse(201, { id: '7K3M-9QX2-WDAB' }, null)).toEqual({
      ok: true,
      id: '7K3M-9QX2-WDAB',
    });
    for (const body of [null, {}, { id: 'abc' }, { id: 42 }, '<html>'])
      expect(interpretResponse(201, body, null)).toEqual({ ok: false, error: { code: 'network' } });
    expect(interpretResponse(200, { id: '7K3M-9QX2-WDAB' }, null).ok).toBe(false);
  });

  it('maps refusals to what the tester can do', () => {
    expect(interpretResponse(429, { error: 'rate_limited', retryAfterS: 90 }, '90')).toEqual({
      ok: false,
      error: { code: 'rate_limited', retryAfterS: 90 },
    });
    expect(interpretResponse(429, { retryAfterS: 30 }, null)).toEqual({
      ok: false,
      error: { code: 'rate_limited', retryAfterS: 30 },
    });
    expect(interpretResponse(503, { error: 'reports_disabled' }, null)).toEqual({
      ok: false,
      error: { code: 'unavailable' },
    });
    expect(interpretResponse(401, null, null)).toEqual({
      ok: false,
      error: { code: 'signed_out' },
    });
    for (const s of [400, 413, 415])
      expect(interpretResponse(s, null, null)).toEqual({ ok: false, error: { code: 'rejected' } });
    for (const s of [null, 500, 502, 404])
      expect(interpretResponse(s, null, null)).toEqual({ ok: false, error: { code: 'network' } });
    expect(waitMinutes(90)).toBe(2);
    expect(waitMinutes(null)).toBe(1);
    expect(waitMinutes(1)).toBe(1);
  });

  it('sendReport posts JSON to /runtime/reports; a network failure is an error, not a confirmation', async () => {
    const ok = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: '7K3M-9QX2-WDAB' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const req = buildRequest(draft(), ctx());
    expect(await sendReport(req, ok as unknown as typeof fetch)).toEqual({
      ok: true,
      id: '7K3M-9QX2-WDAB',
    });
    const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/runtime/reports');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(req);
    const down = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await sendReport(req, down as unknown as typeof fetch)).toEqual({
      ok: false,
      error: { code: 'network' },
    });
    const html = vi.fn(async () => new Response('<html>', { status: 201 }));
    expect((await sendReport(req, html as unknown as typeof fetch)).ok).toBe(false);
  });
});

describe('dialog transitions', () => {
  const editing: ReportPhase = { kind: 'editing', error: null };

  it('editing -> sending only with a valid draft; no second send while one is in flight', () => {
    expect(nextPhase(editing, { type: 'send', draft: emptyDraft() })).toBe(editing);
    const sending = nextPhase(editing, { type: 'send', draft: draft() });
    expect(sending).toEqual({ kind: 'sending' });
    expect(nextPhase(sending, { type: 'send', draft: draft() })).toBe(sending);
  });

  it('sending -> sent with the id, or back to editing with the error', () => {
    const sending: ReportPhase = { kind: 'sending' };
    expect(
      nextPhase(sending, { type: 'result', result: { ok: true, id: '7K3M-9QX2-WDAB' } }),
    ).toEqual({
      kind: 'sent',
      id: '7K3M-9QX2-WDAB',
    });
    expect(
      nextPhase(sending, { type: 'result', result: { ok: false, error: { code: 'unavailable' } } }),
    ).toEqual({ kind: 'editing', error: { code: 'unavailable' } });
    // A late result never changes a dialog that is not sending.
    const sent: ReportPhase = { kind: 'sent', id: '7K3M-9QX2-WDAB' };
    expect(
      nextPhase(sent, { type: 'result', result: { ok: false, error: { code: 'network' } } }),
    ).toBe(sent);
  });

  it('an error keeps the draft: retry sends the same text', () => {
    const d = draft({ description: 'keep me' });
    let phase = nextPhase({ kind: 'editing', error: null }, { type: 'send', draft: d });
    phase = nextPhase(phase, { type: 'result', result: { ok: false, error: { code: 'network' } } });
    expect(phase).toEqual({ kind: 'editing', error: { code: 'network' } });
    expect(nextPhase(phase, { type: 'send', draft: d })).toEqual({ kind: 'sending' });
    expect(d.description).toBe('keep me');
  });
});

describe('Sprint 23B: kinds, component name and technical context', () => {
  it('only a bug report asks for an area; a component name has its own limit', () => {
    for (const kind of ['component', 'feature', 'general'] as const)
      expect(validateDraft(draft({ kind, category: null }))).toEqual({});
    expect(validateDraft(draft({ kind: 'bug', category: null }))).toEqual({ category: 'required' });
    expect(
      validateDraft(
        draft({ kind: 'component', component: 'x'.repeat(MAX_COMPONENT_NAME_CHARS + 1) }),
      ),
    ).toEqual({ component: 'too_long' });
    // The name of another kind is never checked (nor sent).
    expect(validateDraft(draft({ kind: 'feature', component: 'x'.repeat(500) }))).toEqual({});
  });

  it('builds requests the host accepts: other kinds file under `other`, without blocking', () => {
    const r = buildRequest(
      draft({ kind: 'component', category: 'build', blocking: true, component: ' KY-040\n ' }),
      ctx(),
    );
    expect(r).toMatchObject({
      kind: 'component',
      category: 'other',
      blocking: false,
      component: 'KY-040',
    });
    expect(validateReport(r).ok).toBe(true);
    const f = buildRequest(draft({ kind: 'feature', component: 'ignored' }), ctx());
    expect(f.component).toBeUndefined();
    expect(validateReport(f).ok).toBe(true);
    // A plain bug report without context is exactly the RC4 request.
    const bug = buildRequest(draft({ includeContext: false }), {
      ...ctx(),
      runtimeVersion: '0.23.0',
      device: 'desktop',
      projectId: 'prj_abc',
    });
    expect(Object.keys(bug).sort()).toEqual(
      ['app', 'blocking', 'category', 'description', 'locale', 'sim', 'view'].sort(),
    );
  });

  it('technical context: only when included, only validated values, never project content', () => {
    const r = buildRequest(draft({ kind: 'general' }), {
      ...ctx(),
      runtimeVersion: '0.23.0',
      device: 'tablet',
      projectId: 'prj_abc123',
    });
    expect(r.context).toEqual({ runtime: '0.23.0', device: 'tablet', projectId: 'prj_abc123' });
    expect(validateReport(r).ok).toBe(true);
    const odd = buildRequest(draft(), {
      ...ctx(),
      runtimeVersion: 'v 1; drop',
      projectId: 'My Project',
    });
    expect(odd.context).toBeUndefined();
    expect(JSON.stringify(r)).not.toMatch(/circuit|components|firmware/);
  });

  it('device class from the pointer only', () => {
    const m = (fine: boolean, coarse: boolean) => (q: string) =>
      q.includes('fine') ? fine : q.includes('coarse') ? coarse : false;
    expect(deviceClass(m(true, false))).toBe('desktop');
    expect(deviceClass(m(false, true))).toBe('tablet');
    expect(deviceClass(m(false, false))).toBe('other');
  });
});
