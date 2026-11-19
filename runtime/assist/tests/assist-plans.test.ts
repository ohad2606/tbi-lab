/**
 * TBI-018 slice 2: the plans engine wired into the assist service (admit before the provider call,
 * settle on success, release on failure), behind metering.enabled. Mock provider only; no network.
 */
import { mkdtempSync } from 'node:fs';
import { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXPLAIN_CONTRACT,
  buildEngineeringContext,
  diagnose,
  type AssistProvider,
  type EngineeringContext,
} from '@tbi-lab/assist';
import { CASES } from '../../../packages/assist/eval/cases.js';
import { derivePrincipal } from '../../identity/principal.js';
import { testIdentity } from '../../identity/test-gate.js';
import { setup } from '../../plans/tests/helpers.js';
import { MemoryStore } from '../../plans/store.js';
import { DEFAULT_CONFIG, type AssistServiceConfig } from '../config.js';
import { Ledger } from '../ledger.js';
import { serverMock } from '../providers.js';
import { createAssistHttpServer } from '../service.js';

const identity = testIdentity();
const OWNER = 'owner-subject-1';
const ownerP = derivePrincipal(identity, OWNER);

const anyCtx = (): EngineeringContext => {
  for (const c of CASES) {
    const r = buildEngineeringContext(c.input());
    if (r.ok && diagnose(r.context).length) return r.context;
  }
  throw new Error('no case');
};
const body = () => ({
  contract: EXPLAIN_CONTRACT,
  locale: 'he',
  consent: { version: DEFAULT_CONFIG.consentVersion, accepted: true },
  context: anyCtx(),
});

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** The mock provider, counting calls, optionally throwing (a failed provider call). */
function countingMock(fail = false): AssistProvider & { calls: number } {
  const m = serverMock();
  const p = {
    id: m.id,
    model: m.model,
    live: m.live,
    pricing: m.pricing,
    calls: 0,
    complete: async (r: Parameters<AssistProvider['complete']>[0]) => {
      p.calls++;
      if (fail) throw new Error('scripted provider failure');
      return m.complete(r);
    },
  };
  return p as unknown as AssistProvider & { calls: number };
}

async function start(
  cfg: Partial<AssistServiceConfig>,
  provider: AssistProvider,
  extra: Record<string, unknown> = {},
) {
  const config = {
    ...structuredClone(DEFAULT_CONFIG),
    provider: { kind: 'mock' as const },
    ...cfg,
  };
  config.pilot = { principals: [ownerP] };
  const ledger = new Ledger(mkdtempSync(join(tmpdir(), 'assist-plans-')), config.retention);
  const server = createAssistHttpServer({
    config,
    identity,
    ledger,
    provider,
    env: { allowMock: true, credentialPresent: false },
    ...extra,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  const explain = async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/explain`, {
      method: 'POST',
      headers: { 'x-forwarded-user': OWNER, 'content-type': 'application/json' },
      body: JSON.stringify(body()),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { explain };
}

describe('metering disabled (default): behaviour unchanged', () => {
  it('same status and body with or without a (disabled) engine; engine journal stays empty', async () => {
    const off = await setup({}, { enabled: false });
    const a = await start({}, countingMock());
    const b = await start({}, countingMock(), { plans: off.engine });
    const ra = await a.explain();
    const rb = await b.explain();
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    const strip = (x: Record<string, any>) => ({
      ...x,
      accounting: { ...x.accounting, latencyMs: 0 },
    });
    expect(strip(rb.body)).toEqual(strip(ra.body));
    expect((off.store as MemoryStore).events).toEqual([]);
    expect((off.store as MemoryStore).appendCalls).toBe(0);
  });
  it('the legacy monthly token ceiling still applies when disabled, but not when metering is on', async () => {
    const tiny = { limits: { ...DEFAULT_CONFIG.limits, monthlyTokens: 10 } };
    const off = await setup({}, { enabled: false });
    expect(
      (await (await start(tiny, countingMock(), { plans: off.engine })).explain()).body,
    ).toMatchObject({
      error: 'token_ceiling',
    });
    const on = await setup();
    expect((await (await start(tiny, countingMock(), { plans: on.engine })).explain()).status).toBe(
      200,
    );
  });
});

describe('metering enabled', () => {
  it('success: admit, provider call, settle (credit consumed, reservation settled)', async () => {
    const { engine } = await setup();
    const p = countingMock();
    const s = await start({}, p, { plans: engine, newReqId: () => 'req-ok-1' });
    expect((await s.explain()).status).toBe(200);
    expect(p.calls).toBe(1);
    expect(engine.reservation('req-ok-1')?.state).toBe('settled');
    expect(engine.spendState().reservedMicro).toBe(0);
  });

  it('provider failure: reservation released, credit returned', async () => {
    const { engine } = await setup();
    let n = 0;
    const s = await start({}, countingMock(true), {
      plans: engine,
      newReqId: () => `req-f-${++n}`,
    });
    const r = await s.explain();
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(engine.reservation('req-f-1')?.state).toBe('released');
    expect(engine.spendState().reservedMicro).toBe(0);
    expect(engine.conservation(ownerP)).toMatchObject({ balance: 30, consumed: 0, reserved: 0 });
  });

  it('out of credits: 429 with code, params and he/en texts; provider not called', async () => {
    const { engine } = await setup({ plans: { free: { monthlyCredits: 1 } } });
    const p = countingMock();
    let n = 0;
    const s = await start({}, p, { plans: engine, newReqId: () => `req-c-${++n}` });
    expect((await s.explain()).status).toBe(200);
    const r = await s.explain();
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('credits_out_free');
    expect(r.body.limit.messageKey).toBe('limit.ai.credits_out_free');
    expect(r.body.message.en).toMatch(/free AI credits/);
    expect(r.body.message.he).toMatch(/קרדיטי/);
    expect(r.body.message.en).not.toMatch(/\{/);
    expect(p.calls).toBe(1);
  });

  it('store error: fail closed (503 system_unavailable), provider never called', async () => {
    const store = new MemoryStore();
    const { engine } = await setup({}, { store });
    store.failOnCall = 'always';
    const p = countingMock();
    const r = await (await start({}, p, { plans: engine })).explain();
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('system_unavailable');
    expect(r.body.message.en).toMatch(/not charged/);
    expect(p.calls).toBe(0);
  });

  it('duplicate request id with an open reservation, or a finished one, never reaches the provider', async () => {
    const { engine } = await setup();
    const p = countingMock();
    const a = await engine.admit({
      reqId: 'dup-1',
      principal: ownerP,
      mode: 'standard',
      inputTokens: 10,
    });
    expect(a.ok && a.metered && a.reservation.state).toBe('open');
    const s = await start({}, p, { plans: engine, newReqId: () => 'dup-1' });
    expect((await s.explain()).body.error).toBe('invalid_state'); // duplicate of an open one
    await engine.settle('dup-1', 0);
    expect((await s.explain()).body.error).toBe('invalid_state'); // settled one
    expect(p.calls).toBe(0);
  });

  it('spend guard: at the daily stop the AI is off (503 global_off), alert fired once, no provider call', async () => {
    const { engine, sink, cfg } = await setup();
    expect(cfg.spend).toMatchObject({
      dayAlertMicro: 1_500_000,
      dayStopMicro: 3_000_000,
      monthStopMicro: 60_000_000,
    });
    await engine.testSeedSpend({
      dayKey: '2026-11-19',
      monthKey: '2026-11',
      dayMicro: 2_999_000,
      monthMicro: 2_999_000,
    });
    const p = countingMock();
    const s = await start({}, p, { plans: engine });
    const r = await s.explain();
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('global_off');
    expect(r.body.message.he.length).toBeGreaterThan(0);
    expect(engine.spendState().state).toBe('auto_stopped');
    await s.explain();
    expect(sink.alerts.filter((a) => a.code === 'day_100')).toHaveLength(1);
    expect(p.calls).toBe(0);
  });
});
