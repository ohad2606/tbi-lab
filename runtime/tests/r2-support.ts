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
import { GATE_V2_CIRCUIT } from '../harness/closedLoop.js';
import { TEST_TICKET_KEY, principalFor, ticketFor } from '../identity/test-gate.js';
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
      ticketKey: TEST_TICKET_KEY,
      stallTimeoutMs: 5_000,
      ...over,
    }),
  );
}

/** A project document under construction (real domain edits, as the browser makes them). */
export class Doc {
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
  const { d, r1, r2 } = gateProject();
  return {
    protocol: PROTOCOL,
    artifact: { sha256: artifact(firmware).sha256 },
    board: 'board.esp32_devkitc_wroom32',
    circuit: createSnapshot(d.doc),
    ticket: ticketFor(artifact(firmware).sha256), // the default test principal (user-a)
    attachments: [
      { gpio: 2, component: r1, terminal: 'a' },
      { gpio: 5, component: r2, terminal: 'b' },
    ],
    ...extra,
  };
}

/**
 * The gate circuit as an editable project (the soak extends it); ids of the pad resistors.
 *
 *   GPIO2 -> R1 220 ohm -> red LED -> GND
 *   GPIO2 -> R2 1 Mohm -> GPIO5 <- R3 1 k <- VEXT (lab PSU, 100 mA limit);  GPIO5 -> R4 10 k -> GND
 *
 * Sprint 28 redesign (GATE_V2). Until Sprint 27 this was R2 = R3 = 10 k with VEXT stepping
 * 3.3 V <-> 0 V and no R4: with VEXT at 0 V and GPIO2 HIGH the supply had to SINK about 165 uA,
 * which a bench supply cannot (Sprint 22 `psu_sinking`, a correct rule), and GPIO5 sat at 1.65 V,
 * between V_IL and V_IH (Sprint 25 `sensor_level_undefined`). Now VEXT steps 3.3 V <-> 0.5 V and
 * GPIO5 is always defined and the supply always SOURCES (engine-checked in
 * runtime/host/tests/r2-gate-v2.test.ts):
 *   VEXT 0.5 V: GPIO5 = 0.454 V (GPIO2 LOW) / 0.457 V (HIGH) < V_IL 0.825 V; PSU sources 43-46 uA
 *   VEXT 3.3 V: GPIO5 = 2.997 V / 3.000 V > V_IH 2.475 V; PSU sources 0.30 mA
 * GPIO2 still loads GPIO5 (R2), so the pad coupling stays in the electrical stream. The R1
 * reference loop has the same circuit as its `gate-v2` variant (harness/closedLoop.ts).
 */
export const GATE_V2 = {
  r2Ohm: GATE_V2_CIRCUIT.r2Ohm,
  r3Ohm: GATE_V2_CIRCUIT.r3Ohm,
  r4Ohm: GATE_V2_CIRCUIT.r4Ohm,
  vextLowV: GATE_V2_CIRCUIT.initialV,
  vextHighV: GATE_V2_CIRCUIT.stimulus[0].setpointV,
} as const;

export function gateProject(): { d: Doc; r1: string; r2: string } {
  const d = new Doc();
  const r1 = d.add('component.resistor');
  const d1 = d.add('component.led');
  const r2 = d.add('component.resistor');
  const r3 = d.add('component.resistor');
  const r4 = d.add('component.resistor');
  d.wire(`${r1}.b`, `${d1}.anode`).wire(`${d1}.cathode`, 'GND1.ref');
  d.wire(`${r2}.a`, `${r1}.a`).wire(`${r3}.b`, `${r2}.b`);
  d.wire(`${r4}.a`, `${r2}.b`).wire(`${r4}.b`, 'GND1.ref');
  d.wire('PSU1.positive', `${r3}.a`).wire('PSU1.negative', 'GND1.ref');
  d.set(r1, 'resistance', { value: 220, unit: 'ohm' });
  d.set(r2, 'resistance', { value: GATE_V2.r2Ohm, unit: 'ohm' });
  d.set(r3, 'resistance', { value: GATE_V2.r3Ohm, unit: 'ohm' });
  d.set(r4, 'resistance', { value: GATE_V2.r4Ohm, unit: 'ohm' });
  d.set('PSU1', 'setpointVoltage', { value: GATE_V2.vextLowV, unit: 'volt' });
  d.set('PSU1', 'currentLimit', { value: 0.1, unit: 'ampere' });
  d.set('PSU1', 'outputEnabled', true);
  return { d, r1, r2 };
}

/** The VEXT stimulus as persistent mirrors (the browser would have persisted each value). */
export function gateMirrors(): MirrorCommand[] {
  return GATE_V2_CIRCUIT.stimulus.map(({ atNs: at, setpointV: v }, i) => ({
    category: 'mirror',
    seq: i + 1,
    atSimNs: String(at),
    projectRevision: 10 + i,
    component: 'PSU1',
    control: { setpointVoltage: v },
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
    ticket: ticketFor(artifact(firmware).sha256), // the default test principal (user-a)
    attachments: [{ gpio: 2, component: r1, terminal: 'a' }],
    ...extra,
  };
}

export function open(host: SessionHost, req: CreateSessionRequest): HostSession {
  const r = host.create(req, principalFor());
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
