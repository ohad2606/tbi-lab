/**
 * Sprint 10 runtime sync, real QEMU: the realism benchmark (esp32-bench: the input echo plus a
 * yellow LED behind a 1N4148 and a green LED, fed from the 3.3 V supply) runs on the Session Host
 * with the pinned TbiBanks firmware (GPIO34 copied to GPIO4). The request is exactly what the app
 * sends (fixtures/s10-bench-session.json). Proves: the yellow and green model cards are accepted
 * by the runtime, their operating point is the engine's, the firmware reads the switch and drives
 * the red LED, and Stop releases everything.
 */
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { EngineSession, type SolveSuccess } from '@tbi-lab/engine';
import { artifact, assertProvisioned } from '../harness/env.js';
import { ticketFor } from '../identity/test-gate.js';
import { alive, gone, waitEvent, waitState } from '../host/tests/support.js';
import { PROTOCOL, type CreateSessionRequest, type SessionEvent } from '../host/protocol.js';
import { open, realHost } from './r2-support.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/s10-bench-session.json', import.meta.url), 'utf8'),
) as { request: Omit<CreateSessionRequest, 'artifact' | 'ticket'> };

const host = realHost();
afterAll(() => host.shutdown());

const gpio4 = (level: 0 | 1) => (e: SessionEvent) =>
  e.type === 'gpio' && e.changes.some((c) => c.gpio === 4 && c.level === level);
const lastElectrical = (s: ReturnType<typeof open>) =>
  (
    s.log
      .since(0)
      .filter((e) => e.type === 'electrical')
      .at(-1) as unknown as { outcome: SolveSuccess }
  ).outcome;

describe('esp32-bench on the real runtime (Sprint 10 LED cards)', () => {
  it('accepts red, yellow and green cards; firmware echoes the switch and the button; Stop cleans up', async () => {
    assertProvisioned();
    const fw = artifact('TbiBanks');
    const req: CreateSessionRequest = {
      ...fixture.request,
      protocol: PROTOCOL,
      artifact: { sha256: fw.sha256 },
      ticket: ticketFor(fw.sha256),
    };
    const s = open(host, req);
    expect(s.state).toBe('ready');
    const dir = s.privateDir;
    expect(s.run()).toEqual({ ok: true });
    await waitEvent(s, (e) => e.type === 'electrical', 60_000);

    // Yellow (D3, behind the 1N4148 D2) and green (D4) run off the supply: their currents are the
    // engine's own operating point for this circuit (idle firmware: pads as inputs).
    const ref = new EngineSession(req.circuit, { pins: req.attachments }).solve();
    if (!ref.ok) throw new Error(JSON.stringify(ref.error));
    const out = lastElectrical(s);
    expect(out.ok).toBe(true);
    for (const id of ['D2', 'D3', 'D4'])
      expect(out.components[id]!.current, id).toBeCloseTo(ref.components[id]!.current!, 9);
    expect(out.components.D3!.current!).toBeGreaterThan(5e-3);
    expect(out.components.D4!.current!).toBeGreaterThan(10e-3);

    // The toggle switch (a mirror of the persisted edit): GPIO34 high -> GPIO4 high -> D1 lit.
    let seq = 1;
    expect(
      s.submit({
        category: 'mirror',
        seq: seq++,
        projectRevision: 2,
        component: 'SW1',
        control: { closed: true },
      }),
    ).toMatchObject({ accepted: true });
    await waitEvent(s, gpio4(1), 60_000);
    await waitEvent(
      s,
      (e) =>
        e.type === 'electrical' &&
        ((e as unknown as { outcome: SolveSuccess }).outcome.components.D1?.current ?? 0) > 5e-3,
      30_000,
    );
    expect(
      s.submit({
        category: 'mirror',
        seq: seq++,
        projectRevision: 3,
        component: 'SW1',
        control: { closed: false },
      }),
    ).toMatchObject({ accepted: true });
    const offAt = s.log.since(0).length;
    await waitEvent(s, (e) => gpio4(0)(e) && e.seq > offAt, 60_000);

    // The push button (transient): held -> GPIO4 high; released -> low.
    expect(
      s.submit({ category: 'transient', seq: seq++, action: 'press', component: 'SW2' }),
    ).toMatchObject({ accepted: true });
    const pressAt = s.log.since(0).length;
    await waitEvent(s, (e) => gpio4(1)(e) && e.seq > pressAt, 60_000);
    expect(
      s.submit({ category: 'transient', seq, action: 'release', component: 'SW2' }),
    ).toMatchObject({ accepted: true });
    const releaseAt = s.log.since(0).length;
    await waitEvent(s, (e) => gpio4(0)(e) && e.seq > releaseAt, 60_000);

    // Yellow and green stayed lit throughout (they do not depend on the firmware).
    expect(lastElectrical(s).components.D3!.current!).toBeGreaterThan(5e-3);
    expect(lastElectrical(s).components.D4!.current!).toBeGreaterThan(10e-3);

    const pid = s.status().runtime.pid;
    s.stop();
    await waitState(s, 'ended', 30_000);
    await s.done();
    expect(s.status()).toMatchObject({ state: 'ended', reason: 'stopped' });
    expect(alive(pid)).toBe(false);
    expect(gone(dir)).toBe(true);
  });
});
