/**
 * Sprint 11 (R1) Session Host test support: circuits built through the domain edits with pad
 * attachments, sessions, and the engine reference for the same request (routine CI and the real
 * runtime suite share it).
 */
import { expect } from 'vitest';
import {
  addComponent,
  addWire,
  createProject,
  createSnapshot,
  setParam,
  type ComponentTypeId,
  type ParamValue,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { EngineSession, type SolveSuccess } from '@tbi-lab/engine';
import { principalFor } from '../../identity/test-gate.js';
import type { SessionHost } from '../host.js';
import type { CreateSessionRequest } from '../protocol.js';
import type { HostSession } from '../session.js';
import { createRequest, waitEvent } from './support.js';

/** A circuit built through the domain edits, plus pad attachments `gpio -> component.terminal`. */
export class Circuit {
  doc: ProjectDocument = createProject({
    projectId: 'prj_r1',
    deviceId: 'd',
    name: 'R1',
    appVersion: '0',
  });
  attachments: CreateSessionRequest['attachments'] = [];
  private x = 0;
  add(type: ComponentTypeId): string {
    this.x += 200;
    const r = addComponent(this.doc, type, { x: this.x, y: 400 });
    if (!r.ok) throw new Error(r.error);
    this.doc = r.doc;
    return r.id;
  }
  wire(a: string, b: string): this {
    const [ac, at] = a.split('.') as [string, string];
    const [bc, bt] = b.split('.') as [string, string];
    const r = addWire(
      this.doc,
      { kind: 'terminal', component: ac, terminal: at },
      { kind: 'terminal', component: bc, terminal: bt },
    );
    if (!r.ok) throw new Error(`${a}-${b}: ${r.error}`);
    this.doc = r.doc;
    return this;
  }
  set(id: string, key: string, v: ParamValue): this {
    const r = setParam(this.doc, id, key, v);
    if (!r.ok) throw new Error(`${id}.${key}: ${r.error}`);
    this.doc = r.doc;
    return this;
  }
  ohms(id: string, v: number): this {
    return this.set(id, 'resistance', { value: v, unit: 'ohm' });
  }
  psu(volts: number): this {
    return this.set('PSU1', 'setpointVoltage', { value: volts, unit: 'volt' })
      .set('PSU1', 'outputEnabled', true)
      .wire('PSU1.negative', 'GND1.ref');
  }
  pad(gpio: number, at: string): this {
    const [component, terminal] = at.split('.') as [string, string];
    this.attachments.push({ gpio, component, terminal });
    return this;
  }
  request(sha: string): CreateSessionRequest {
    return createRequest(sha, { circuit: createSnapshot(this.doc), attachments: this.attachments });
  }
}

export function open(host: SessionHost, req: CreateSessionRequest): HostSession {
  const r = host.create(req, principalFor());
  if (!r.ok) throw new Error(r.error);
  return r.value.session;
}

export const outcomes = (s: HostSession) =>
  s.log
    .since(0)
    .filter((e) => e.type === 'electrical')
    .map((e) => (e as unknown as { outcome: SolveSuccess }).outcome);

/** The engine's own solve of `req` with the given pad modes (the reference). */
export function reference(
  req: CreateSessionRequest,
  modes: Record<number, 'output-high' | 'output-low' | 'input'>,
): SolveSuccess {
  const s = new EngineSession(req.circuit, { pins: req.attachments });
  for (const [gpio, mode] of Object.entries(modes)) s.setPinMode(Number(gpio), mode);
  const out = s.solve();
  if (!out.ok) throw new Error(JSON.stringify(out.error));
  return out;
}

/**
 * The fake firmware copies GPIO5 to GPIO18. A toggle switch (a mirrored, persisted edit) drives
 * GPIO5 through a divider from the 3.3 V supply, so GPIO18 holds a level for as long as the switch
 * does: PSU1+ -> SW -> 1 kΩ -> [GPIO5] -> 10 kΩ -> GND.
 */
export function echoInput(c: Circuit): string {
  const sw = c.add('component.toggle_switch');
  const r1 = c.add('component.resistor');
  const r2 = c.add('component.resistor');
  c.ohms(r1, 1000).ohms(r2, 10_000);
  c.wire('PSU1.positive', `${sw}.a`).wire(`${sw}.b`, `${r1}.a`).wire(`${r1}.b`, `${r2}.a`);
  c.wire(`${r2}.b`, 'GND1.ref').pad(5, `${r1}.b`);
  return sw;
}

/** Mirror the toggle switch at the next revision and wait until `pred` holds for an outcome. */
export async function flip(
  s: HostSession,
  sw: string,
  closed: boolean,
  rev: { seq: number; rev: number },
  pred: (o: SolveSuccess) => boolean,
  timeoutMs = 10_000,
): Promise<SolveSuccess> {
  const at = s.log.lastSeq;
  expect(
    s.submit({
      category: 'mirror',
      seq: ++rev.seq,
      projectRevision: ++rev.rev,
      component: sw,
      control: { closed },
    }),
  ).toMatchObject({ accepted: true });
  const e = await waitEvent(
    s,
    (x) =>
      x.seq > at &&
      x.type === 'electrical' &&
      pred((x as unknown as { outcome: SolveSuccess }).outcome),
    timeoutMs,
  );
  return (e as unknown as { outcome: SolveSuccess }).outcome;
}
