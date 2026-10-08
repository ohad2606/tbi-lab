/**
 * Sprint 11 (R1): the Sprint 10 parts in ESP32 sessions on the Session Host, routine CI (the fake
 * runtime speaks the real bridge protocol: GPIO2 toggles every 5 ms of simulation time; GPIO18
 * follows the injected level of GPIO5). Each host outcome is compared with the engine solving the
 * same request with the same pad modes and controls (one engine, two hosts — ADR-008).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EngineSession, type SolveSuccess } from '@tbi-lab/engine';
import type { SessionHost } from '../host.js';
import { fakeHost, waitEvent, waitState } from './support.js';
import { Circuit, echoInput, flip, open, reference } from './r1-support.js';

const hosts: SessionHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.shutdown();
});

const close = (a: number, b: number) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-9 * Math.max(1e-12, Math.abs(b)));

describe('slice 1 — RGB LED driven by a running board', () => {
  it('firmware GPIO18 -> 220 Ω -> red: on and off with the pad, each equal to the engine reference', async () => {
    const { host, art } = fakeHost();
    hosts.push(host);
    const c = new Circuit().psu(3.3);
    const sw = echoInput(c);
    const led = c.add('component.rgb_led');
    const r = c.add('component.resistor');
    c.ohms(r, 220).wire(`${r}.b`, `${led}.red`).wire(`${led}.cathode`, 'GND1.ref');
    c.pad(18, `${r}.a`);
    const req = c.request(art.sha256);
    const s = open(host, req);
    expect(s.state).toBe('ready');
    s.run();
    await waitEvent(s, (e) => e.type === 'electrical');
    const red = (o: SolveSuccess) => o.components[led]!.currents!.red!;
    const rev = { seq: 0, rev: req.circuit.projectRevision };
    const lit = await flip(s, sw, true, rev, (o) => red(o) > 1e-3);
    const ref = reference(req, { 18: 'output-high' });
    // The switch is closed in the host too: refer to the same state.
    const refClosed = new EngineSession(req.circuit, { pins: req.attachments });
    refClosed.applyControl(sw, { closed: true }, rev.rev);
    refClosed.setPinMode(18, 'output-high');
    const want = refClosed.solve();
    if (!want.ok) throw new Error('reference failed');
    close(red(lit), want.components[led]!.currents!.red!);
    close(red(lit), ref.components[led]!.currents!.red!);
    expect(lit.components[led]!.currents!.green!).toBe(0);
    const dark = await flip(s, sw, false, rev, (o) => Math.abs(red(o)) < 1e-9);
    expect(dark.pins!.find((p) => p.gpio === 18)!.mode).toBe('output-low');
    s.stop();
    await waitState(s, 'ended');
  });
});
