/**
 * Sprint 11 (R1) REAL runtime support (QEMU + patches, pinned TbiBanks firmware: outputs
 * 4/16/27/25/32/33 swept in setup; loop copies GPIO34 -> GPIO4 and GPIO35 -> GPIO33).
 */
import { expect } from 'vitest';
import { EngineSession, type SolveSuccess } from '@tbi-lab/engine';
import { artifact, assertProvisioned } from '../harness/env.js';
import { ticketFor } from '../identity/test-gate.js';
import type { CreateSessionRequest } from '../host/protocol.js';
import type { HostSession } from '../host/session.js';
import { gone, waitEvent, waitState } from '../host/tests/support.js';
import { Circuit, open } from '../host/tests/r1-support.js';
import type { SessionHost } from '../host/host.js';

/** PSU1+ -> SW -> 1 kΩ -> [pad] -> 10 kΩ -> GND: a toggle switch drives an input-only pad. */
export function switchedInput(c: Circuit, gpio: 34 | 35): string {
  const sw = c.add('component.toggle_switch');
  const r1 = c.add('component.resistor');
  const r2 = c.add('component.resistor');
  c.ohms(r1, 1000).ohms(r2, 10_000);
  c.wire('PSU1.positive', `${sw}.a`).wire(`${sw}.b`, `${r1}.a`).wire(`${r1}.b`, `${r2}.a`);
  c.wire(`${r2}.b`, 'GND1.ref').pad(gpio, `${r1}.b`);
  return sw;
}

/** The bank-1 inputs TbiBanks reads (GPIO_IN1). */
export const BANKS_INPUTS = [34, 35, 36, 39] as const;

/**
 * Hold each of these inputs that the circuit leaves unwired LOW through 10 kΩ to GND. Runtime v5
 * refuses a read of an input with nothing wired to it (no defined level), and the pinned test
 * firmware reads inputs a slice does not use; this gives them a defined level and nothing else.
 */
export function tieFreeInputs(c: Circuit, gpios: readonly number[]): Circuit {
  for (const gpio of gpios) {
    if (c.attachments.some((a) => a.gpio === gpio)) continue;
    const r = c.add('component.resistor');
    c.ohms(r, 10_000).wire(`${r}.b`, 'GND1.ref').pad(gpio, `${r}.a`);
  }
  return c;
}

export function realRequest(c: Circuit): CreateSessionRequest {
  tieFreeInputs(c, BANKS_INPUTS);
  const fw = artifact('TbiBanks');
  return { ...c.request(fw.sha256), ticket: ticketFor(fw.sha256) };
}

export async function started(host: SessionHost, req: CreateSessionRequest): Promise<HostSession> {
  assertProvisioned();
  const s = open(host, req);
  expect(s.state).toBe('ready');
  expect(s.run()).toEqual({ ok: true });
  await waitEvent(
    s,
    () =>
      s.log
        .since(0)
        .filter((e) => e.type === 'serial')
        .map((e) => Buffer.from((e as { data: string }).data, 'base64').toString())
        .join('')
        .includes('TBI-BANKS-SWEEP-DONE'),
    90_000,
  );
  return s;
}

/** The engine's solve of `req` with these switch positions and pad modes. */
export function engineAt(
  req: CreateSessionRequest,
  closed: Record<string, boolean>,
  modes: Record<number, 'output-high' | 'output-low'>,
): SolveSuccess {
  const e = new EngineSession(req.circuit, { pins: req.attachments });
  let rev = req.circuit.projectRevision;
  for (const [id, v] of Object.entries(closed)) e.applyControl(id, { closed: v }, ++rev);
  for (const [g, m] of Object.entries(modes)) e.setPinMode(Number(g), m);
  const out = e.solve();
  if (!out.ok) throw new Error(JSON.stringify(out.error));
  return out;
}

export const close = (a: number, b: number, what: string) =>
  expect(Math.abs(a - b), what).toBeLessThanOrEqual(1e-9 * Math.max(1e-12, Math.abs(b)));

export async function stopped(s: HostSession) {
  const dir = s.privateDir;
  s.stop();
  await waitState(s, 'ended', 30_000);
  await s.done();
  expect(gone(dir)).toBe(true);
}
