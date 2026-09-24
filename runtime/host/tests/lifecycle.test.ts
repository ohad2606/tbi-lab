/**
 * Runtime R2 Session Host: lifecycle, commands and the co-located loop, with the fake runtime
 * (routine CI; the same paths run against real QEMU in runtime/tests/r2-*.runtime.test.ts).
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionHost } from '../host.js';
import type { SessionEvent } from '../protocol.js';
import type { HostSession } from '../session.js';
import {
  alive,
  createRequest,
  fakeHost,
  gone,
  serialText,
  waitEvent,
  waitState,
} from './support.js';

const hosts: SessionHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.shutdown()));
});

function start(mode = 'normal', over = {}) {
  const { host, art } = fakeHost(mode, over);
  hosts.push(host);
  return { host, art };
}

function created(host: SessionHost, sha: string, extra = {}): HostSession {
  const r = host.create(createRequest(sha, extra));
  if (!r.ok) throw new Error(r.error);
  return r.value.session;
}

const runtimeEvents = (s: HostSession) => s.log.since(0).filter((e) => e.type !== 'state');

describe('lifecycle', () => {
  it('create -> ready -> run -> running -> stop -> ended, with every resource released', async () => {
    const { host, art } = start();
    const s = created(host, art.sha256);
    expect(s.state).toBe('ready');
    const dir = s.privateDir;
    expect(gone(dir)).toBe(false);
    expect(s.run()).toEqual({ ok: true });
    expect(s.state).toBe('running');
    await waitEvent(s, (e) => e.type === 'gpio' && e.changes.some((c) => c.gpio === 2));
    expect(serialText(s)).toContain('BOOT 1');
    const pid = s.status().runtime.pid;
    expect(alive(pid)).toBe(true);
    s.stop();
    expect(s.state).toBe('stopping');
    s.stop(); // idempotent
    await waitState(s, 'ended');
    await s.done();
    expect(s.status()).toMatchObject({ state: 'ended', reason: 'stopped' });
    expect(alive(pid)).toBe(false);
    expect(gone(dir)).toBe(true);
    const states = s.log
      .since(0)
      .filter((e) => e.type === 'state')
      .map((e) => (e as { state: string }).state);
    expect(states).toEqual(['creating', 'ready', 'running', 'stopping', 'ended']);
  });

  it('run is only possible once: a clean reset is a new session', async () => {
    const { host, art } = start();
    const s = created(host, art.sha256);
    s.run();
    expect(s.run()).toMatchObject({ ok: false });
    await s.terminate('terminated');
    expect(s.run()).toMatchObject({ ok: false });
  });

  it('terminate is idempotent in every state and reports ended/terminated', async () => {
    const { host, art } = start();
    const ready = created(host, art.sha256);
    await ready.terminate('terminated');
    await ready.terminate('terminated');
    expect(ready.status()).toMatchObject({ state: 'ended', reason: 'terminated' });
    const running = created(host, art.sha256);
    running.run();
    await waitEvent(running, (e) => e.type === 'gpio');
    const pid = running.status().runtime.pid;
    await running.terminate('terminated');
    await running.terminate('terminated');
    expect(running.status()).toMatchObject({ state: 'ended', reason: 'terminated' });
    expect(alive(pid)).toBe(false);
    expect(gone(running.privateDir)).toBe(true);
  });

  it('the immutable artifact is never written; each session writes only its private copy', async () => {
    const { host, art } = start();
    const before = createHash('sha256').update(readFileSync(art.path)).digest('hex');
    for (let i = 0; i < 3; i++) {
      const s = created(host, art.sha256);
      s.run();
      await waitEvent(s, (e) => e.type === 'serial');
      expect(serialText(s)).toContain('BOOT 1'); // a fresh copy every time
      await s.terminate('terminated');
    }
    expect(createHash('sha256').update(readFileSync(art.path)).digest('hex')).toBe(before);
  });
});

describe('commands and the co-located loop', () => {
  it('a scheduled persistent mirror applies at its tick; feedback is synchronous, off the grid', async () => {
    const { host, art } = start();
    const s = created(host, art.sha256);
    const sw =
      s.status() &&
      createRequest(art.sha256).circuit.components.find(
        (c) => c.type === 'component.toggle_switch',
      )!.id;
    expect(
      host.command(s, {
        category: 'mirror',
        seq: 1,
        atSimNs: '20000000',
        projectRevision: 99,
        component: sw,
        control: { closed: true },
      }),
    ).toMatchObject({ ok: true, value: { accepted: true } });
    s.run();
    const ack = (await waitEvent(
      s,
      (e) => e.type === 'command' && e.commandSeq === 1,
    )) as SessionEvent & { type: 'command' };
    expect(ack).toMatchObject({ result: 'applied', simNs: '20000000' });
    // GPIO5 is injected HIGH at the tick; the "firmware" echoes it on GPIO18 at the SAME time + 8 ns.
    await waitEvent(
      s,
      (e) => e.type === 'gpio' && e.changes.some((c) => c.gpio === 18 && c.level === 1),
    );
    expect(serialText(s)).toContain('IN5=1');
    const elec = s.log
      .since(0)
      .filter((e) => e.type === 'electrical')
      .map((e) => (e as { outcome: { pins?: { gpio: number; current: number }[] } }).outcome);
    const on = elec.find((o) => (o.pins?.find((p) => p.gpio === 18)?.current ?? 0) > 1e-3);
    expect(on, 'GPIO18 drives the 1 k load after the echo').toBeTruthy();
    await s.terminate('terminated');
  });

  it('transient press/release never needs a project revision and changes the input', async () => {
    const { host, art } = start();
    const s = created(host, art.sha256);
    const pb = createRequest(art.sha256).circuit.components.find(
      (c) => c.type === 'component.push_button',
    )!.id;
    s.run();
    await waitEvent(s, (e) => e.type === 'serial');
    host.command(s, { category: 'transient', seq: 1, action: 'press', component: pb });
    await waitEvent(
      s,
      (e) => e.type === 'gpio' && e.changes.some((c) => c.gpio === 18 && c.level === 1),
    );
    host.command(s, { category: 'transient', seq: 2, action: 'release', component: pb });
    await waitEvent(
      s,
      (e) => e.type === 'gpio' && e.changes.some((c) => c.gpio === 18 && c.level === 0),
    );
    await s.terminate('terminated');
  });

  it('ordering: duplicates, late, out-of-order and full queues are rejected, never reordered', async () => {
    const { host, art } = start('normal', { maxQueuedCommands: 2 });
    const s = created(host, art.sha256);
    const pb = createRequest(art.sha256).circuit.components.find(
      (c) => c.type === 'component.push_button',
    )!.id;
    const cmd = (seq: number, atSimNs?: string) =>
      host.command(s, {
        category: 'transient',
        seq,
        action: 'press',
        component: pb,
        ...(atSimNs ? { atSimNs } : {}),
      });
    expect(cmd(5, '50000000')).toMatchObject({ value: { accepted: true } });
    expect(cmd(5, '60000000')).toMatchObject({ value: { accepted: false, reason: 'duplicate' } });
    expect(cmd(4, '60000000')).toMatchObject({ value: { accepted: false, reason: 'duplicate' } });
    expect(cmd(6, '40000000')).toMatchObject({
      value: { accepted: false, reason: 'out_of_order' },
    });
    expect(cmd(7, '70000000')).toMatchObject({ value: { accepted: true } });
    expect(cmd(8, '80000000')).toMatchObject({ value: { accepted: false, reason: 'queue_full' } });
    expect(
      host.command(s, { category: 'transient', seq: 9, action: 'press', component: 'Nope1' }),
    ).toMatchObject({
      value: { accepted: false, reason: 'unknown_component' },
    });
    s.run();
    await waitEvent(s, (e) => e.type === 'command' && e.commandSeq === 7 && e.result === 'applied');
    expect(cmd(10, '1000')).toMatchObject({ value: { accepted: false, reason: 'late' } });
    await s.terminate('terminated');
    expect(cmd(11)).toMatchObject({ value: { accepted: false, reason: 'not_running' } });
    // Every command is acknowledged once, in client order among the applied ones.
    const applied = s.log
      .since(0)
      .filter((e) => e.type === 'command' && e.result === 'applied')
      .map((e) => (e as { commandSeq: number }).commandSeq);
    expect(applied).toEqual([5, 7]);
  });

  it('a mirror the runtime cannot apply fails the session (stale), never the project', async () => {
    const { host, art } = start();
    const s = created(host, art.sha256);
    s.run();
    await waitEvent(s, (e) => e.type === 'serial');
    host.command(s, {
      category: 'mirror',
      seq: 1,
      projectRevision: 5,
      component: 'PSU1',
      control: { closed: true },
    });
    await waitState(s, 'failed');
    expect(s.status()).toMatchObject({ state: 'failed', reason: 'mirror_failed' });
    expect(gone(s.privateDir)).toBe(true);
  });

  it('a mirror value the engine refuses fails the session (mirror_failed)', async () => {
    const { host, art } = start();
    const s = created(host, art.sha256);
    s.run();
    await waitEvent(s, (e) => e.type === 'serial');
    host.command(s, {
      category: 'mirror',
      seq: 1,
      projectRevision: 5,
      component: 'PSU1',
      control: { currentLimit: -1 },
    });
    await waitState(s, 'failed');
    expect(s.status().reason).toBe('mirror_failed');
  });

  it('a mirror that leaves no valid operating point fails closed (electrical_error), naming why', async () => {
    const { host, art } = start();
    const r = host.create(createRequest(art.sha256, {}, { parallelPsu: true }));
    if (!r.ok) throw new Error(r.error);
    const s = r.value.session;
    s.run();
    await waitEvent(s, (e) => e.type === 'serial');
    const psu2 = createRequest(art.sha256, {}, { parallelPsu: true }).circuit.components.filter(
      (c) => c.type === 'instrument.lab_psu',
    )[1]!.id;
    host.command(s, {
      category: 'mirror',
      seq: 1,
      projectRevision: 5,
      component: psu2,
      control: { outputEnabled: true },
    });
    await waitState(s, 'failed');
    expect(s.status()).toMatchObject({
      reason: 'electrical_error',
      detail: { code: 'psu_parallel' },
    });
    expect(gone(s.privateDir)).toBe(true);
  });

  it('mirror revisions: strictly increasing, gaps allowed, stale/duplicate never mutate, applied revision reported', async () => {
    const { host, art } = start();
    const s = created(host, art.sha256);
    const sw = createRequest(art.sha256).circuit.components.find(
      (c) => c.type === 'component.toggle_switch',
    )!.id;
    const pb = createRequest(art.sha256).circuit.components.find(
      (c) => c.type === 'component.push_button',
    )!.id;
    const mirror = (
      seq: number,
      projectRevision: number,
      atSimNs: string,
      component: string,
      control: Record<string, unknown>,
    ) => host.command(s, { category: 'mirror', seq, atSimNs, projectRevision, component, control });
    const snapshot = createRequest(art.sha256).circuit.projectRevision; // 1
    expect(s.status().revisions).toEqual({ snapshot, accepted: snapshot, applied: snapshot });
    // The snapshot already contains its own revision; anything at or below it is not newer.
    expect(mirror(1, snapshot, '20000000', sw, { closed: false })).toMatchObject({
      value: { accepted: false, reason: 'duplicate_revision' },
    });
    expect(mirror(2, snapshot - 1, '20000000', sw, { closed: false })).toMatchObject({
      value: { accepted: false, reason: 'stale_revision' },
    });
    // Accepted: the answer says which revision the session has accepted and which it applied.
    expect(mirror(3, 5, '20000000', sw, { closed: true })).toMatchObject({
      value: { accepted: true, revisions: { snapshot, accepted: 5, applied: snapshot } },
    });
    // Retry of the same persisted edit: same seq -> duplicate; new seq -> duplicate_revision.
    expect(mirror(3, 5, '21000000', sw, { closed: true })).toMatchObject({
      value: { accepted: false, reason: 'duplicate' },
    });
    expect(mirror(4, 5, '21000000', sw, { closed: false })).toMatchObject({
      value: { accepted: false, reason: 'duplicate_revision', revisions: { accepted: 5 } },
    });
    // An older revision arriving late is rejected, whatever it carries.
    expect(mirror(5, 3, '22000000', 'PSU1', { setpointVoltage: 1 })).toMatchObject({
      value: { accepted: false, reason: 'stale_revision' },
    });
    // Gaps are allowed: the browser's revision is the authority.
    expect(mirror(6, 9, '30000000', 'PSU1', { setpointVoltage: 3 })).toMatchObject({
      value: { accepted: true, revisions: { accepted: 9 } },
    });
    // A mirror refused for another reason does not consume its revision.
    expect(mirror(7, 12, '25000000', 'PSU1', { setpointVoltage: 3.3 })).toMatchObject({
      value: { accepted: false, reason: 'out_of_order', revisions: { accepted: 9 } },
    });
    expect(mirror(8, 12, '40000000', 'PSU1', { setpointVoltage: 3.3 })).toMatchObject({
      value: { accepted: true, revisions: { accepted: 12, applied: snapshot } },
    });
    // Transient commands carry no revision (refused by validation) and do not touch revisions.
    expect(
      host.command(s, {
        category: 'transient',
        seq: 9,
        action: 'press',
        component: pb,
        projectRevision: 13,
      }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      host.command(s, { category: 'transient', seq: 10, action: 'press', component: pb }),
    ).toMatchObject({ value: { accepted: true } });
    expect(s.status().revisions).toEqual({ snapshot, accepted: 12, applied: snapshot });

    s.run();
    await waitEvent(s, (e) => e.type === 'command' && e.commandSeq === 10);
    expect(s.status().revisions).toEqual({ snapshot, accepted: 12, applied: 12 });
    const acks = s.log.since(0).filter((e) => e.type === 'command') as (SessionEvent & {
      type: 'command';
    })[];
    // Exactly the accepted commands were applied, once each, in client order; mirrors carry
    // their revision, transients none.
    expect(
      acks.filter((a) => a.result === 'applied').map((a) => [a.commandSeq, a.projectRevision]),
    ).toEqual([
      [3, 5],
      [6, 9],
      [8, 12],
      [10, undefined], // client order: the untimed transient queued behind the timed mirrors
    ]);
    for (const a of acks.filter((x) => x.commandSeq !== 9 && x.commandSeq !== 10))
      expect(a.projectRevision, `seq ${a.commandSeq}`).toBeTypeOf('number');
    // The runtime represents revision 12: switch closed (rev 5), PSU at 3.3 V (rev 12). The
    // duplicate (closed: false) and the stale 1 V setpoint never reached the engine.
    await waitEvent(s, (e) => e.type === 'electrical' && BigInt(e.simNs!) >= 40_000_000n);
    const last = s.log
      .since(0)
      .filter((e) => e.type === 'electrical')
      .at(-1) as {
      outcome: {
        appliedRevision: number;
        components: Record<string, { closed?: boolean; voltage: number }>;
      };
    };
    expect(last.outcome.appliedRevision).toBe(12);
    expect(last.outcome.components[sw]!.closed).toBe(true);
    expect(last.outcome.components.PSU1!.voltage).toBeCloseTo(3.3, 12);
    const volts = s.log
      .since(0)
      .filter((e) => e.type === 'electrical')
      .map((e) => (e as typeof last).outcome.components.PSU1!.voltage);
    expect(volts.some((v) => Math.abs(v - 1) < 1e-9)).toBe(false);
    await s.terminate('terminated');
  });

  it('identical inputs give an identical runtime event stream (repeated runs)', async () => {
    const { host, art } = start();
    const sw = createRequest(art.sha256).circuit.components.find(
      (c) => c.type === 'component.toggle_switch',
    )!.id;
    const hashes = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const s = created(host, art.sha256);
      host.command(s, {
        category: 'mirror',
        seq: 1,
        atSimNs: '12000000',
        projectRevision: 2,
        component: sw,
        control: { closed: true },
      });
      host.command(s, {
        category: 'mirror',
        seq: 2,
        atSimNs: '31000000',
        projectRevision: 3,
        component: sw,
        control: { closed: false },
      });
      s.run();
      await waitEvent(s, (e) => e.type === 'gpio' && BigInt(e.simNs!) >= 60_000_000n);
      s.stop();
      await waitState(s, 'ended');
      const upTo = runtimeEvents(s).filter((e) => BigInt(e.simNs ?? '0') <= 60_000_000n);
      hashes.add(createHash('sha256').update(JSON.stringify(upTo)).digest('hex'));
    }
    expect(hashes.size).toBe(1);
  });
});
