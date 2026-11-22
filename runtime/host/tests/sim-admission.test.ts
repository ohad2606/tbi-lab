/**
 * TBI-018 pre-s3d: the Session Host's handling of a SimHostAdapter admission result. Not wired into
 * POST /sessions yet (s3d); this is the exhaustive mapping the wiring will use. A 'refused' result can
 * never fall through to a start, every refusal reason has a user-safe message key that exists in EN
 * and HE, and internal reasons never leak to the user.
 */
import { describe, expect, it } from 'vitest';
import { MESSAGE_KEY, limitError, type LimitCode } from '../../plans/limits.js';
import { MESSAGES, renderLimit } from '../../plans/messages.js';
import type { HostAdmit } from '../../plans/simhost.js';
import { simAdmissionResponse, simRefusal } from '../simAdmission.js';

const ALL_CODES = Object.keys(MESSAGE_KEY) as LimitCode[];
const refused = (code: LimitCode, params: Record<string, string | number> = {}): HostAdmit => ({
  metered: true,
  decision: 'refused',
  error: limitError(code, params),
  dropped: [],
});
const PARAMS = { date: '01.12.2026', n: 3 };

describe('Session Host: sim admission result mapping (pre-s3d)', () => {
  it('metering off -> unmetered (the host goes on exactly as today)', () => {
    expect(simAdmissionResponse({ metered: false })).toEqual({ kind: 'unmetered' });
  });

  it('start and queued map to start / queued with the queue position', () => {
    expect(
      simAdmissionResponse({
        metered: true,
        decision: 'start',
        sessionId: 's1',
        plan: 'free',
        remainingMs: 60_000,
        dropped: [],
      }),
    ).toEqual({ kind: 'start', sessionId: 's1', plan: 'free', remainingMs: 60_000 });
    const q = simAdmissionResponse({
      metered: true,
      decision: 'queued',
      position: 2,
      status: limitError('queue', { n: 2 }),
      dropped: [],
    });
    expect(q).toEqual({
      kind: 'queued',
      status: 202,
      position: 2,
      body: { code: 'queue', messageKey: 'limit.sim.queue', params: { n: 2 } },
    });
  });

  it('every refusal reason is refused (never a start) with a key that renders in EN and HE', () => {
    for (const c of ALL_CODES) {
      const r = simAdmissionResponse(refused(c, PARAMS));
      expect(r.kind, c).toBe('refused');
      if (r.kind !== 'refused') continue;
      expect(r.cause).toBe(c);
      expect([400, 403, 409, 429, 503]).toContain(r.status);
      for (const lang of ['en', 'he'] as const) {
        expect(MESSAGES[lang][r.body.messageKey], `${c} ${lang}`).toBeTypeOf('string');
        expect(() =>
          renderLimit(lang, {
            code: r.body.code,
            messageKey: r.body.messageKey,
            params: r.body.params,
          }),
        ).not.toThrow();
      }
    }
  });

  it('sim limits keep their own key and only the params their text needs', () => {
    const own: [LimitCode, string, Record<string, string | number>][] = [
      ['minutes_out', 'limit.sim.minutes_out', { date: PARAMS.date }],
      ['minutes_out_free', 'limit.sim.minutes_out_free', { date: PARAMS.date }],
      ['sim_daily', 'limit.sim.daily', {}],
      ['sim_concurrent', 'limit.sim.concurrent', {}],
      ['sim_cooldown', 'limit.sim.cooldown', { n: PARAMS.n }],
      ['queue_full', 'limit.sim.queue_full', {}],
      ['queue_timeout', 'limit.sim.queue_timeout', {}],
      ['queue_vanished', 'limit.sim.queue_timeout', {}],
    ];
    for (const [c, key, params] of own) {
      const r = simAdmissionResponse(refused(c, PARAMS));
      expect(r.kind === 'refused' && r.body, c).toEqual({
        code: c === 'queue_vanished' ? 'queue_timeout' : c,
        messageKey: key,
        params,
      });
      expect(r.kind === 'refused' && r.status).toBe(429);
    }
  });

  it('internal and non-sim reasons become limit.system.unavailable with no params (nothing leaks)', () => {
    const internal: LimitCode[] = [
      'system_unavailable',
      'invalid_principal',
      'invalid_request',
      'invalid_state',
      'lease_lost',
      'queue',
      'credits_out',
      'credits_out_free',
      'daily',
      'rate',
      'too_long',
      'global_off',
      'deep_not_in_plan',
      'pack_needs_plan',
    ];
    for (const c of internal) {
      const r = simAdmissionResponse(refused(c, PARAMS));
      expect(r.kind === 'refused' && r.body, c).toEqual({
        code: 'system_unavailable',
        messageKey: 'limit.system.unavailable',
        params: {},
      });
    }
    expect(simRefusal('system_unavailable').status).toBe(503);
    expect(simRefusal('invalid_principal').status).toBe(403);
    expect(simRefusal('invalid_request').status).toBe(400);
    expect(simRefusal('invalid_state').status).toBe(409);
    expect(simRefusal('credits_out').status).toBe(503);
  });

  it('a sim limit whose required param is missing fails closed to system_unavailable', () => {
    const r = simAdmissionResponse(refused('minutes_out', {}));
    expect(r.kind === 'refused' && r.body.code).toBe('system_unavailable');
    expect(r.kind === 'refused' && r.cause).toBe('minutes_out');
  });

  it('an unknown decision, an unknown code or a malformed result never starts (fail closed)', () => {
    const bad: unknown[] = [
      { metered: true, decision: 'maybe', dropped: [] },
      { metered: true, decision: 'refused', error: { code: 'nope', messageKey: null, params: {} } },
      { metered: true, decision: 'refused' },
      { metered: true, decision: 'start' },
      {
        metered: true,
        decision: 'queued',
        position: Number.NaN,
        status: limitError('queue', { n: 1 }),
      },
      { metered: 'yes' },
      null,
      undefined,
    ];
    for (const b of bad) {
      const r = simAdmissionResponse(b as HostAdmit);
      expect(r.kind, JSON.stringify(b)).toBe('refused');
      expect(r.kind === 'refused' && r.status).toBe(503);
      expect(r.kind === 'refused' && r.body.messageKey).toBe('limit.system.unavailable');
    }
  });
});
