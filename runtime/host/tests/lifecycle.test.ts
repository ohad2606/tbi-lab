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
