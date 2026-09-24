/**
 * Runtime R2 heavy acceptance support: the Session Host on the REAL provisioned runtime
 * (QEMU + patches 0001-0005) with the pinned R1 firmware artifacts. Circuits are real domain
 * projects, snapshotted exactly as the browser does.
 */
import { join } from 'node:path';
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
import { QEMU, RUNTIME_HOME, artifact } from '../harness/env.js';
import { defaultConfig, type HostConfig } from '../host/config.js';
import { SessionHost } from '../host/host.js';
import {
  PROTOCOL,
  type CreateSessionRequest,
  type MirrorCommand,
  type SessionEvent,
} from '../host/protocol.js';
import type { HostSession } from '../host/session.js';

export function realHost(over: Partial<HostConfig> = {}): SessionHost {
  return new SessionHost(
    defaultConfig({
      qemu: QEMU,
      artifactsDir: join(RUNTIME_HOME, 'artifacts'),
      stallTimeoutMs: 5_000,
      ...over,
    }),
  );
}

class Doc {
  doc: ProjectDocument = createProject({
    projectId: 'prj_r2',
    deviceId: 'd',
    name: 'R2',
    appVersion: '0',
  });
  private x = 0;
  add(type: ComponentTypeId) {
    this.x += 200;
    const r = addComponent(this.doc, type, { x: this.x, y: 400 });
    if (!r.ok) throw new Error(r.error);
    this.doc = r.doc;
    return r.id;
  }
  wire(a: string, b: string) {
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
  set(id: string, key: string, v: ParamValue) {
    const r = setParam(this.doc, id, key, v);
    if (!r.ok) throw new Error(r.error);
    this.doc = r.doc;
    return this;
  }
}

/**
 * The R1 release-gate circuit as a project: GPIO2 -> R1 220 -> D1 (LED) -> GND;
 * GPIO2 -> R2 10 k -> GPIO5 <- R3 10 k <- PSU1 (VEXT, 0 V, 100 mA, output on).
 */
export function gateRequest(
  firmware: string,
  extra: Partial<CreateSessionRequest> = {},
): CreateSessionRequest {
  const d = new Doc();
  const r1 = d.add('component.resistor');
  const d1 = d.add('component.led');
  const r2 = d.add('component.resistor');
  const r3 = d.add('component.resistor');
  d.wire(`${r1}.b`, `${d1}.anode`).wire(`${d1}.cathode`, 'GND1.ref');
  d.wire(`${r2}.a`, `${r1}.a`).wire(`${r3}.b`, `${r2}.b`);
  d.wire('PSU1.positive', `${r3}.a`).wire('PSU1.negative', 'GND1.ref');
  d.set(r1, 'resistance', { value: 220, unit: 'ohm' });
  d.set(r2, 'resistance', { value: 10_000, unit: 'ohm' });
  d.set(r3, 'resistance', { value: 10_000, unit: 'ohm' });
  d.set('PSU1', 'setpointVoltage', { value: 0, unit: 'volt' });
  d.set('PSU1', 'currentLimit', { value: 0.1, unit: 'ampere' });
  d.set('PSU1', 'outputEnabled', true);
  return {
    protocol: PROTOCOL,
    artifact: { sha256: artifact(firmware).sha256 },
    board: 'board.esp32_devkitc_wroom32',
    circuit: createSnapshot(d.doc),
    attachments: [
      { gpio: 2, component: r1, terminal: 'a' },
      { gpio: 5, component: r2, terminal: 'b' },
    ],
    ...extra,
  };
}

/** The R1 VEXT stimulus as persistent mirrors (the browser would have persisted each value). */
export function gateMirrors(): MirrorCommand[] {
  return [
    [13_000_000_000n, 3.3],
    [13_600_000_000n, 0],
    [14_200_000_000n, 3.3],
    [14_900_000_000n, 0],
  ].map(([at, v], i) => ({
    category: 'mirror',
    seq: i + 1,
    atSimNs: String(at),
    projectRevision: 10 + i,
    component: 'PSU1',
    control: { setpointVoltage: v as number },
  }));
}

/** A single pad load: GPIO2 -> R1 1 k -> GND (for firmware that only needs GPIO2). */
export function loadRequest(
  firmware: string,
  extra: Partial<CreateSessionRequest> = {},
): CreateSessionRequest {
  const d = new Doc();
  const r1 = d.add('component.resistor');
  d.wire(`${r1}.b`, 'GND1.ref').wire('PSU1.negative', 'GND1.ref');
  d.set(r1, 'resistance', { value: 1000, unit: 'ohm' });
  return {
    protocol: PROTOCOL,
    artifact: { sha256: artifact(firmware).sha256 },
    board: 'board.esp32_devkitc_wroom32',
    circuit: createSnapshot(d.doc),
    attachments: [{ gpio: 2, component: r1, terminal: 'a' }],
    ...extra,
  };
}

export function open(host: SessionHost, req: CreateSessionRequest): HostSession {
  const r = host.create(req);
  if (!r.ok) throw new Error(r.error);
  return r.value.session;
}

/** Runtime events (everything except lifecycle states and receipt-time rejections) up to `untilNs`. */
export function runtimeEvents(s: HostSession, untilNs: bigint): Omit<SessionEvent, 'seq'>[] {
  return s.log
    .since(0)
    .filter((e) => e.type !== 'state' && e.simNs !== null && BigInt(e.simNs) <= untilNs)
    .map(({ seq: _seq, ...rest }) => rest);
}
