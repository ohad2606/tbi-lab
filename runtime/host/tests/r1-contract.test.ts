/**
 * Sprint 11 (R1, ADR-010) — the Session Host contract for live part parameters and its safety
 * checks, and the frontend–host compatibility matrix (architecture §6.1, §6.2):
 * - `control.params` is bounded structurally (keys, kinds, count, bytes);
 * - when a command arrives, the host checks part identity, the allowed names for the component's
 *   type, kinds and ranges (the domain rule the engine applies again), and the per-session
 *   command rate; every refusal is explicit;
 * - command bodies are bounded; sessions stay private to their principal;
 * - a time-dependent part is refused from the engine's own property even if the catalog allowed it;
 * - S10 client messages are accepted unchanged; an S10 host refuses S11 live parameters (400).
 */
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { CATALOG, addComponent, addWire, createSnapshot, setParam } from '@tbi-lab/domain';
import { TEST_IDENTITY, principalFor, startTestGate } from '../../identity/test-gate.js';
import type { SessionHost } from '../host.js';
import { MAX_COMMAND_BYTES, createHttpServer } from '../http.js';
import {
  MAX_LIVE_PARAMS,
  MAX_LIVE_PARAMS_BYTES,
  validateCommand,
  validateCreate,
} from '../protocol.js';
import type { HostSession } from '../session.js';
import * as s10 from './fixtures/protocol-s10.js';
import { benchCircuit, createRequest, fakeHost, waitState } from './support.js';

const hosts: SessionHost[] = [];
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const h of hosts.splice(0)) await h.shutdown();
});

const mirror = (control: unknown, extra: Record<string, unknown> = {}) => ({
  category: 'mirror',
  seq: 1,
  projectRevision: 5,
  component: 'SW2',
  control,
  ...extra,
});

describe('control.params: structural bounds (validateCommand)', () => {
  it('accepts 1–8 keys of finite numbers, booleans or short strings', () => {
    expect(validateCommand(mirror({ params: { motion: true } })).ok).toBe(true);
    expect(validateCommand(mirror({ params: { illuminance: 120.5 } })).ok).toBe(true);
    expect(validateCommand(mirror({ params: { mode: 'abc' } })).ok).toBe(true);
    const eight = Object.fromEntries(
      Array.from({ length: MAX_LIVE_PARAMS }, (_, i) => [`k${i}`, i]),
    );
    expect(validateCommand(mirror({ params: eight })).ok).toBe(true);
  });

  it('refuses empty, too many keys, bad keys, bad values, nesting and oversized params (400)', () => {
    const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i]));
    for (const params of [
      {},
      nine,
      { Motion: true },
      { '1x': 1 },
      { 'a-b': 1 },
      { ['x'.repeat(33)]: 1 },
      { v: Number.NaN },
      { v: Infinity },
      { v: null },
      { v: { nested: 1 } },
      { v: [1] },
      { v: 's'.repeat(33) },
      [],
      'motion',
    ])
      expect(validateCommand(mirror({ params })), JSON.stringify(params)).toEqual({
        ok: false,
        error: 'control.params',
      });
    // Within the key and value limits but over the byte bound.
    const big = Object.fromEntries(
      Array.from({ length: MAX_LIVE_PARAMS }, (_, i) => [`k${i}${'x'.repeat(28)}`, 's'.repeat(32)]),
    );
    expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(MAX_LIVE_PARAMS_BYTES);
    expect(validateCommand(mirror({ params: big }))).toEqual({
      ok: false,
      error: 'control.params',
    });
    // Unknown control keys are still refused.
    expect(validateCommand(mirror({ motion: true })).ok).toBe(false);
  });
});

function open(host: SessionHost, req = createRequest(fakeHost().art.sha256)): HostSession {
  const r = host.create(req, principalFor());
  if (!r.ok) throw new Error(r.error);
  return r.value.session;
}

describe('when a command arrives: part identity, allowed names, kinds, ranges, rate (submit)', () => {
  it('controls that do not exist for the component type are refused: unsupported_control', async () => {
    const { host, art } = fakeHost();
    hosts.push(host);
    const s = open(host, createRequest(art.sha256));
    await waitState(s, 'ready');
    // Bench: R1 resistor, SW1 push button, SW2 toggle switch, PSU1.
    let seq = 0;
    const send = (component: string, control: object, rev: number) =>
      s.submit({ category: 'mirror', seq: ++seq, projectRevision: rev, component, control });
    expect(send('R1', { params: { resistance: 100 } }, 10)).toMatchObject({
      accepted: false,
      reason: 'unsupported_control',
    });
    expect(send('SW1', { closed: true }, 11)).toMatchObject({ reason: 'unsupported_control' });
    expect(send('SW2', { setpointVoltage: 5 }, 12)).toMatchObject({
      reason: 'unsupported_control',
    });
    expect(send('PSU1', { params: { setpointVoltage: 5 } }, 13)).toMatchObject({
      reason: 'unsupported_control',
    });
    expect(send('NOPE1', { closed: true }, 14)).toMatchObject({ reason: 'unknown_component' });
    // The existing controls still work.
    expect(send('SW2', { closed: true }, 15)).toMatchObject({ accepted: true });
    expect(send('PSU1', { setpointVoltage: 3 }, 16)).toMatchObject({ accepted: true });
    // Every refusal was logged explicitly as a rejected command.
    const rejected = s.log.since(0).filter((e) => e.type === 'command' && e.result === 'rejected');
    expect(rejected.length).toBe(5);
  });

  it('more commands per wall-clock second than the session allows: rate_limited', async () => {
    const { host, art } = fakeHost('normal', { maxCommandsPerSecond: 3 });
    hosts.push(host);
    const s = open(host, createRequest(art.sha256));
    await waitState(s, 'ready');
    const results = [1, 2, 3, 4].map((i) =>
      s.submit({
        category: 'transient',
        seq: i,
        action: i % 2 ? 'press' : 'release',
        component: 'SW1',
      }),
    );
    expect(results.map((r) => r.accepted)).toEqual([true, true, true, false]);
    expect(results[3]).toMatchObject({ reason: 'rate_limited' });
    expect(host.config.maxCommandsPerSecond).toBe(3);
  });

  it('the default rate (50/s) is far above ordinary use and is documented in the config', () => {
    const { host } = fakeHost();
    hosts.push(host);
    expect(host.config.maxCommandsPerSecond).toBe(50);
  });
});

describe('a time-dependent part is refused from the engine, whatever the catalog says (backstop)', () => {
  it('capacitor with the catalog flag removed: failed / electrical_error, reason time_dependent', async () => {
    const def = CATALOG['component.capacitor'] as { mcuRuntime?: false };
    const saved = def.mcuRuntime;
    delete def.mcuRuntime;
    try {
      const { host, art } = fakeHost();
      hosts.push(host);
      const { doc: base, attachments } = benchCircuit();
      const c = addComponent(base, 'component.capacitor', { x: 3000, y: 800 });
      if (!c.ok) throw new Error(c.error);
      let doc = c.doc;
      for (const [a, b] of [
        [`PSU1.positive`, `${c.id}.a`],
        [`${c.id}.b`, 'GND1.ref'],
      ] as const) {
        const [ac, at] = a.split('.') as [string, string];
        const [bc, bt] = b.split('.') as [string, string];
        const w = addWire(
          doc,
          { kind: 'terminal', component: ac, terminal: at },
          { kind: 'terminal', component: bc, terminal: bt },
        );
        if (!w.ok) throw new Error(w.error);
        doc = w.doc;
      }
      const s = open(
        host,
        createRequest(art.sha256, { circuit: createSnapshot(doc), attachments }),
      );
      expect(s.status()).toMatchObject({ state: 'failed', reason: 'electrical_error' });
      expect(s.status().detail).toEqual({
        code: 'unsupported_component',
        components: [c.id],
        detail: { reason: 'time_dependent' },
      });
      expect(s.status().runtime.pid).toBeNull(); // never started
    } finally {
      def.mcuRuntime = saved;
    }
  });
});

describe('HTTP: command body bound and session ownership for live parameters', () => {
  async function serve() {
    const { host, art } = fakeHost();
    hosts.push(host);
    const server: Server = createHttpServer(host, TEST_IDENTITY);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const target = { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
    const a = await startTestGate(target, TEST_IDENTITY, 'user-a');
    const b = await startTestGate(target, TEST_IDENTITY, 'user-b');
    closers.push(async () => {
      a.close();
      b.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    });
    return { art, a: a.base, b: b.base };
  }
  const post = (body: string, token: string) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body,
  });

  it('a command body over 8 KiB is refused (413); B cannot send live parameters to A’s session (404)', async () => {
    const { art, a, b } = await serve();
    const created = await fetch(`${a}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createRequest(art.sha256)),
    });
    const { sessionId, token } = (await created.json()) as { sessionId: string; token: string };
    const huge = JSON.stringify({
      ...mirror({ closed: true }),
      pad: 'x'.repeat(MAX_COMMAND_BYTES),
    });
    const r1 = await fetch(`${a}/sessions/${sessionId}/commands`, post(huge, token));
    expect(r1.status).toBe(413);
    await r1.body?.cancel();
    const live = JSON.stringify(mirror({ params: { motion: true } }));
    const r2 = await fetch(`${b}/sessions/${sessionId}/commands`, post(live, token));
    expect(r2.status).toBe(404);
    await r2.body?.cancel();
  });
});

describe('frontend–host compatibility (architecture §6.2)', () => {
  const fixture = (name: string) =>
    JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), 'utf8'))
      .request as Record<string, unknown>;
  const s10Commands = [
    mirror({ setpointVoltage: 3.3, currentLimit: 0.1 }, { component: 'PSU1' }),
    mirror({ outputEnabled: false }, { component: 'PSU1' }),
    mirror({ closed: true }),
    {
      category: 'mirror',
      seq: 2,
      atSimNs: '1000000',
      projectRevision: 7,
      component: 'SW2',
      control: { closed: false },
    },
    { category: 'transient', seq: 3, action: 'press', component: 'SW1' },
    { category: 'transient', seq: 4, action: 'release', component: 'SW1' },
  ];

  it('S10 frontend → S11 host: every S10 message (recorded create requests, all command shapes) is accepted unchanged', () => {
    for (const name of ['s10-bench-session.json', 's8-input-echo-session.json']) {
      // The recorded browser projections (the artifact and ticket are added when a run starts).
      const req = { ...fixture(name), artifact: { sha256: 'a'.repeat(64) }, ticket: 'x' };
      expect(s10.validateCreate(req).ok, `S10 ${name}`).toBe(true);
      expect(validateCreate(req), `S11 ${name}`).toEqual(s10.validateCreate(req));
    }
    for (const c of s10Commands) {
      expect(s10.validateCommand(c).ok, JSON.stringify(c)).toBe(true);
      expect(validateCommand(c), JSON.stringify(c)).toEqual(s10.validateCommand(c));
    }
    expect(s10.PROTOCOL).toBe('tbi-lab.session/2');
  });

  it('S11 frontend → S10 host: live parameters are refused explicitly (400 control), nothing else changes', () => {
    const live = mirror({ params: { motion: true } }, { component: 'PIR1' });
    expect(s10.validateCommand(live)).toEqual({ ok: false, error: 'control' });
    expect(validateCommand(live).ok).toBe(true);
    // The protocol string is unchanged, so S11 create requests reach the S10 host's own checks
    // (which refuse the new parts by name: unsupported_component, see models.test.ts).
    const { doc, attachments } = benchCircuit();
    const req = createRequest('a'.repeat(64), { circuit: createSnapshot(doc), attachments });
    expect(s10.validateCreate(req).ok).toBe(true);
    expect(setParam).toBeTypeOf('function');
  });
});
